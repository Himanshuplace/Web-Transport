# AI Context — Read This First

**Single-file briefing for AI agents.** If you read only one doc, read this one.
Deeper detail: `architecture.md`, `codebase-map.md`, `business-logic.md`,
`change-impact-guide.md`, `developer-onboarding.md`. The pre-existing root
`ARCHITECTURE.md` + `README.md` are also accurate and worth consulting.

## What the system is
A **learning project** demonstrating **WebTransport (HTTP/3 + QUIC)**. A single
Node.js process simulates concurrent **T20 cricket matches** and streams them
live to a vanilla-JS browser dashboard, deliberately using all three WebTransport
channels. No DB, no queue, no external API, no auth, no clustering. All state is
in-memory. Domain data is hard-coded.

## Architecture in one breath
`index.js` boots: generate ECDSA-P256 self-signed cert → `MatchManager.start()`
(creates matches + a 4s `setInterval` ticker each) → `createTransportServer`
(awaits native `quicheLoaded`, binds UDP :4433) → Express on TCP :3000 (static
client + `/api/server-info` + `/api/health`). Browser fetches the cert
fingerprint, pins it via `serverCertificateHashes`, connects over WebTransport,
and receives a stream of cricket events.

```
Domain (pure)        Orchestration            Transport            Browser
engine.js ─ match.js → match-manager.js → transport-server.js → transport-client.js
                          │  timer + subscribers + broadcast        → store.js (observer)
                          │                                          → ui.js (DOM)
                          └─ encode()/protocol.js  ──(codegen)──▶ client/js/protocol.js
```

## The three WebTransport channels (the core lesson)
| Channel | Used for | Reliability |
|---|---|---|
| Datagram | `SCORE_UPDATE` heartbeat | unreliable, unordered |
| Unidirectional stream (new per ball; also the on-connect `MATCH_LIST`) | `BALL_EVENT`, `MATCH_STATUS`, bootstrap `MATCH_LIST` | reliable, ordered per stream, no HOL blocking |
| Bidirectional stream (one per session) | client `SUBSCRIBE/UNSUBSCRIBE/GET_MATCHES` → `MATCH_STATE/ERROR` | reliable, ordered |

## Message protocol
Envelope: `{ type, payload, ts }` as JSON/UTF-8. `MSG` constants live in
`server/protocol.js`; `client/js/protocol.js` is **generated from it** (codegen — see constraints below).
Types: `MATCH_LIST, MATCH_STATE, BALL_EVENT, SCORE_UPDATE, MATCH_STATUS, ERROR`
(S→C); `SUBSCRIBE, UNSUBSCRIBE, GET_MATCHES` (C→S).

## Main modules (where to look)
- **`server/cricket/engine.js`** — pure, stateless ball simulator. Weighted
  random outcome from `BASE_WEIGHTS` + situational adjustments. Commentary
  templates. Safe to unit test in isolation.
- **`server/cricket/match.js`** — T20 state machine. `deliverBall()` +
  `_applyBallResult()` own ALL bookkeeping. `toJSON()` shape = the UI contract.
- **`server/cricket/teams.js`** — 6 teams × 11 players, venues, `getMatchups()`
  (deep-clones teams per match).
- **`server/match-manager.js`** — timer loop (`_tick`), subscriber registry,
  broadcast helpers (`_broadcastStream` = new unidirectional stream per
  subscriber; `_broadcastDatagram`). On completion a match is auto-replaced
  (`_replaceMatch` after `POST_MATCH_BREAK_MS`) and an updated `MATCH_LIST` is
  pushed to all sessions (`_broadcastMatchListToAll`).
- **`server/transport-server.js`** — WT session lifecycle + command stream
  dispatcher (server-side API).
- **`server/cert.js`** — OpenSSL ECDSA-P256 cert, SHA-256 fingerprint, ≤14-day.
- **Client:** `transport-client.js` (connect/reconnect/readers),
  `store.js` (observer store, full-state replacement on each ball),
  `ui.js` (pure render), `app.js` (wiring + dispatcher).

## Critical constraints (do not break)
1. **Cert MUST be ECDSA P-256 and valid ≤14 days.** quiche silently rejects RSA
   and >14-day certs → opaque `Opening handshake failed`.
2. **Pass `Buffer` (not `ArrayBuffer`) for the fingerprint** in Node clients; the
   browser uses `Uint8Array.buffer`. (`test/wt-client.js:103` documents the trap.)
