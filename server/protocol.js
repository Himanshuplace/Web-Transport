/**
 * protocol.js — Message encoding and type definitions for the WebTransport wire protocol.
 *
 * WHY a shared protocol module?
 *   The server and client need to agree on message shapes.  A single module
 *   (mirrored as client/js/protocol.js for the browser) prevents accidental
 *   drift where the server sends "BALL_EVENT" but the client listens for
 *   "ball_event".
 *
 * FORMAT CHOICE — JSON over UTF-8:
 *   We encode messages as JSON strings → Uint8Array.  JSON is human-readable,
 *   easy to inspect in DevTools, and great for learning.  A production system
 *   serving millions of clients would migrate to MessagePack or Protocol
 *   Buffers for ~60 % smaller payloads, but the logic stays identical.
 *
 * THREE WEBTRANSPORT CHANNELS:
 *   1. Bidirectional streams  — client sends commands (SUBSCRIBE / UNSUBSCRIBE),
 *                               server replies with full MATCH_STATE.
 *   2. Unidirectional streams — server pushes BALL_EVENT per ball.
 *                               Each ball gets its own short-lived stream so
 *                               stream ordering is preserved per ball.
 *   3. Datagrams              — server broadcasts SCORE_UPDATE every few seconds.
 *                               Datagrams are unreliable + unordered (UDP-like),
 *                               perfect for lightweight "heartbeat" scores where
 *                               losing one packet is fine.
 *
 * Debugging tip: Log `decode(chunk)` inside transport-client.js to see every
 *   raw message arriving at the browser.
 */

// ── Message type constants ─────────────────────────────────────────────────────

export const MSG = {
  // Server → Client (via unidirectional stream or bidirectional reply)
  MATCH_LIST:    'MATCH_LIST',    // array of brief match summaries (on connect)
  MATCH_STATE:   'MATCH_STATE',   // full scorecard sent when client subscribes
  BALL_EVENT:    'BALL_EVENT',    // one delivery outcome + updated scorecard
  SCORE_UPDATE:  'SCORE_UPDATE',  // lightweight datagram: runs/wkts/overs only
  MATCH_STATUS:  'MATCH_STATUS',  // status change: innings break / match over
  ERROR:         'ERROR',         // server-side error details

  // Client → Server (via bidirectional stream)
  SUBSCRIBE:     'SUBSCRIBE',     // { matchId }  — start receiving updates
  UNSUBSCRIBE:   'UNSUBSCRIBE',   // { matchId }  — stop  receiving updates
  GET_MATCHES:   'GET_MATCHES',   // request fresh MATCH_LIST
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Serialises a message to a Uint8Array ready for WebTransport transmission.
 *
 * Every message on the wire is:
 *   { type: string, payload: object, ts: number (Unix ms) }
 *
 * `ts` lets you measure end-to-end latency in the browser:
 *   latency = Date.now() - message.ts
 */
export function encode(type, payload = {}) {
  const envelope = { type, payload, ts: Date.now() };
  return encoder.encode(JSON.stringify(envelope));
}

/**
 * Deserialises a Uint8Array (or ArrayBuffer) received from WebTransport.
 * Returns the parsed { type, payload, ts } object.
 *
 * Throws SyntaxError if the bytes are not valid JSON — add try/catch at
 * call sites when messages arrive from untrusted sources.
 */
export function decode(bytes) {
  return JSON.parse(decoder.decode(bytes));
}
