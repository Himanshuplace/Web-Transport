/**
 * wt-client.js — Node.js WebTransport test client.
 *
 * PURPOSE:
 *   Connects to the server as a WebTransport client (from Node.js, not a
 *   browser) and prints live score events to the terminal.  Useful for:
 *     • Verifying the server works without opening a browser
 *     • Learning how the CLIENT side of WebTransport works
 *     • Stress-testing: run multiple copies in parallel
 *
 * HOW TO RUN (server must already be running in another terminal):
 *   node test/wt-client.js
 *   node test/wt-client.js --duration=120   # run for 2 minutes
 *
 * WHAT YOU WILL SEE:
 *   The script:
 *     1. Fetches /api/server-info to get the cert fingerprint + match list
 *     2. Opens a WebTransport connection using the certificate fingerprint
 *        (same technique as the browser — fingerprint-pinned self-signed cert)
 *     3. Reads the initial MATCH_LIST (now a reliable unidirectional stream)
 *     4. Subscribes to all matches via the bidirectional command stream
 *     5. Prints each BALL_EVENT and SCORE_UPDATE to the terminal
 *     6. Exits after `duration` seconds
 *
 * WHY THIS IS EDUCATIONAL:
 *   The browser hides WebTransport internals behind DevTools.  Here you see
 *   every step explicitly: cert fingerprint conversion, stream opening,
 *   datagram reading, and message decoding — no magic.
 *
 * DEBUGGING tips:
 *   Add --verbose to see every raw message (including MATCH_STATE).
 *   Watch the latency output — "Latency: Xms" after each ball event.
 */

import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import { decode, encode, MSG } from '../server/protocol.js';
import { HTTP_PORT, WEBTRANSPORT_PORT } from '../server/config.js';

// ── CLI arguments ──────────────────────────────────────────────────────────
const args        = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);
const DURATION_MS = Number(args.duration || 60) * 1000;  // default 60 s
const VERBOSE     = !!args.verbose;

// ── Colours for terminal output ────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
};

function colored(color, text) { return color + text + C.reset; }
function log(...args)  { console.log(...args); }
function dim(...args)  { console.log(C.dim, ...args, C.reset); }

