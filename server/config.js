/**
 * config.js — Central configuration for the cricket score engine.
 *
 * WHY a config file?  Hard-coding values like ports or timings across many
 * files makes tuning painful and error-prone.  A single source of truth lets
 * you change the ball-delivery speed (BALL_INTERVAL_MS) or add a new match
 * without hunting through code.
 */

// ─── Network ──────────────────────────────────────────────────────────────────

// WebTransport runs on HTTP/3 which uses QUIC (UDP), NOT the usual TCP port.
// Browsers connect to this port for real-time score streaming.
export const WEBTRANSPORT_PORT = 4433;

// Regular HTTP server port — serves the dashboard HTML/CSS/JS and the
// /api/server-info endpoint that hands the client the cert fingerprint.
export const HTTP_PORT = 3000;

// The path that WebTransport clients connect to.
// e.g.  new WebTransport("https://localhost:4433/cricket")
export const WEBTRANSPORT_PATH = '/cricket';

// ─── Match simulation timing ─────────────────────────────────────────────────

// How long (ms) between ball deliveries.  4 000 ms = 4 s ≈ comfortable for
// watching.  Reduce to 1 000 for stress-testing.
export const BALL_INTERVAL_MS = 4000;

// Pause (ms) between innings so the UI can show the innings-break screen.
export const INNINGS_BREAK_MS = 10000;

// How many T20 matches to simulate simultaneously.
export const MAX_CONCURRENT_MATCHES = 4;

// ─── TLS certificate (needed for HTTP/3) ─────────────────────────────────────

// WebTransport REQUIRES TLS.  In production you'd use a real CA cert.
// In development we generate a self-signed cert and pin its SHA-256
// fingerprint in the browser's WebTransport constructor so it trusts it.
//
// ⚠  Per the spec, self-signed certs used with serverCertificateHashes must
//    be valid for ≤ 14 days.  We enforce this here.
export const CERT_VALIDITY_DAYS = 14;

// File path to cache the generated cert so we don't regenerate on every
// server restart (browsers would reject a new fingerprint mid-session).
export const CERT_CACHE_PATH = '/tmp/cricket-wt-cert.json';

// ─── Protocol ─────────────────────────────────────────────────────────────────

// Maximum bytes we read from a single stream chunk.
// Guards against memory exhaustion from a misbehaving client.
export const MAX_CHUNK_BYTES = 65536;
