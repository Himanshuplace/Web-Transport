# Architecture

> Cricket Live Score Engine — a learning-grade but production-styled demo of
> **WebTransport (HTTP/3 + QUIC)** for real-time browser streaming.

## 1. System Overview

The system is a **single Node.js process** that:

1. Simulates up to 4 concurrent **T20 cricket matches**, advancing one ball every 4 seconds.
2. Serves a static browser dashboard over plain **HTTP (TCP :3000)** via Express.
3. Streams live match data to browsers over **WebTransport (UDP/QUIC :4433)**.

There is **no database, no message queue, no external API, no auth, and no
multi-process clustering**. All state lives in memory inside the `MatchManager`.
The "data" (teams, players, venues) is hard-coded in `server/cricket/teams.js`.

The browser is a **zero-dependency, no-framework** vanilla-JS app: a tiny
observer-pattern store, a WebTransport client with reconnect, and pure DOM
render functions.

### Why WebTransport (the whole point of the project)

The project deliberately exercises all three WebTransport channels to show when
each is appropriate:

| Channel | Direction | Carries | Reliability | Why this channel |
|---|---|---|---|---|
| **Datagrams** | Server → Client | `SCORE_UPDATE` | Unreliable, unordered | Cheap heartbeat; losing one is fine — another arrives in ~4s |
| **Unidirectional streams** | Server → Client | `BALL_EVENT`, `MATCH_STATUS`, on-connect `MATCH_LIST` | Reliable, ordered per stream | One stream per ball ⇒ no head-of-line blocking; bootstrap `MATCH_LIST` must be reliable |
| **Bidirectional stream** | Client ↔ Server | `SUBSCRIBE`/`UNSUBSCRIBE`/`GET_MATCHES` → `MATCH_STATE`/`ERROR` | Reliable, ordered | Request/reply command channel, one long-lived stream per session |

## 2. Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Node.js ≥ 18 (devcontainer uses 22) | ESM (`"type": "module"`) |
| WebTransport server | `@fails-components/webtransport` + `...-transport-http3-quiche` | Loads a native C++ libquiche addon asynchronously (`quicheLoaded`) |
| HTTP server | `express` ^4 | Static files + 2 JSON endpoints |
| TLS cert | OpenSSL via `child_process.execSync` | ECDSA **P-256** self-signed, ≤14-day validity |
| IDs | `uuid` v4 | Match IDs |
| Wire format | JSON over UTF-8 (`TextEncoder`/`TextDecoder`) | `{ type, payload, ts }` envelope |
| Browser | Vanilla JS, no build step | 5 `<script>` tags in dependency order |
| Dev | `nodemon`, devcontainer (Debian + Node 22) | `selfsigned` is a listed dep but **unused** (RSA-only; replaced by OpenSSL) |

## 3. System Architecture Diagram

```mermaid
graph TB
    subgraph Server["Single Node.js Process"]
        IDX["index.js<br/>entry / bootstrap"]
        CERT["cert.js<br/>ECDSA P-256 self-signed cert"]
        CFG["config.js<br/>ports, timings, limits"]
        MM["match-manager.js<br/>matches + subscriptions + broadcast"]
        TS["transport-server.js<br/>HTTP/3 WebTransport server"]
        EXP["express app<br/>static + /api/server-info + /api/health"]
        subgraph Domain["cricket/ (pure domain logic)"]
            MATCH["match.js<br/>T20 state machine"]
            ENG["engine.js<br/>weighted-random ball sim"]
            TEAMS["teams.js<br/>6 teams, venues, matchups"]
        end
    end

    subgraph Browser["Browser (Chrome/Edge 97+)"]
        APP["app.js<br/>wiring / dispatcher"]
        TC["transport-client.js<br/>WT client + reconnect"]
        STORE["store.js<br/>observer state store"]
        UI["ui.js<br/>pure DOM render"]
        PROTO["protocol.js<br/>MSG + encode/decode"]
    end

    IDX --> CERT & MM & TS & EXP
    MM --> MATCH --> ENG
    MM --> TEAMS
    TS -. UDP/QUIC :4433 .-> TC
    EXP -. TCP :3000 .-> TC
    TC --> APP --> STORE --> UI
    APP --> PROTO
```

