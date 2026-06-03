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
 * IMPORTANT CONSTRAINT:
 *   Certificates used with `serverCertificateHashes` must be valid for at most
 *   14 days (spec requirement).  We set validity to 14 days and regenerate
 *   automatically when the cached cert expires.
 *
 * Debugging tip: If the browser throws "Certificate verification failed" or
 *   "Fingerprint mismatch", the cert was probably regenerated on the server
 *   while the browser still has the old fingerprint.  Hard-refresh or clear
 *   site data, then reload — the UI fetches the new fingerprint automatically.
 */

import fs from 'fs';
import crypto from 'crypto';
import selfsigned from 'selfsigned';
import { CERT_VALIDITY_DAYS, CERT_CACHE_PATH } from './config.js';

/**
 * Generates (or loads from cache) a self-signed TLS certificate.
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

  // ── Generate a new self-signed certificate ─────────────────────────────────
  // `selfsigned.generate` wraps the `node-forge` library to produce an X.509
  // cert + private key pair.  The `days` option controls validity.
  const attrs = [
    { name: 'commonName',         value: 'localhost'          },
    { name: 'organizationName',   value: 'CricketScoreEngine' },
  ];

  const pems = selfsigned.generate(attrs, {
    days:      CERT_VALIDITY_DAYS,
    algorithm: 'sha256',
    keySize:   2048,
    extensions: [
      { name: 'subjectAltName', altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip:    '127.0.0.1' },
      ]},
    ],
  });

  // ── Compute SHA-256 fingerprint ────────────────────────────────────────────
  // The browser's WebTransport API expects the RAW DER-encoded certificate
  // bytes hashed with SHA-256 — NOT the PEM string.
  // Steps: strip PEM headers → base64-decode → hash with SHA-256.
  const fingerprint = computeFingerprint(pems.cert);

  // ── Cache to disk ──────────────────────────────────────────────────────────
  const expiresAt = new Date(Date.now() + CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  try {
    fs.writeFileSync(CERT_CACHE_PATH, JSON.stringify({
      cert:           pems.cert,
      key:            pems.private,
      fingerprintHex: fingerprint.toString('hex'),
      expiresAt:      expiresAt.toISOString(),
    }));
    console.log('[cert] New certificate cached at', CERT_CACHE_PATH);
  } catch (err) {
    console.warn('[cert] Could not cache cert:', err.message);
  }

  console.log('[cert] Generated new self-signed certificate (valid until', expiresAt.toISOString(), ')');
  console.log('[cert] Fingerprint (SHA-256):', fingerprint.toString('hex'));

  return { cert: pems.cert, key: pems.private, fingerprint };
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
