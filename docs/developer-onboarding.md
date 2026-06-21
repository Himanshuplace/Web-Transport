# Developer Onboarding

## 1. Prerequisites

- **Node.js ≥ 18** (devcontainer uses 22).
- **OpenSSL** on PATH (used by `cert.js` to generate the ECDSA P-256 cert).
- A **Chromium-based browser** (Chrome/Edge 97+). Firefox/Safari lack WebTransport.
- Platform note: the repo was developed cross-platform. `cert.js` shells out to
  `openssl ... 2>/dev/null` and caches to `/tmp/...`, which assume a POSIX-ish
  shell. On Windows, run under **Git Bash / WSL** or ensure `openssl` is on PATH
  and a `/tmp` exists, otherwise cert generation may fail. (See change-impact
  guide for the exact lines.)

## 2. Run locally

```bash
npm install
npm start                 # node server/index.js
# open http://localhost:3000 in Chrome/Edge
```

Dev with auto-restart:

```bash
npm run dev               # nodemon server/index.js
```

Faster simulation for testing (edit `server/config.js`):

```js
export const BALL_INTERVAL_MS = 1000;   // 1s per ball instead of 4s
```

### Successful startup log
```
[cert]  ... Generated new ECDSA P-256 certificate ...
[manager] Match created: ... ; [manager] 3 matches running
[transport] QUIC/HTTP3 engine loaded
[transport] WebTransport server listening on UDP :4433
[http]  Dashboard → http://localhost:3000
  Server ready.
```

## 3. Verifying without a browser

These work even where browser UDP is blocked (e.g. Codespaces):

```bash
node test/verify-cert.js          # cert fingerprint + connection diagnostic
node test/wt-client.js            # terminal ball-by-ball (60s default)
node test/wt-client.js --duration=120 --verbose
curl http://localhost:3000/api/server-info
curl http://localhost:3000/api/health
```

VS Code launch configs (`.vscode/launch.json`): **Start Server**, **Test Client
(60s)**, **Verify Cert**, and a **Server + Test Client** compound.

## 4. Debugging guide

### Server (log prefixes tell you the failing step)
- `[cert]` — OpenSSL missing / `/tmp` not writable. Fix: install openssl, delete
  `/tmp/cricket-wt-cert.json`.
- `[transport]` — quiche native addon failed to load, or UDP :4433 in use.
- `[http]` — TCP :3000 in use (`EADDRINUSE` → process exits with instructions).

### Browser DevTools (console globals)
```js
window._store.getState()                       // full client state
window._store.getMatchList()                   // derived live summaries
window._wt.isConnected                          // WebTransport up?
window._wt.subscribe('paste-match-uuid')        // manual subscribe
window._store.emit('matchUpdated', window._store.getActiveMatchId())  // force render
```
Network tab → filter `webtransport`. `chrome://webrtc-internals` for QUIC stats.
`chrome://net-export` for packet capture.

### Common errors
| Symptom | Cause | Fix |
|---|---|---|
| `Opening handshake failed` | RSA cert (stale cache) or `ArrayBuffer` passed instead of `Buffer` | delete cert cache + restart; pass `Buffer` |
| `WebTransport is not defined` | Firefox/Safari/old Chrome | use Chrome/Edge 97+ |
| Scores stuck at initial value | client never subscribed (no `MATCH_LIST` received), or `_matches` empty | reload; check the on-connect `MATCH_LIST` stream + bidi SUBSCRIBE were sent |
| Cert verification failed | browser has old fingerprint | hard-refresh (Ctrl+Shift+R) / clear site data |
| Tabs show `[object Object]` | team is object not string | already normalised by `store.getMatchList()` |

The pre-existing `ARCHITECTURE.md` has an extended debugging playbook (sections
11–12) — keep it as the deep reference.

## 5. Common workflows / how to extend

| Task | Where |
|---|---|
| Change ball frequency | `config.js` `BALL_INTERVAL_MS` |
| Tune match character | `engine.js` `BASE_WEIGHTS` (e.g. `WICKET: 50`) |
| Add a team | `teams.js` `TEAMS` (keep 11 players, valid roles, battingPos) |
| Add a message type | add to `server/protocol.js` (client copy auto-generated) → emit in `match-manager.js` → handle in `app.js` switch → optional store mutation + `ui.js` render |
| Add auth | `transport-server.js` `_handleSession` (gate before `getMatchList`/subscribe) |
| Real data instead of sim | replace `MatchManager.start()` source |
| Binary protocol | `server/protocol.js` `encode`/`decode` (client copy regenerates) |

## 6. "Deployment"

There is **no CI/CD, no Dockerfile, no infra-as-code, no cloud config** in the
repo. "Deployment" today = run `npm start` on a host. For anything real you must
add (see ai-context.md → risks): a CA-signed cert loader (replace
`getOrCreateCert`), a process manager, UDP :4433 reachability, and origin/auth
controls. The `.devcontainer` is for Codespaces development, **not** production.

## 7. Project conventions
- ESM everywhere (`import`/`export`, `"type":"module"`).
- Heavy explanatory header comments on every file — **match that density** when
  editing; they are part of the project's teaching purpose.
- Client uses **globals**, not modules — script order in `index.html` is the
  dependency graph. Do not reorder.
- `client/js/protocol.js` is **generated** from `server/protocol.js` by
  `scripts/gen-client-protocol.mjs` (runs automatically on `npm start` / `npm run
  dev`, or `npm run gen:protocol`). Edit the server file; never hand-edit the
  client copy.
- `_camelCase` prefix denotes "private" methods/fields by convention.
