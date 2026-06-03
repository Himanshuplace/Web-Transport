/**
 * transport-server.js — WebTransport (HTTP/3) server and session handler.
 *
 * WHAT this module does:
 *   1. Creates an HTTP/3 server via @fails-components/webtransport.
 *   2. Awaits the quicheLoaded promise (the library loads the native
 *      QUIC binary asynchronously — must be ready before creating sessions).
 *   3. Accepts incoming WebTransport sessions on the /cricket path.
 *   4. Per session:
 *        a) Awaits session.ready (TLS + HTTP/3 CONNECT handshake).
 *        b) Sends MATCH_LIST immediately via datagram.
 *        c) Reads incoming bidirectional streams (SUBSCRIBE / UNSUBSCRIBE).
 *        d) Cleans up on session close.
 *
 * HOW WebTransport sessions work (recap):
 *   Browser calls `new WebTransport(url)` → QUIC handshake → CONNECT upgrade.
 *   Then:
 *     session.datagrams              — unreliable/unordered (like UDP)
 *     session.incomingBidirectionalStreams — client opens bidi streams (commands)
 *     session.createUnidirectionalStream() — server opens a send stream
 *
 * DEBUGGING tips:
 *   ⬤ Every connect/disconnect is logged with a short random session ID.
 *   ⬤ In Chrome: chrome://webrtc-internals → QUIC statistics.
 *   ⬤ Network DevTools tab → filter "webtransport".
 */

import { Http3Server, quicheLoaded } from '@fails-components/webtransport';
import { decode, encode, MSG } from './protocol.js';
import { WEBTRANSPORT_PORT, WEBTRANSPORT_PATH, MAX_CHUNK_BYTES } from './config.js';

/**
 * Creates and starts the HTTP/3 WebTransport server.
 * Must be called after `await quicheLoaded` (done inside this function).
 *
 * @param {string}       cert     — PEM certificate
 * @param {string}       key      — PEM private key
 * @param {MatchManager} manager  — match manager instance
 */
export async function createTransportServer(cert, key, manager) {
  // ── Wait for the native QUIC binary to load ─────────────────────────────
  // The @fails-components/webtransport package dynamically loads a C++ addon
  // (based on libquiche) that handles the actual HTTP/3 protocol.
  // We MUST await this before creating the server or it won't work.
  await quicheLoaded;
  console.log('[transport] QUIC/HTTP3 engine loaded');

  // Http3Server binds to a UDP port (QUIC runs over UDP, unlike TCP-based HTTP).
  const server = new Http3Server({
    port:    WEBTRANSPORT_PORT,
    host:    '0.0.0.0',
    secret:  'cricket-wt-secret-' + process.pid,  // internal QUIC token
    cert,
    privKey: key,
  });

  server.startServer();
  console.log(`[transport] WebTransport server listening on UDP :${WEBTRANSPORT_PORT}`);

  // sessionStream(path) returns a WHATWG ReadableStream of WebTransportSession.
  // A new session appears each time a browser opens `new WebTransport(url)`.
  const sessionReader = server.sessionStream(WEBTRANSPORT_PATH).getReader();

  // Process incoming sessions in a background async loop
  _acceptSessionsLoop(sessionReader, manager);

  return server;
}

async function _acceptSessionsLoop(reader, manager) {
  try {
    while (true) {
      const { done, value: session } = await reader.read();
      if (done) {
        console.log('[transport] Session stream ended — server shutting down');
        break;
      }
      _handleSession(session, manager).catch(err => {
        console.error('[transport] Unhandled session error:', err);
      });
    }
  } catch (err) {
    console.error('[transport] Session accept loop crashed:', err);
  }
}

async function _handleSession(session, manager) {
  const sid = Math.random().toString(36).slice(2, 10);
  const log = (...args) => console.log(`[session ${sid}]`, ...args);

  // ── Must await session.ready before using any session properties ─────────
  // `session.ready` resolves when the HTTP/3 CONNECT upgrade completes and
  // the client is actually ready to exchange data.
  try {
    await session.ready;
  } catch (err) {
    log('Failed to establish session:', err.message);
    return;
  }

  log('Connected');

  // ── Send MATCH_LIST immediately as a datagram ──────────────────────────
  try {
    const matchList = manager.getMatchList();
    const data      = encode(MSG.MATCH_LIST, { matches: matchList });
    const writer    = session.datagrams.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
    log('Sent MATCH_LIST datagram');
  } catch (err) {
    log('Could not send initial MATCH_LIST:', err.message);
  }

  // ── Listen for incoming bidirectional streams (client commands) ─────────
  _readCommandStreams(session, sid, manager).catch(err => {
    if (!String(err?.message).includes('closed')) {
      console.error(`[session ${sid}] Command stream reader crashed:`, err.message);
    }
  });

  // ── Wait for session close and clean up ────────────────────────────────
  try {
    await session.closed;
  } catch { /* closed with error — normal for tab close / network drop */ }

  manager.removeSession(session);
  log('Disconnected — removed from all subscriptions');
}

async function _readCommandStreams(session, sid, manager) {
  const streamReader = session.incomingBidirectionalStreams.getReader();
  while (true) {
    const { done, value: stream } = await streamReader.read();
    if (done) break;
    _handleCommandStream(stream, session, sid, manager).catch(err => {
      if (!String(err?.message).includes('closed')) {
        console.warn(`[session ${sid}] Command stream error:`, err.message);
      }
    });
  }
}

/**
 * Processes one bidirectional command stream.
 *
 * Client sends:  SUBSCRIBE { matchId }  → server replies with MATCH_STATE
 *                UNSUBSCRIBE { matchId } → server removes subscription
 *                GET_MATCHES             → server replies with MATCH_LIST
 *
 * The stream stays open for multiple commands (e.g. switch between matches).
 */
async function _handleCommandStream(stream, session, sid, manager) {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const log = (...a) => console.log(`[session ${sid}]`, ...a);

  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;

      if (chunk.byteLength > MAX_CHUNK_BYTES) {
        await writer.write(encode(MSG.ERROR, { message: 'Message too large' }));
        continue;
      }

      let msg;
      try { msg = decode(chunk); }
      catch { await writer.write(encode(MSG.ERROR, { message: 'Invalid JSON' })); continue; }

      log('Received command:', msg.type, msg.payload?.matchId ?? '');

      switch (msg.type) {
        case MSG.SUBSCRIBE: {
          const matchState = manager.subscribe(msg.payload.matchId, session);
          if (!matchState) {
            await writer.write(encode(MSG.ERROR, { message: `Match not found: ${msg.payload.matchId}` }));
          } else {
            log('Subscribed to', matchState.title);
            await writer.write(encode(MSG.MATCH_STATE, matchState));
          }
          break;
        }
        case MSG.UNSUBSCRIBE: {
          manager.unsubscribe(msg.payload.matchId, session);
          log('Unsubscribed from', msg.payload.matchId);
          break;
        }
        case MSG.GET_MATCHES: {
          await writer.write(encode(MSG.MATCH_LIST, { matches: manager.getMatchList() }));
          break;
        }
        default:
          log('Unknown command:', msg.type);
      }
    }
  } catch (err) {
    if (!String(err?.message).includes('closed')) {
      console.warn(`[session ${sid}] Stream read error:`, err.message);
    }
  } finally {
    try { await writer.close(); } catch { /* already closed */ }
  }
}