// ── Entry point ────────────────────────────────────────────────────────────
async function main() {
  // ── Step 1: Wait for the native QUIC binary to load ─────────────────────
  // Same as the server: must await quicheLoaded before creating WebTransport.
  log(colored(C.cyan, '\n[client] Waiting for QUIC engine…'));
  await quicheLoaded;
  log(colored(C.green, '[client] QUIC engine ready'));

  // ── Step 2: Fetch server connection info ─────────────────────────────────
  // The server exposes /api/server-info with the cert fingerprint and match list.
  // In a real app with a CA-signed cert, you'd skip the fingerprint fetch.
  log(colored(C.cyan, `[client] Fetching server info from http://localhost:${HTTP_PORT}/api/server-info`));
  let serverInfo;
  try {
    const res = await fetch(`http://localhost:${HTTP_PORT}/api/server-info`);
    serverInfo = await res.json();
  } catch (err) {
    console.error(colored(C.red, `[client] ERROR: Could not reach HTTP server on port ${HTTP_PORT}.`));
    console.error(colored(C.red, `         Is the server running?  Run: npm start`));
    process.exit(1);
  }

  const { certHash, wtPath, matches } = serverInfo;
  log(colored(C.green, `[client] Server has ${matches.length} active matches`));

  // ── Step 3: Convert hex fingerprint → Buffer ─────────────────────────────
  // The hex string "aabb…" from the server needs to become raw bytes for
  // the WebTransport `serverCertificateHashes` option.
  // Use Buffer (not ArrayBuffer) — the quiche NAPI addon expects a Buffer.
  const certBytes = Buffer.from(certHash, 'hex');

  // ── Step 4: Open WebTransport connection ─────────────────────────────────
  const url = `https://localhost:${WEBTRANSPORT_PORT}${wtPath}`;
  log(colored(C.cyan, `[client] Connecting to ${url}`));

  let transport;
  try {
    transport = new WebTransport(url, {
      serverCertificateHashes: [{
        algorithm: 'sha-256',
        // Must be a Node.js Buffer — the quiche C++ addon uses Napi::Buffer<char>
        // to read raw bytes.  Do NOT pass certBytes.buffer (ArrayBuffer) — that
        // is the *underlying* memory allocation and is NOT a Buffer object, so
        // the native addon reads garbage bytes and the fingerprint mismatches.
        value: certBytes,
      }],
    });
    await transport.ready;
  } catch (err) {
    console.error(colored(C.red, `[client] WebTransport connection failed: ${err.message}`));
    console.error(colored(C.dim, '         Check that the server is running and the cert has not expired.'));
    process.exit(1);
  }

  log(colored(C.green, '[client] WebTransport connection established!\n'));
  log('─'.repeat(60));

  // Track match scores for compact terminal display
  const scores = {};

  // ── Step 5: Start reading datagrams (background) ─────────────────────────
  // Datagrams arrive unreliably/unordered.  We read them in a parallel task.
  readDatagrams(transport, scores).catch(console.error);

  // ── Step 6: Start reading server-initiated unidirectional streams ─────────
  // The server sends BALL_EVENT via new streams; we process them here.
  readIncomingStreams(transport, scores).catch(console.error);

  // ── Step 7: Open bidirectional stream and subscribe to all matches ────────
  // This is the command channel — same as the browser's command channel.
  const bidiStream = await transport.createBidirectionalStream();
  const writer     = bidiStream.writable.getWriter();

  // Start reading replies (MATCH_STATE etc.) in the background
  readBidiReplies(bidiStream.readable, scores).catch(console.error);

  log(colored(C.bold, `[client] Subscribing to ${matches.length} matches…\n`));
  for (const match of matches) {
    await writer.write(encode(MSG.SUBSCRIBE, { matchId: match.matchId }));
    scores[match.matchId] = { title: match.title, runs: 0, wickets: 0, overs: '0.0' };
    log(`         → Subscribed: ${match.title} (${match.matchId})`);
  }
  log('');

  // ── Step 8: Run for DURATION_MS then shut down cleanly ───────────────────
  log(colored(C.dim, `[client] Watching for ${DURATION_MS / 1000}s…  (Ctrl+C to stop early)\n`));

  await new Promise(resolve => setTimeout(resolve, DURATION_MS));

  log('\n' + '─'.repeat(60));
  log(colored(C.bold, '[client] Session complete.  Final scores:'));
  for (const [, s] of Object.entries(scores)) {
    if (s.runs !== undefined) {
      log(`  ${colored(C.yellow, s.title.padEnd(20))} ${s.runs}/${s.wickets} (${s.overs} ov)`);
    }
  }

  transport.close();
  log(colored(C.green, '[client] Connection closed cleanly.\n'));
  process.exit(0);
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function readDatagrams(transport, scores) {
  const reader = transport.datagrams.readable.getReader();
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;

      const msg = decode(chunk);

      if (msg.type === MSG.SCORE_UPDATE) {
        const p = msg.payload;
        const s = scores[p.matchId];
        if (s) {
          s.runs    = p.runs;
          s.wickets = p.wickets;
          s.overs   = p.overs;
        }
        if (VERBOSE) {
          dim(`[datagram] SCORE_UPDATE ${p.team1} v ${p.team2}: ${p.runs}/${p.wickets} (${p.overs})`);
        }
      }
    }
  } catch { /* transport closed */ }
}

async function readIncomingStreams(transport, scores) {
  const reader = transport.incomingUnidirectionalStreams.getReader();
  try {
    while (true) {
      const { done, value: stream } = await reader.read();
      if (done) break;

      // Read all chunks from the stream and decode the message
      consumeStream(stream).then(data => {
        const msg = decode(data);
        handleStreamMessage(msg, scores);
      }).catch(console.error);
    }
  } catch { /* transport closed */ }
}