## 4. Request / Connection Lifecycle

### 4a. Page load + WebTransport handshake

```mermaid
sequenceDiagram
    participant B as Browser
    participant E as Express :3000
    participant W as WT Server :4433
    participant M as MatchManager

    B->>E: GET / (index.html, CSS, JS)
    E-->>B: static files
    B->>E: GET /api/server-info
    E-->>B: { wtPort, wtPath, certHash, matches }
    B->>W: new WebTransport(url, {serverCertificateHashes:[sha-256]})
    W-->>B: session.ready (TLS 1.3 + HTTP/3 CONNECT)
    W->>M: (on connect) getMatchList()
    W-->>B: MATCH_LIST (reliable unidirectional stream)
    B->>W: open bidi stream
    B->>W: SUBSCRIBE { matchId } (per match)
    W->>M: subscribe(matchId, session)
    M-->>B: MATCH_STATE (full scorecard) on bidi stream
```

### 4b. Ball delivery broadcast (every 4s per match)

```mermaid
sequenceDiagram
    participant T as setInterval (BALL_INTERVAL_MS)
    participant M as MatchManager._tick
    participant MA as Match.deliverBall
    participant EN as engine.simulateBall
    participant S as Subscriber sessions
    participant B as Browser

    T->>M: _tick(matchId)
    M->>MA: deliverBall()
    MA->>EN: simulateBall(state, batsman, bowler, fielders)
    EN-->>MA: BallResult {type, runs, wicket, commentary}
    MA-->>M: { ballResult, inningsEnded, matchEnded }
    M->>S: BALL_EVENT via NEW unidirectional stream (per subscriber)
    M->>S: SCORE_UPDATE via datagram (per subscriber)
    S-->>B: streams + datagram
    B->>B: store.applyBallEvent / applyScoreUpdate → emit → ui.render*
```

## 5. Service Interactions & Boundaries

There is exactly one service (the process), but it has clear internal modules:

- **Transport boundary** (`transport-server.js`) — knows about WebTransport
  sessions, streams, datagrams. Talks to `MatchManager` only through
  `subscribe / unsubscribe / removeSession / getMatchList`.
- **Orchestration boundary** (`match-manager.js`) — owns the timer loop,
  subscriber registry, and all broadcast/encoding decisions. Knows about
  WebTransport session APIs (creates streams, gets datagram writers).
- **Domain boundary** (`cricket/`) — `Match` + `engine` + `teams` are **pure**:
  no I/O, no network, no knowledge of WebTransport. `engine.js` is fully
  stateless; `Match` is a self-contained state machine.
- **Protocol boundary** (`protocol.js`, generated for the client) — the only shared
  contract between server and browser. The two copies must stay in sync
  (manually — there is no shared module/import across the network boundary).

## 6. Ports & Endpoints

| Port | Proto | Purpose |
|---|---|---|
| 3000 | TCP/HTTP | Static dashboard + `GET /api/server-info` + `GET /api/health` |
| 4433 | UDP/QUIC | WebTransport at path `/cricket` |

`GET /api/server-info` → `{ wtPort: 4433, wtPath: '/cricket', certHash: <hex>, matches: [...] }`
`GET /api/health` → `{ status, matchCount, uptime, timestamp }`

## 7. Key Cross-Cutting Concerns

- **Certificate pinning** — self-signed ECDSA P-256 cert; SHA-256 fingerprint is
  served via HTTP and pinned in the browser's `serverCertificateHashes`. ECDSA is
  mandatory (quiche's verifier rejects RSA); validity must be ≤14 days.
- **Reconnect** — client uses exponential backoff (1s → 30s cap) and re-subscribes
  to all `_subscriptions` after reconnect.
- **Latency tracking** — every message carries `ts` (server `Date.now()`); the
  client logs when `Date.now() - ts > 200ms`.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` → `manager.stop()` clears all timers.

See `codebase-map.md` for per-file detail, `business-logic.md` for the cricket
rules, and `ai-context.md` for the condensed single-file briefing.
