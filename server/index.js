/**
 * index.js — Application entry point.
 *
 * WHAT starts here:
 *   1. TLS certificate generation (needed for HTTP/3 / WebTransport)
 *   2. Cricket match manager (creates matches, starts simulation timers)
 *   3. WebTransport HTTP/3 server (streams live data to browsers)
 *   4. Express HTTP server (serves client files + /api/server-info)
 *
 * HOW TO RUN:
 *   node server/index.js
 *
 * THEN OPEN:
 *   http://localhost:3000   ← dashboard (Chrome/Edge only for WebTransport)
 *
 * HOW IT WORKS END TO END:
 *   Browser → HTTP GET /               → serves index.html
 *   Browser → HTTP GET /api/server-info → gets cert fingerprint + match list
 *   Browser → WebTransport https://localhost:4433/cricket
 *                                       → real-time score stream (UDP/QUIC)
 *
 * DEBUGGING checklist:
 *   □ "QUIC/HTTP3 engine loaded" logged? → native addon loaded correctly
 *   □ "WebTransport server listening"?   → UDP :4433 is bound
 *   □ "HTTP server listening"?           → TCP :3000 is bound
 *   □ Browser shows "⬤ Live" in header? → TLS fingerprint was accepted
 *   □ Scores updating every ~4 s?        → BALL_INTERVAL_MS is working
 *   □ "Certificate verification failed"? → hard-refresh browser (new cert)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { getOrCreateCert }       from './cert.js';
import { MatchManager }          from './match-manager.js';
import { createTransportServer } from './transport-server.js';
import { HTTP_PORT, WEBTRANSPORT_PORT } from './config.js';

// ESM doesn't have __dirname — reconstruct it from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

async function main() {
  console.log('='.repeat(60));
  console.log('  Cricket Score Engine — WebTransport Live Scoring');
  console.log('='.repeat(60));

  // ── Step 1: TLS Certificate ──────────────────────────────────────────────
  // WebTransport requires HTTPS/HTTP3, which requires TLS.
  // In development: generate self-signed cert, expose fingerprint via HTTP API.
  // In production:  replace getOrCreateCert() with your CA-signed cert loader.
  const { cert, key, fingerprint } = getOrCreateCert();
  const fingerprintHex = fingerprint.toString('hex');

  // ── Step 2: Cricket Match Engine ─────────────────────────────────────────
  const manager = new MatchManager();
  manager.start();

  // ── Step 3: WebTransport HTTP/3 Server ───────────────────────────────────
  // This awaits the QUIC native binary to load before binding the port.
  await createTransportServer(cert, key, manager);

  // ── Step 4: Express HTTP Server ───────────────────────────────────────────
  const app = express();

  // Serve static files from /client directory
  app.use(express.static(path.join(__dirname, '..', 'client')));

  /**
   * GET /api/server-info
   *
   * Browser fetches this before opening WebTransport to get:
   *   - wtPort     → port for WebTransport URL
   *   - certHash   → SHA-256 fingerprint for `serverCertificateHashes`
   *   - matches    → initial match list (shown before WT connects)
   *
   * Production note: With a CA-signed cert you don't expose the fingerprint —
   * browsers trust CA certs automatically.  This endpoint is dev-only.
   */
  app.get('/api/server-info', (_req, res) => {
    res.json({
      wtPort:   WEBTRANSPORT_PORT,
      wtPath:   '/cricket',
      certHash: fingerprintHex,
      matches:  manager.getMatchList(),
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status:     'ok',
      matchCount: manager.matches.size,
      uptime:     Math.floor(process.uptime()),
      timestamp:  new Date().toISOString(),
    });
  });

  app.listen(HTTP_PORT, () => {
    console.log(`\n[http]  Dashboard   → http://localhost:${HTTP_PORT}`);
    console.log(`[http]  Server info → http://localhost:${HTTP_PORT}/api/server-info`);
    console.log(`[wt]    WebTransport → https://localhost:${WEBTRANSPORT_PORT}/cricket`);
    console.log(`[cert]  Fingerprint  → ${fingerprintHex}`);
    console.log('\n  Server ready.  Open http://localhost:3000 in Chrome/Edge.\n');
    console.log('='.repeat(60) + '\n');
  });

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  function shutdown(signal) {
    console.log(`\n[server] Received ${signal} — shutting down…`);
    manager.stop();
    process.exit(0);
  }
}

main().catch(err => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