3. **Edit `server/protocol.js` only** — `client/js/protocol.js` is generated from
   it (`npm run gen:protocol`, auto-run on start). Never hand-edit the client copy.
4. **`match.toJSON()` field names are a UI contract** — renaming breaks rendering
   with no error.
5. **Client uses globals + ordered `<script>` tags** (index.html). Don't reorder.
6. **Startup is sequential and must `await createTransportServer`** (waits on
   `quicheLoaded`).
7. **Browser support: Chrome/Edge 97+ only.** UDP :4433 must be reachable
   (Codespaces does not forward UDP — use the Node test client there).

## Common workflows
- Run: `npm install && npm start` → http://localhost:3000 (Chrome/Edge).
- Headless verify: `node test/verify-cert.js`, `node test/wt-client.js`.
- Speed up sim: `BALL_INTERVAL_MS` in `config.js`.
- Tune realism: `BASE_WEIGHTS` in `engine.js`.
- Add message type: `server/protocol.js` (client copy regenerates) → emit in
  `match-manager.js` → handle in `app.js` → store mutation + `ui.js`.

## Coding patterns in use
- ESM modules; pure domain layer; observer/pub-sub store; reconnect with
  exponential backoff (1s→30s); full-state-on-every-event (no diffing);
  heavily-commented teaching style (match it).

---

## Technical Debt & Risks (ranked)

> This is a teaching demo; "debt" is judged against the implied goal of a
> realistic, somewhat production-shaped streaming server.

### Critical
1. **[RESOLVED 2026-06-21]** Initial `MATCH_LIST` was sent as an *unreliable*
   datagram; if dropped or arriving before the client's datagram reader attached,
   the client never auto-subscribed ⇒ permanently empty UI. Now sent over a
   reliable unidirectional stream in `transport-server.js` `_handleSession`
   (client dispatcher is channel-agnostic, so no client change was needed).
2. **No authentication / authorization / origin checks** on the WebTransport
   endpoint. Any client can connect and subscribe. Acceptable for a demo, unsafe
   for deployment.

### High
3. **Stream-per-ball-per-subscriber fan-out** (`_sendViaStream`). Cost scales as
   `matches × subscribers` new QUIC streams every 4s — does not scale to large
   audiences. Needs batching/stream reuse for 100×+ load.
4. **No backpressure handling.** Writers are obtained and written without
   checking `desiredSize`/`ready`. A slow client can accumulate unbounded
   pending writes.
5. **`_tick` runs on `setInterval` without awaiting itself.** Under load, ticks
   overlap; message ordering across ticks is not guaranteed (state mutation is
   still atomic because it precedes any `await`).
6. **No persistence.** A restart loses all in-progress matches and starts fresh
   random fixtures. (Matches no longer go idle — a completed match is now
   auto-replaced by a fresh one as of 2026-06-21.)

### Medium
7. **Duplicated protocol definitions — [RESOLVED 2026-06-21].** `client/js/protocol.js`
   is now generated from `server/protocol.js` by `scripts/gen-client-protocol.mjs`
   (auto-run via `prestart`/`predev`), so the two cannot drift. (This had already
   bitten: a stray `COMMENTARY` constant existed only on the client.) Do not
   hand-edit the generated client copy.
8. **Cross-platform fragility in `cert.js`** — [partially addressed 2026-06-21]
   the cache path now uses `os.tmpdir()` and the cmd.exe-breaking `2>/dev/null`
   was removed. Still requires the `openssl` binary on PATH (absent on bare
   Windows; the Linux devcontainer installs it and remains the supported runtime),
   and `-subj "/CN=..."` can still be mangled by MSYS/Git-flavored openssl.
9. **Full scorecard re-sent every ball** (`BALL_EVENT.scorecard =
   match.toJSON()`) — simple but bandwidth-heavy; JSON over UTF-8 (no
   MessagePack/protobuf) compounds it.
10. **`_handleCommandStream` accesses `msg.payload.matchId` without validating**
    payload shape (only JSON-parse + size are guarded). A malformed but valid-JSON
    command can throw inside the handler (caught, but noisy).
11. **No tests.** `test/` contains diagnostics/clients, not assertions. The pure
    `engine.js`/`match.js` are the easiest, highest-value unit-test targets and
    are completely uncovered.