async function readBidiReplies(readable, scores) {
  const reader = readable.getReader();
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;

      const msg = decode(chunk);

      if (msg.type === MSG.MATCH_STATE) {
        const m = msg.payload;
        const inn = m.innings?.[m.currentInnings - 1];
        const battingTeam = inn?.battingTeamId === m.team1?.id
          ? m.team1?.shortName : m.team2?.shortName;
        log(colored(C.green, `[bidi]   MATCH_STATE: ${m.title}`));
        log(`         Status: ${m.status}  |  Batting: ${battingTeam}`);
        if (inn) {
          log(`         Score:  ${inn.runs}/${inn.wickets} (${inn.overs}.${inn.ballsInOver} ov)`);
          log(`         RR:     ${inn.runRate}${inn.target ? `  |  Target: ${inn.target}  RRR: ${inn.requiredRunRate}` : ''}`);
        }
        log('');

        const s = scores[m.matchId];
        if (s) { s.runs = inn?.runs || 0; s.wickets = inn?.wickets || 0; }

      } else if (msg.type === MSG.ERROR) {
        console.error(colored(C.red, `[bidi]   ERROR: ${msg.payload.message}`));

      } else if (VERBOSE) {
        dim(`[bidi]   ${msg.type}`, JSON.stringify(msg.payload).slice(0, 80));
      }
    }
  } catch { /* transport closed */ }
}

function handleStreamMessage(msg, scores) {
  if (msg.type === MSG.MATCH_LIST) {
    // Initial match list now arrives on connect via a reliable unidirectional
    // stream (it used to be a datagram, which could be dropped before the
    // reader attached — leaving the client with no matches to subscribe to).
    log(colored(C.blue, '[stream]  MATCH_LIST received'));
    for (const m of msg.payload.matches) {
      dim(`           ${m.matchId.slice(0, 8)}… ${m.title} — ${m.score}`);
    }
    return;
  }

  const latency = msg.ts ? Date.now() - msg.ts : null;
  const latStr  = latency !== null ? colored(C.dim, ` (${latency}ms)`) : '';

  if (msg.type === MSG.BALL_EVENT) {
    const { ball, scorecard } = msg.payload;
    const inn = scorecard.innings?.[scorecard.currentInnings - 1];

    // Pick colour based on outcome
    let ballColor = C.reset;
    if (ball.type === 'SIX')       ballColor = C.red;
    else if (ball.type === 'FOUR') ballColor = C.green;
    else if (ball.type === 'WICKET') ballColor = C.yellow;

    const scoreStr = inn ? `${inn.runs}/${inn.wickets} (${inn.overs}.${inn.ballsInOver})` : '';
    log(
      colored(C.bold, scorecard.title.padEnd(20)),
      colored(C.yellow, scoreStr.padEnd(16)),
      colored(ballColor, ball.type.padEnd(10)),
      ball.commentary.slice(0, 55),
      latStr
    );

    const s = scores[msg.payload.matchId];
    if (s && inn) { s.runs = inn.runs; s.wickets = inn.wickets; s.overs = `${inn.overs}.${inn.ballsInOver}`; }

  } else if (msg.type === MSG.MATCH_STATUS) {
    const p = msg.payload;
    log(colored(C.cyan, `\n[stream] MATCH_STATUS: ${p.status}`) +
        (p.inn1Score ? `  1st innings: ${p.inn1Score}` : '') +
        (p.result ? `  RESULT: ${p.result.description}` : '') + '\n');

  } else if (VERBOSE) {
    dim(`[stream] ${msg.type}`, JSON.stringify(msg.payload).slice(0, 80));
  }
}

async function consumeStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
  return merged;
}

// ── Run ────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error(colored(C.red, '[client] Fatal error:'), err);
  process.exit(1);
});
