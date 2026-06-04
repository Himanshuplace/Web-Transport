/**
 * Diagnostic script: verify the certificate fingerprint matches
 * what the WebTransport client library expects, and test connecting
 * to the running server.
 *
 * Run with:  node test/verify-cert.js
 * (Server must be running: npm start)
 */

import crypto from 'crypto';
import { quicheLoaded, WebTransport } from '@fails-components/webtransport';
import { HTTP_PORT, WEBTRANSPORT_PORT } from '../server/config.js';

console.log('[verify] Waiting for QUIC engine…');
await quicheLoaded;
console.log('[verify] QUIC engine ready');

// ── Fetch server info ────────────────────────────────────────────────────
const res = await fetch(`http://localhost:${HTTP_PORT}/api/server-info`);
const info = await res.json();
console.log('[verify] Server info:', { port: info.wtPort, certHashLen: info.certHash.length, matches: info.matches.length });

// ── Try both fingerprint formats ─────────────────────────────────────────
const hexString   = info.certHash;
const bufferValue = Buffer.from(hexString, 'hex');

console.log('\n[verify] Testing connection with Buffer fingerprint…');
const url = `https://localhost:${WEBTRANSPORT_PORT}/cricket`;

try {
  const t = new WebTransport(url, {
    serverCertificateHashes: [{
      algorithm: 'sha-256',
      value: bufferValue,   // Buffer (not ArrayBuffer)
    }],
  });

  // Race: ready vs 5s timeout
  await Promise.race([
    t.ready.then(() => 'ready'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout after 5s')), 5000)),
  ]);

  console.log('[verify] ✓ Connection SUCCEEDED with Buffer fingerprint!');
  t.close();
} catch (err) {
  console.error('[verify] ✗ Connection FAILED:', err.message);
}
