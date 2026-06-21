/**
 * cert.js — TLS certificate generation and fingerprint helpers.
 *
 * WHY self-signed certs?
 *   WebTransport runs over HTTP/3 which mandates TLS 1.3.  In production you
 *   use a Let's Encrypt or commercial certificate.  In development we generate
 *   a self-signed cert and give its SHA-256 fingerprint to the browser via the
 *   `serverCertificateHashes` option so Chrome/Edge will accept it WITHOUT
 *   adding it to the OS trust store.
 *
 * IMPORTANT CONSTRAINT — ECDSA P-256 required:
 *   The quiche library's ChromiumWebTransportFingerprintProofVerifier (used
 *   for fingerprint-pinned self-signed certs) only accepts ECDSA P-256 keys.
 *   RSA certificates are silently rejected during the QUIC handshake, resulting
 *   in "Opening handshake failed."  Always use ECDSA P-256 here.
 *
 * IMPORTANT CONSTRAINT — max 14 days validity:
 *   Certificates used with `serverCertificateHashes` must be valid for at most
 *   14 days (spec requirement).  We use 13 days with a 1-day early-renewal
 *   buffer, regenerating automatically when the cache is about to expire.
 *
 * Debugging tip: If the browser throws "Certificate verification failed" or
 *   "Fingerprint mismatch", the cert was probably regenerated on the server
 *   while the browser still has the old fingerprint.  Hard-refresh or clear
 *   site data, then reload — the UI fetches the new fingerprint automatically.
 */

import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { CERT_VALIDITY_DAYS, CERT_CACHE_PATH } from './config.js';

/**
 * Generates (or loads from cache) an ECDSA P-256 self-signed TLS certificate.
 *
 * Returns:
 *   { cert: string, key: string, fingerprint: Buffer }
 *
 * `cert` and `key` are PEM strings passed to the Http3Server constructor.
 * `fingerprint` is a 32-byte Buffer (SHA-256 of the DER cert) that the
 *  browser uses to pin the certificate via `serverCertificateHashes`.
 */
export function getOrCreateCert() {
  // Check if a valid cached cert exists so we avoid regenerating every restart.
  if (fs.existsSync(CERT_CACHE_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CERT_CACHE_PATH, 'utf8'));
      const expiresAt = new Date(cached.expiresAt);

      // If the cert is still valid with at least 1 day buffer, reuse it.
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (expiresAt.getTime() - Date.now() > oneDayMs) {
        console.log('[cert] Reusing cached certificate (expires:', expiresAt.toISOString(), ')');
        return {
          cert: cached.cert,
          key:  cached.key,
          fingerprint: Buffer.from(cached.fingerprintHex, 'hex'),
        };
      }
      console.log('[cert] Cached certificate expired or expiring soon, regenerating…');
    } catch {
      console.log('[cert] Cache read failed, regenerating…');
    }
  }

  // ── Generate a new ECDSA P-256 self-signed certificate ────────────────────
  //
  // We use OpenSSL (via child_process) because Node.js has no built-in X.509
  // certificate creation API, and the popular `selfsigned` npm package only
  // supports RSA — which the quiche WebTransport fingerprint verifier rejects.
  //
  // The two-step process:
  //   Step 1: Generate an ECDSA P-256 private key
  //   Step 2: Self-sign an X.509 certificate valid for CERT_VALIDITY_DAYS days
  const keyPath  = `${CERT_CACHE_PATH}.key.tmp`;
  const certPath = `${CERT_CACHE_PATH}.cert.tmp`;

  try {
    // Step 1: Generate ECDSA P-256 private key
    execSync(
      `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "${keyPath}"`,
      { stdio: 'pipe' }
    );

    // Step 2: Self-sign with SAN for both localhost and 127.0.0.1.
    //   -days CERT_VALIDITY_DAYS  → validity window (max 14 for WebTransport)
    //   -addext subjectAltName    → required; browsers reject certs without SAN
    //   -addext basicConstraints  → CA:false marks this as a leaf cert (not CA)
    execSync(
      `openssl req -new -x509 -key "${keyPath}" -out "${certPath}" ` +
      `-days ${CERT_VALIDITY_DAYS} ` +
      `-subj "/CN=localhost" ` +
      `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1" ` +
      `-addext "basicConstraints=CA:false" `,
      { stdio: 'pipe' }
    );

    const key  = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');

    // Clean up temp files
    fs.unlinkSync(keyPath);
    fs.unlinkSync(certPath);

    // ── Compute SHA-256 fingerprint ──────────────────────────────────────────
    // The browser's WebTransport API expects the RAW DER-encoded certificate
    // bytes hashed with SHA-256 — NOT the PEM string.
    // Steps: strip PEM headers → base64-decode → hash with SHA-256.
    const fingerprint = computeFingerprint(cert);

    // ── Cache to disk ────────────────────────────────────────────────────────
    const expiresAt = new Date(Date.now() + CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
    try {
      fs.writeFileSync(CERT_CACHE_PATH, JSON.stringify({
        cert,
        key,
        fingerprintHex: fingerprint.toString('hex'),
        expiresAt:      expiresAt.toISOString(),
      }));
      console.log('[cert] New certificate cached at', CERT_CACHE_PATH);
    } catch (err) {
      console.warn('[cert] Could not cache cert:', err.message);
    }

    console.log('[cert] Generated new ECDSA P-256 certificate (valid until', expiresAt.toISOString(), ')');
    console.log('[cert] Fingerprint (SHA-256):', fingerprint.toString('hex'));

    return { cert, key, fingerprint };
  } catch (err) {
    // Clean up temp files on error
    try { fs.unlinkSync(keyPath); } catch { /* ignore */ }
    try { fs.unlinkSync(certPath); } catch { /* ignore */ }
    throw new Error(`Certificate generation failed: ${err.message}\n` +
      'Make sure OpenSSL is installed and on PATH: apt install openssl (Linux), ' +
      'brew install openssl (macOS), or winget install ShiningLight.OpenSSL (Windows).');
  }
}

/**
 * Converts a PEM certificate string to its SHA-256 fingerprint (as Buffer).
 *
 * PEM format:
 *   -----BEGIN CERTIFICATE-----
 *   <base64-encoded DER data>
 *   -----END CERTIFICATE-----
 *
 * We strip the headers, base64-decode to get raw DER bytes, then SHA-256 hash.
 */
export function computeFingerprint(certPem) {
  const b64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(b64, 'base64');
  return crypto.createHash('sha256').update(der).digest();
}
