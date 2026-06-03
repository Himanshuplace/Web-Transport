/**
 * protocol.js (client-side mirror of server/protocol.js)
 *
 * WHY copy this to the client?
 *   Browsers can't use Node.js `require()`.  We duplicate the constants and
 *   encode/decode helpers here.  In a TypeScript project you'd share this via
 *   a monorepo package.  Keep both files in sync when adding message types.
 *
 * Debugging tip:
 *   Open DevTools → Console, type `window._wt` and inspect the transport
 *   object.  It exposes `_wt.send({ type: MSG.GET_MATCHES, payload: {} })`
 *   so you can send commands manually.
 */

const MSG = {
  // Server → Client
  MATCH_LIST:   'MATCH_LIST',
  MATCH_STATE:  'MATCH_STATE',
  BALL_EVENT:   'BALL_EVENT',
  SCORE_UPDATE: 'SCORE_UPDATE',
  MATCH_STATUS: 'MATCH_STATUS',
  COMMENTARY:   'COMMENTARY',
  ERROR:        'ERROR',

  // Client → Server
  SUBSCRIBE:    'SUBSCRIBE',
  UNSUBSCRIBE:  'UNSUBSCRIBE',
  GET_MATCHES:  'GET_MATCHES',
};

const _enc = new TextEncoder();
const _dec = new TextDecoder();

function encode(type, payload = {}) {
  return _enc.encode(JSON.stringify({ type, payload, ts: Date.now() }));
}

function decode(bytes) {
  return JSON.parse(_dec.decode(bytes));
}