### Low
12. **Death-overs threshold (`>=16`) vs comment (17–20)** mismatch.
13. **Dead condition** `isWicket && !isNoBall` (outcomes are mutually exclusive).
14. **`MAX_CONCURRENT_MATCHES=4` unreachable** with 6 teams (max 3 pairs).
15. **Predictable QUIC `secret`** (`'cricket-wt-secret-' + process.pid`).
16. **Unused dependency** `selfsigned`.
17. **`bowler.economy`** computed from completed overs only (ignores balls in the
    current over) — minor stat inaccuracy.

### Security note (XSS) — [RESOLVED 2026-06-21]
`renderMatchTabs` now passes `team1`/`team2`/`score` through `escapeHtml` like the
rest of `ui.js` (`statusDot` stays raw — it is intentional markup). Previously
unescaped; only safe because team names are hard-coded server data.

---

## How Future AI Sessions Should Work

### 1. How to safely make changes
- **Read the contract first.** Before editing anything touching the wire, read
  `server/protocol.js` and `match.toJSON()`. Most breakages here are silent.
- **Change the protocol in one place.** Edit `server/protocol.js`; the client
  copy is generated (`npm run gen:protocol`, auto-run on start). Never hand-edit
  `client/js/protocol.js`.
- **Preserve the teaching style.** Files have dense header comments explaining
  *why*; keep that density — it's a deliverable, not noise.
- **Don't reorder client `<script>` tags** or convert to modules casually; the
  client relies on global load order.
- **Verify after changes** with `node test/verify-cert.js` then
  `node test/wt-client.js` (no browser needed). For UI, open in Chrome/Edge.
- Per repo `CLAUDE.md`: run `graphify update .` after modifying code.

### 2. Files to check first (in order)
1. `docs/ai-context.md` (this file) → `docs/change-impact-guide.md`
2. `server/config.js` (knobs) → `server/protocol.js` (contract)
3. `server/cricket/match.js` `toJSON()` (UI contract) + `engine.js` (logic)
4. `server/match-manager.js` (broadcast) + `server/transport-server.js` (sessions)
5. Client: `app.js` (dispatcher) → `store.js` → `ui.js` → `transport-client.js`

### 3. Areas requiring extra caution
- The **on-connect `MATCH_LIST`** bootstrap — now a reliable unidirectional
  stream; keep it reliable, it is the client's only auto-subscribe trigger.
- **`_tick` timing / overlap** and the **stream-per-ball fan-out** (scaling).
- **Match auto-replacement** (`_replaceMatch` → `_broadcastMatchListToAll`): the
  client reconciles on every `MATCH_LIST` (`store.setMatchList` prunes + re-points
  the active tab; `app.js` unsubscribes removed matches). Keep those in step.
- **Cert generation** (ECDSA-P256, ≤14 days, Buffer-not-ArrayBuffer).
- **Strike rotation** and **`_applyBallResult`** bookkeeping (easy to desync).
- **`_selectNextBowler`** (a team lacking bowlers can stall).

### 4. Testing strategy (recommended, currently absent)
- **Unit:** `engine.js` (weight clamping, outcome distribution with seeded RNG),
  `match.js` (`_isInningsOver`, `_calculateResult`, strike rotation, extras,
  over rollover, bowler eligibility) — pure, no mocks needed.
- **Integration:** `MatchManager` subscribe/broadcast with a fake session object
  (stub `createUnidirectionalStream`, `datagrams.writable`).
- **E2E:** drive `test/wt-client.js` against a live server; assert it receives
  `MATCH_LIST` → `MATCH_STATE` → `BALL_EVENT` for a subscribed match.
- **Boundary:** datagram size near MTU; 0 subscribers; match end exactly on
  target/last ball/last wicket; tied match; reconnect mid-match.

### 5. Common architectural patterns (follow these)
- Pure domain layer (no I/O in `cricket/`).
- Observer/pub-sub store on the client.
- Encode/decode isolated in `protocol.js`.
- Transport vs orchestration vs domain separation — keep `cricket/` ignorant of
  WebTransport, keep `transport-server.js` ignorant of cricket rules.

### 6. Anti-patterns to avoid
- Putting cricket logic in `transport-server.js`, or WT/session logic in
  `cricket/`.
- Hand-editing the generated `client/js/protocol.js` (edit `server/protocol.js`
  and regenerate).
- Renaming `toJSON()` fields without updating `ui.js`/`store.js`.
- Sending bootstrap/critical data over datagrams (unreliable).
- Adding blocking/`await`-heavy work inside `_tick` without considering overlap.
- Introducing a bundler/framework on the client without reason (the zero-runtime-
  dependency vanilla approach is intentional; the only build step is the
  `protocol.js` codegen).
