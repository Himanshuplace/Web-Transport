/**
 * protocol.js (client-side) — GENERATED FILE. DO NOT EDIT BY HAND.
 *
 *   Source of truth: server/protocol.js
 *   Regenerate:      npm run gen:protocol   (runs automatically on npm start / npm run dev)
 *
 * Browsers can't import the server's ESM module, so the client needs its own
 * copy of MSG + encode/decode.  Generating it from server/protocol.js
 * guarantees the two can never drift.  Add or change message types in
 * server/protocol.js, not here — your edits to this file will be overwritten.
 */

const MSG = {
  MATCH_LIST:   "MATCH_LIST",
  MATCH_STATE:  "MATCH_STATE",
  BALL_EVENT:   "BALL_EVENT",
  SCORE_UPDATE: "SCORE_UPDATE",
  MATCH_STATUS: "MATCH_STATUS",
  ERROR:        "ERROR",
  SUBSCRIBE:    "SUBSCRIBE",
  UNSUBSCRIBE:  "UNSUBSCRIBE",
  GET_MATCHES:  "GET_MATCHES",
};

const _enc = new TextEncoder();
const _dec = new TextDecoder();

function encode(type, payload = {}) {
  return _enc.encode(JSON.stringify({ type, payload, ts: Date.now() }));
}

function decode(bytes) {
  return JSON.parse(_dec.decode(bytes));
}
