# Cricket Live Score Engine — WebTransport

A production-quality live cricket scoring system demonstrating **WebTransport** (HTTP/3 + QUIC) for real-time browser communication.

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000 in Chrome or Edge
```

> **Requires Chromium-based browser** — WebTransport is not yet supported in Firefox or Safari.

---

## What This Demonstrates

### Three WebTransport channels — all used simultaneously

| Channel | Direction | Used for | Why |
|---------|-----------|---------|-----|
| **Datagrams** | Server → Client | `SCORE_UPDATE` heartbeat | Small, fast, lossy — fine if one is dropped |
| **Unidirectional streams** | Server → Client | `BALL_EVENT` + full scorecard | Reliable, ordered, one stream per ball |
| **Bidirectional streams** | Both | `SUBSCRIBE` / `MATCH_STATE` | Request/reply command channel |

### WebTransport vs WebSocket vs SSE

```
WebSocket  — TCP, single ordered channel, no multiplexing
SSE        — HTTP/1.1, server-push only, no binary, no back-pressure
WebTransport — HTTP/3/QUIC, multiplexed streams + datagrams, bidirectional
```

---

## Architecture

```
Browser
├── app.js              — Bootstrapper, wires everything together
├── transport-client.js — WebTransport client + reconnect logic
├── store.js            — Observer-pattern state store (mini-Redux)
└── ui.js               — Pure DOM render functions

Server (Node.js)
├── index.js            — Entry point
├── transport-server.js — HTTP/3 WebTransport server
├── match-manager.js    — Orchestrates matches + broadcasts to subscribers
├── protocol.js         — encode() / decode() helpers + MSG constants
├── cert.js             — Self-signed TLS cert + SHA-256 fingerprint
├── config.js           — All tunable constants
└── cricket/
    ├── engine.js       — Weighted-random ball simulation
    ├── match.js        — T20 state machine (overs, wickets, run rates)
    └── teams.js        — 6 teams × 11 players
```

---

## How the Certificate Works

WebTransport requires **TLS 1.3**. In development we use a self-signed cert:

1. Server generates a cert valid for ≤ 14 days (spec limit for self-signed)
2. Server exposes `GET /api/server-info` → returns the SHA-256 fingerprint
3. Browser fetches fingerprint, passes it to `new WebTransport(url, { serverCertificateHashes: [...] })`
4. Browser accepts the self-signed cert because the fingerprint matches

In production: replace `getOrCreateCert()` with your CA-signed certificate loader.

---

## Debugging

### Server side

```bash
# Faster ball delivery for testing (change config.js)
BALL_INTERVAL_MS=500 npm start

# Watch ball-by-ball in console — add to match-manager.js _tick():
console.log('[tick]', match.title, inn.runs + '/' + inn.wickets)
```

### Browser DevTools

```javascript
// Full current state
window._store.getState()

// Inspect a specific match
window._store.getMatch(window._store.getActiveMatchId())

// Manually subscribe to a match
window._wt.subscribe('paste-match-uuid-here')

// Measure message latency (ts is stamped by server)
// — every message logged by transport-client.js shows latency if > 200ms
```

### Chrome QUIC/HTTP3 inspection

- `chrome://webrtc-internals` → QUIC statistics
- DevTools → Network → filter by "webtransport"
- `chrome://net-export` for packet-level capture

---

## File-by-File Learning Path

Start reading in this order for the clearest learning arc:

1. **`server/config.js`** — understand the system parameters
2. **`server/protocol.js`** — the wire format shared by server and browser
3. **`server/cricket/engine.js`** — the ball simulation (weighted random)
4. **`server/cricket/match.js`** — the state machine (how cricket works in code)
5. **`server/transport-server.js`** — HTTP/3 WebTransport session handling
6. **`server/match-manager.js`** — how broadcasts work
7. **`client/js/transport-client.js`** — browser-side WebTransport
8. **`client/js/app.js`** — how messages flow to the UI

---

## Extending the System

| Task | Where to start |
|------|---------------|
| Add player skill ratings | `server/cricket/teams.js` → `server/cricket/engine.js` |
| Add real scores from a cricket API | Replace `MatchManager.start()` in `match-manager.js` |
| Add binary protocol (MessagePack) | `server/protocol.js` encode/decode functions |
| Add authentication | `server/transport-server.js` `_handleSession()` |
| Add more UI widgets | `client/js/ui.js` + `client/js/app.js` observers |
| Add WebTransport over HTTP/2 fallback | `Http3Server` → `HttpServer` in `transport-server.js` |
