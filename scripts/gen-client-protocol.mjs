/**
 * gen-client-protocol.mjs — generates client/js/protocol.js from the server's
 * protocol module so the two can never drift.
 *
 * WHY this exists:
 *   The browser can't `import` the Node ESM module server/protocol.js, so the
 *   client has always carried its own copy of the MSG constants + encode/decode.
 *   Maintaining that copy by hand let it silently drift (it once grew a stray
 *   COMMENTARY constant the server never had).  This script makes
 *   server/protocol.js the single source of truth and regenerates the client
 *   copy from it.
 *
 * WHEN it runs:
 *   • `npm run gen:protocol`        — manually
 *   • automatically before `npm start` / `npm run dev` (prestart / predev hooks)
 *
 * The output is deterministic, so re-running with no protocol change produces
 * no git diff.
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { MSG } from '../server/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath   = path.join(__dirname, '..', 'client', 'js', 'protocol.js');

// Align the values into a column for readability (matches the hand-written style).
const pad = Math.max(...Object.keys(MSG).map(k => k.length)) + 1; // +1 for the ':'
const entries = Object.entries(MSG)
  .map(([k, v]) => `  ${(k + ':').padEnd(pad)} ${JSON.stringify(v)},`)
  .join('\n');

const content = `/**
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
${entries}
};

const _enc = new TextEncoder();
const _dec = new TextDecoder();

function encode(type, payload = {}) {
  return _enc.encode(JSON.stringify({ type, payload, ts: Date.now() }));
}

function decode(bytes) {
  return JSON.parse(_dec.decode(bytes));
}
`;

writeFileSync(outPath, content);
console.log(`[gen:protocol] Wrote ${path.relative(path.join(__dirname, '..'), outPath)} — ${Object.keys(MSG).length} MSG types`);
