# Cricket Score Engine — Architecture & Debug Guide

A complete map of how every file fits together, how data flows from simulation
to browser, and exactly where to look when something breaks.

---

## Table of Contents

1. [Big Picture — One-Page Overview](#1-big-picture)
2. [Technology: Why WebTransport](#2-why-webtransport)
3. [Three Transport Channels Explained](#3-three-transport-channels)
4. [File Map — What Every File Does](#4-file-map)
5. [Data Flow — Ball to Browser (Step-by-Step)](#5-data-flow)
6. [Server Startup Sequence](#6-server-startup-sequence)
7. [Client Startup Sequence](#7-client-startup-sequence)
8. [State Management (Client)](#8-state-management)
9. [Certificate System Deep Dive](#9-certificate-system)
10. [The Cricket Engine](#10-the-cricket-engine)
11. [Debugging Playbook](#11-debugging-playbook)
12. [Common Errors & Fixes](#12-common-errors--fixes)
13. [How to Extend the System](#13-how-to-extend)

---

## 1. Big Picture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SERVER  (Node.js)                        │
│                                                                 │
│  ┌──────────────┐   ball every   ┌───────────────────────────┐  │
│  │ Cricket Engine│   4 seconds   │     Match Manager         │  │
│  │ engine.js     │ ──────────►   │     match-manager.js      │  │
│  │ match.js      │               │ tracks subscribers,       │  │
│  │ teams.js      │               │ broadcasts via WT         │  │
│  └──────────────┘               └──────────┬────────────────┘  │
│                                             │                   │
│  ┌──────────────────────────────────────────▼────────────────┐  │
│  │           WebTransport HTTP/3 Server  (UDP :4433)         │  │
│  │           transport-server.js                             │  │
│  │   • BALL_EVENT  → new unidirectional stream (reliable)    │  │
│  │   • SCORE_UPDATE → datagram          (unreliable/fast)    │  │
│  │   • MATCH_STATE  → bidi stream reply (on SUBSCRIBE)       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           Express HTTP Server  (TCP :3000)               │   │
│  │           index.js                                        │   │
│  │   GET /           → serves client/index.html              │   │
│  │   GET /api/server-info → cert fingerprint + match list   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                         │  UDP/QUIC :4433  │  TCP :3000
                         ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                       BROWSER  (Chrome/Edge)                    │
│                                                                 │
│  transport-client.js ─── decodes messages                       │
│       │                                                         │
│       ▼                                                         │
│  store.js  ─── holds match state ─── fires events              │
│       │                                                         │
│       ▼                                                         │
│  ui.js  ─── renders scorecard, tabs, commentary, over log       │
│                                                                 │
│  app.js  ─── wires everything together (event plumbing)         │
└─────────────────────────────────────────────────────────────────┘
```

**Two servers, one process:**
- Port **3000** (TCP/HTTP) — serves HTML/CSS/JS and the cert fingerprint API
- Port **4433** (UDP/QUIC) — the real-time WebTransport stream

---

## 2. Why WebTransport

| Feature | WebSocket | Server-Sent Events | WebTransport |
|---|---|---|---|
| Protocol | TCP | TCP | QUIC (UDP) |
| Direction | Bidirectional | Server → Client | Bidirectional |
| Streams | Single | Single | Multiple independent |
| Unreliable channel | ✗ | ✗ | ✓ datagrams |
| Head-of-line blocking | Yes | Yes | No (per stream) |
| Multiplexing | No | No | Yes |

This project uses all three WebTransport features deliberately:

- **Datagrams** for `SCORE_UPDATE` — if a packet is lost, the next one in 4s
  is fine. No retransmit overhead.
- **Server-initiated unidirectional streams** for `BALL_EVENT` — each ball
  gets its own stream so a slow ball doesn't delay the next one.
- **Bidirectional stream** for commands — client sends `SUBSCRIBE`, server
  replies with `MATCH_STATE` on the same stream.

---

## 3. Three Transport Channels

```
Browser                                        Server
  │                                              │
  │  ①  Datagrams (unreliable, no ordering)      │
  │ ◄──────────────────────────────────────────  │  SCORE_UPDATE every ~4s
  │ ◄──────────────────────────────────────────  │  MATCH_LIST on connect
  │                                              │
  │  ②  Unidirectional streams (reliable, ordered per stream)
  │ ◄──────────────────────────────────────────  │  BALL_EVENT (new stream each ball)
  │ ◄──────────────────────────────────────────  │  MATCH_STATUS (innings break / end)
  │                                              │
  │  ③  Bidirectional stream (reliable, ordered) │
  │ ─────── SUBSCRIBE { matchId } ────────────►  │
  │ ◄────── MATCH_STATE (full scorecard) ───────  │
  │ ─────── UNSUBSCRIBE { matchId } ──────────►  │
  │ ─────── GET_MATCHES ───────────────────────►  │
  │ ◄────── ERROR { message } ─────────────────  │
```

### Where to find each channel in code

| Channel | Server writes | Client reads |
|---|---|---|
| Datagrams | `match-manager.js:193` `_broadcastDatagram()` | `transport-client.js:324` `_readDatagrams()` |
| Unidirectional streams | `match-manager.js:168` `_broadcastStream()` | `transport-client.js:237` `_readIncomingStreams()` |
| Bidirectional (commands) | `transport-server.js:153` `_handleCommandStream()` | `transport-client.js:301` `_readBidiReplies()` |

---

## 4. File Map

### Server

```
server/
├── index.js              Entry point — starts everything in order
├── config.js             All constants in one place (ports, timings, cert)
├── cert.js               Generates ECDSA P-256 TLS cert via OpenSSL
├── protocol.js           Message type constants + encode/decode functions
├── transport-server.js   HTTP/3 WebTransport server, session loop
├── match-manager.js      Orchestrates matches, manages subscriptions, broadcasts
└── cricket/
    ├── engine.js         Weighted random ball simulator + commentary
    ├── match.js          T20 match state machine (innings, overs, wickets)
    └── teams.js          Team/player data + matchup generator
```

### Client

```
client/
├── index.html            Single HTML page, loads scripts in dependency order
└── js/
    ├── protocol.js       Mirror of server/protocol.js (same MSG constants)
    ├── transport-client.js  WebTransport connection + reconnect logic
    ├── store.js          Client-side state store with observer pattern
    ├── ui.js             Pure DOM rendering functions
    └── app.js            Wires transport → store → UI
```

### Key line numbers to bookmark

| What you want to find | File : Line |
|---|---|
| Port numbers | `server/config.js:15-23` |
| Ball interval timing | `server/config.js:30` |
| Message type names | `server/protocol.js:1-20` |
| encode() / decode() | `server/protocol.js:35-55` |
| Ball probability weights | `server/cricket/engine.js:44-54` |
| Situational weight adjustments | `server/cricket/engine.js:83-139` |
| Ball delivery → state update | `server/cricket/match.js:~120` `deliverBall()` |
| Timer that fires each ball | `server/match-manager.js:81-84` `_startTicker()` |
| Broadcast BALL_EVENT stream | `server/match-manager.js:110-114` |
| Broadcast SCORE_UPDATE datagram | `server/match-manager.js:116-128` |
| WebTransport server creation | `server/transport-server.js:49-57` |
| Session accept loop | `server/transport-server.js:70-85` |
| SUBSCRIBE handler | `server/transport-server.js:175` |
| Client connect + cert pinning | `client/js/transport-client.js:138-146` |
| Re-subscribe after reconnect | `client/js/transport-client.js:176-178` |
| Message dispatcher (all types) | `client/js/app.js:60-121` |
| Store mutations | `client/js/store.js:~80-130` |
| Render scorecard | `client/js/ui.js:~50` `renderScorecard()` |
| Render over log | `client/js/ui.js:~250` `renderOverLog()` |

---

## 5. Data Flow — Ball to Browser

Here is the complete journey of a single ball delivery:

```
setInterval fires every 4000ms
         │
         ▼
match-manager.js  _tick(matchId)  [line 86]
         │
         ▼
match.js  deliverBall()  [line ~120]
  ├── calls engine.js  simulateBall()  [line 145]
  │       ├── situationalWeights()  adjusts probabilities
  │       ├── weightedRandom()      picks outcome (DOT/FOUR/WICKET/…)
  │       └── generateCommentary()  produces text like "FOUR! Slapped over mid-off!"
  └── updates innings state
        runs, wickets, overs, ballsInOver, fallOfWickets, overLog
         │
         ▼
match-manager.js  broadcasts to all subscribed sessions
  │
  ├── _broadcastStream(MSG.BALL_EVENT)       [line 110]
  │       → session.createUnidirectionalStream()
  │       → writer.write(encode('BALL_EVENT', { ball, scorecard }))
  │       → writer.close()
  │
  └── _broadcastDatagram(MSG.SCORE_UPDATE)  [line 116]
          → session.datagrams.writable.getWriter()
          → writer.write(encode('SCORE_UPDATE', { runs, wickets, overs }))
         │
         │       [crosses the QUIC/UDP network boundary]
         │
         ▼
transport-client.js  (browser)
  ├── _readIncomingStreams()  [line 237]  ← receives BALL_EVENT
  │       → _consumeStream()  reassembles chunks
  │       → decode(data)  → JSON.parse
  │       → _onMessage(msg)  → emit('message', msg)
  │
  └── _readDatagrams()  [line 324]  ← receives SCORE_UPDATE
          → decode(chunk)
          → _onMessage(msg)  → emit('message', msg)
         │
         ▼
app.js  transport.on('message', handler)  [line 60]
  ├── MSG.BALL_EVENT  → store.applyBallEvent()  + addCommentary()
  └── MSG.SCORE_UPDATE → store.applyScoreUpdate()
         │
         ▼
store.js  emits events  [observer pattern]
  ├── emit('matchUpdated', matchId)
  └── emit('scoreUpdated')
         │
         ▼
app.js  store observers  [lines 124-170]
  ├── 'matchUpdated'  → renderScorecard(match)
  │                  → renderFallOfWickets(match)
  └── 'scoreUpdated' → renderMatchTabs(matches)
         │
         ▼
ui.js  DOM updates
  ├── renderScorecard()   batting table, bowling table, over log
  ├── renderMatchTabs()   score badge on each tab
  └── addCommentary()     prepends to commentary feed
```

Total latency from `setInterval` firing to browser paint: **~2-5ms** over loopback.

---

## 6. Server Startup Sequence

`server/index.js` boots in this exact order (each step must complete before
the next starts — they are sequential `await` calls):

```
Step 1: getOrCreateCert()         cert.js
  ├── Check /tmp/cricket-wt-cert.json cache
  ├── If missing/expired: openssl genpkey → openssl req → compute SHA-256
  └── Returns { cert (PEM), key (PEM), fingerprint (Buffer) }

Step 2: manager.start()           match-manager.js
  ├── getMatchups(4)              teams.js — picks 3-4 non-overlapping pairs
  ├── new Match({ team1, team2, venue })  for each pair
  └── setInterval(_tick, 4000)   starts the ball-delivery timer

Step 3: createTransportServer()   transport-server.js
  ├── await quicheLoaded          waits for native C++ QUIC binary
  ├── new Http3Server({ port:4433, cert, privKey: key })
  ├── server.startServer()        binds UDP :4433
  └── _acceptSessionsLoop()       starts background session reader

Step 4: app.listen(3000)          index.js
  ├── express.static('./client')  serves HTML/CSS/JS
  ├── GET /api/server-info        returns wtPort, certHash, matches
  └── GET /api/health             uptime, matchCount
```

**If startup fails:** The error is almost always in Step 1 (OpenSSL not found)
or Step 3 (port 4433 already in use, or quiche binary missing). Check the
console log prefix — `[cert]`, `[transport]`, `[http]` — to know which step failed.

---

## 7. Client Startup Sequence

On page load, `index.html` loads scripts in this dependency order:

```
protocol.js        → defines MSG constants + encode/decode (no deps)
store.js           → defines CricketStore (no deps)
transport-client.js → defines CricketTransportClient (needs MSG/encode/decode)
ui.js              → defines render* functions (needs DOM)
app.js             → runs immediately (needs all of the above)
```

`app.js` runs these steps in order:

```
1. Check typeof WebTransport === 'undefined'
     └── if missing: show #wt-unsupported banner, hide #app

2. new CricketStore()
   new CricketTransportClient('/api/server-info')

3. Register transport.on('message') handlers for all MSG types

4. Register store.on('matchListUpdated' | 'matchUpdated' | 'scoreUpdated') → UI renders

5. renderConnectionStatus('connecting')

6. transport.connect()
     ├── fetch('/api/server-info')  → gets { wtPort, certHash, wtPath }
     ├── new WebTransport(url, { serverCertificateHashes: [{ algorithm, value }] })
     ├── await transport.ready      ← TLS + HTTP/3 handshake
     ├── createBidirectionalStream()  ← opens command channel
     ├── _readBidiReplies()         ← starts reading server responses
     ├── re-subscribe to all _subscriptions (for reconnect path)
     ├── _readIncomingStreams()      ← starts reading BALL_EVENT streams
     └── _readDatagrams()           ← starts reading SCORE_UPDATE datagrams

7. Server sends MATCH_LIST datagram immediately on connect
     └── app.js MSG.MATCH_LIST handler:
           ├── store.setMatchList(matches)
           └── transport.subscribe(matchId)  for each match
                 └── sends SUBSCRIBE command over bidi stream
                       └── server replies with MATCH_STATE (full scorecard)
```

---

## 8. State Management

The browser uses a simple **Observer/Store** pattern (like a tiny Redux without
the boilerplate). No frameworks — pure JavaScript.

```
store.js  CricketStore

  Internal state:
  ├── _matches: Map<matchId, fullMatchObject>   from MATCH_STATE + BALL_EVENT
  ├── _matchList: Array<matchSummary>           from initial MATCH_LIST datagram
  ├── _activeMatchId: string                    which tab is selected
  └── _connectionStatus: 'connecting'|'connected'|'disconnected'|'error'

  Write methods (called from app.js message handlers):
  ├── setMatchList(matches)         stores initial summaries
  ├── setMatchState(state)          stores full scorecard from SUBSCRIBE reply
  ├── applyBallEvent(matchId, sc)   updates match from BALL_EVENT scorecard
  ├── applyScoreUpdate(payload)     fast-path update from datagram
  ├── applyMatchStatus(payload)     innings break / match end
  └── setActiveMatch(matchId)       tab click

  Read methods (called from ui.js):
  ├── getMatch(matchId)             full match object
  ├── getMatchList()                derived from _matches if available, else _matchList
  ├── getActiveMatchId()
  └── getState()                    entire state snapshot (for debugging)

  Observer:
  └── on(event, handler) / emit(event, data)
        Events fired after each mutation:
        ├── 'matchListUpdated'   → re-render match tabs
        ├── 'matchUpdated'       → re-render scorecard (active match only)
        ├── 'scoreUpdated'       → re-render tab score badges
        ├── 'activeMatchChanged' → switch scorecard view
        └── 'connectionChanged'  → update status badge
```

**Debugging the store in DevTools:**
```javascript
// Inspect full state
window._store.getState()

// Get specific match
window._store.getMatch('match-id-here')

// Get the derived match list (should show live scores)
window._store.getMatchList()

// Manually trigger a UI re-render
window._store.emit('matchUpdated', window._store.getActiveMatchId())
```

---

## 9. Certificate System

WebTransport requires TLS. Browsers refuse self-signed certs unless you use
`serverCertificateHashes` — the browser verifies the cert's SHA-256 fingerprint
rather than trusting a CA chain.

```
cert.js  getOrCreateCert()

  Cache check:
  /tmp/cricket-wt-cert.json  →  { cert, key, fingerprintHex, expiresAt }
    └── If expires in >1 day: reuse it

  Generate (if missing/expired):
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256
    └── Produces PKCS#8 ECDSA P-256 private key
          "-----BEGIN PRIVATE KEY-----"

  openssl req -new -x509 -key <key> -days 14 -subj "/CN=localhost"
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
    -addext "basicConstraints=CA:false"
    └── Self-signed leaf certificate

  computeFingerprint(cert):
    strip PEM headers → base64 decode → raw DER bytes → SHA-256 → Buffer(32)

  /api/server-info returns fingerprintHex (64-char hex string)

  Browser:
    _hexToUint8Array(certHash) → Uint8Array(32)
    new WebTransport(url, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: bytes.buffer }]
    })
```

**Why ECDSA P-256 and not RSA?**
The quiche library's `ChromiumWebTransportFingerprintProofVerifier` (the C++
code that validates the fingerprint) only accepts ECDSA certificates. RSA certs
pass OpenSSL generation fine but are silently rejected during the QUIC TLS
handshake, resulting in "Opening handshake failed" with no explanation.

**Why ≤14 days?**
The WebTransport spec limits self-signed cert validity to 14 days. The quiche
C++ verifier enforces this strictly. Certs with longer validity are rejected.

---

## 10. The Cricket Engine

```
engine.js  simulateBall(innings, batsman, bowler, fielders)

  1. situationalWeights(innings)
       Starts from BASE_WEIGHTS (tuned for ~7–9 RPO, ~6–7 wickets/innings):
         DOT:37, RUN_1:23, RUN_2:9, RUN_3:2, FOUR:13, SIX:5,
         WIDE:4, NO_BALL:2, WICKET:5

       Adjustments (additive to weights):
         Death overs (≥17):   SIX+4, FOUR+3, DOT+3, WICKET+2, RUN_1-6
         Power play (<6):     FOUR+3, SIX+1, DOT-2
         Low wickets (≥7):    DOT+6, WICKET+4, SIX-4, FOUR-4
         Desperate chase RRR>12: SIX+5, WICKET+4, DOT-4
         Easy chase RRR<6:    RUN_1+4, DOT-3, WICKET-2

  2. weightedRandom(items)
       roll = Math.random() * totalWeight
       scan items, subtract each weight until roll < 0 → winner

  3. Build BallResult { type, runs, isExtra, isLegalBall, wicket, commentary }

  4. generateCommentary(event, bowler, batsman)
       Picks a random template from COMMENTARY_TEMPLATES
       Templates are functions: (bowler, batsman) => string
```

**To experiment:** Change `BASE_WEIGHTS` in `engine.js:44-54` and watch the
simulation change character. Set `WICKET: 20` to see rapid wicket collapses,
or `SIX: 30` for a run-fest.

---

## 11. Debugging Playbook

### The server won't start

```bash
# 1. Check which step fails from the log prefix:
node server/index.js 2>&1 | head -30

# [cert] error   → OpenSSL not found, or /tmp not writable
# [transport]    → quiche binary failed to load, or UDP :4433 in use
# [http] ERROR   → TCP :3000 in use

# 2. Kill stale processes:
kill $(lsof -ti UDP:4433) 2>/dev/null
kill $(lsof -ti TCP:3000) 2>/dev/null

# 3. Regenerate certificate (delete cache):
rm /tmp/cricket-wt-cert.json
```

### The test client fails ("Opening handshake failed")

```bash
# Verify server is actually running:
curl http://localhost:3000/api/server-info

# Run the cert diagnostic:
node test/verify-cert.js

# Common causes:
# 1. Server used an RSA cert (old cached cert) → delete cache and restart
# 2. certBytes.buffer passed instead of certBytes (ArrayBuffer vs Buffer)
# 3. Server crashed silently — check server terminal output
```

### The browser shows scores not updating

Open DevTools Console and look for:

```
[wt] Connecting to https://localhost:4433/cricket   ← connection attempt
[wt] Connected!                                      ← success
[app] WebTransport connected                         ← app layer confirmed
```

If you see `[wt] Connection failed` — the browser can't reach UDP:4433.
In Codespaces this is expected (UDP not forwarded). Use the Node.js test
client instead.

**In-browser store inspection:**
```javascript
// Run these in the DevTools Console:
window._store.getState()          // full state dump
window._store.getMatchList()      // should show 3 matches with live scores
window._wt.isConnected            // true if WebTransport is up

// Manually subscribe to a match (paste a real matchId from getMatchList()):
window._wt.subscribe('e6f09dd1-....')
```

### Messages arrive but UI doesn't update

The rendering pipeline is:
```
store mutation → store.emit(event) → app.js handler → ui.js render function
```

Add a log at each stage to find where it breaks:

```javascript
// In app.js, inside transport.on('message'):
console.log('[debug] message received:', msg.type, msg.payload?.matchId);

// In store.js applyBallEvent():
console.log('[debug] store updated:', matchId);

// In app.js store.on('matchUpdated'):
console.log('[debug] render triggered for:', matchId, 'active:', store.getActiveMatchId());
```

### Commentary feed is empty

`addCommentary()` is in `ui.js`. It expects the element `#commentary-feed` to
exist in `index.html`. Check:

```javascript
document.getElementById('commentary-feed')  // must not be null
```

### Score on a tab isn't updating

`store.getMatchList()` derives scores from `_matches` (live) not `_matchList`
(initial summaries). If `_matches` is empty the tab will show the stale initial
score. Verify:

```javascript
window._store._matches.size   // should be 3 after subscribing
```

---

## 12. Common Errors & Fixes

| Error | Cause | Fix |
|---|---|---|
| `Opening handshake failed` | RSA cert instead of ECDSA | Delete `/tmp/cricket-wt-cert.json`, restart server |
| `Opening handshake failed` | `certBytes.buffer` passed (ArrayBuffer) | Pass `certBytes` directly (Buffer) — see `test/wt-client.js:103` |
| `Port 3000 is already in use` | Old server process still running | `kill $(lsof -ti TCP:3000)` |
| `Certificate verification failed` | Browser has stale fingerprint | Hard-refresh browser (Ctrl+Shift+R), or clear site data |
| `WebTransport is not defined` | Firefox / Safari / old Chrome | Use Chrome 97+ or Edge 97+ |
| `DNS_PROBE_FINISHED_NXDOMAIN` | Codespaces port is Private | Right-click port 3000 in Ports panel → Port Visibility → Public |
| `quicheLoaded` never resolves | Native addon failed to load | Check Node.js version (≥18), run `npm ci` again |
| Scores stuck at initial value | `_matches` map empty | Check SUBSCRIBE was sent; check bidi stream is open |
| `[object Object]` in tabs | team1/team2 is an object not string | `store.getMatchList()` normalises with `team?.shortName` |

---

## 13. How to Extend

### Add a new message type

1. Add the constant to `server/protocol.js` `MSG` object
2. Server: emit it with `encode(MSG.NEW_TYPE, payload)` in `match-manager.js`
3. Client: handle it in `app.js` inside `transport.on('message')` switch
4. Optionally add store mutation and UI render function

### Change ball frequency

Edit `BALL_INTERVAL_MS` in `server/config.js:30`. Default is 4000 (4 seconds).
Set to 1000 for stress testing. The match will complete proportionally faster.

### Add a new team

Edit `server/cricket/teams.js`. Add a team object to the `TEAMS` array following
the same structure (shortName, players array with roles). `getMatchups()` picks
pairs automatically from the full list.

### Adjust ball probabilities

Edit `BASE_WEIGHTS` in `server/cricket/engine.js:44-54`. The numbers are
relative weights — they don't need to sum to 100 (the algorithm normalises them).
To test: set `WICKET: 50` and watch matches end quickly.

### Add persistent match history

`match-manager.js` holds matches in a plain `Map` (in-memory only). To persist:
- On `matchEnded`, write `match.toJSON()` to a file or database
- Expose a `GET /api/results` endpoint in `server/index.js`
