/**
 * transport-client.js — Browser WebTransport client with automatic reconnect.
 *
 * WHAT this class does:
 *   1. Connects to the WebTransport server using the certificate fingerprint
 *      fetched from /api/server-info (required for self-signed certs).
 *   2. Opens a bidirectional stream as the "command channel" (SUBSCRIBE, etc.).
 *   3. Reads incoming unidirectional streams (BALL_EVENT, MATCH_STATUS, …).
 *   4. Reads datagrams (SCORE_UPDATE, MATCH_LIST heartbeats).
 *   5. Reconnects with exponential backoff if the connection drops.
 *   6. Fires callbacks registered via on(event, handler).
 *
 * DEBUGGING TIPS:
 *   • Add breakpoints in _onMessage() to inspect every decoded message.
 *   • Check the Network panel in Chrome DevTools → select WebTransport protocol.
 *   • chrome://net-export can capture QUIC-level logs.
 *   • If fingerprint mismatch: reload the page (triggers fresh /api/server-info).
 *
 * WEBTRANSPORT BROWSER SUPPORT:
 *   Chrome 97+, Edge 97+.  Firefox and Safari do NOT yet support WebTransport.
 *   The UI shows a warning banner if the API is missing.
 */

class CricketTransportClient {
  /**
   * @param {string} serverInfoUrl  — URL to fetch server connection details from
   */
  constructor(serverInfoUrl = '/api/server-info') {
    this._serverInfoUrl = serverInfoUrl;

    // WebTransport connection and associated streams
    this._transport      = null;
    this._commandWriter  = null;   // writer for the bidirectional command stream
    this._connected      = false;

    // Reconnect state
    this._reconnectDelay  = 1000;  // start at 1 s, doubles on each failure
    this._maxReconnectDelay = 30000;
    this._reconnectTimer  = null;
    this._stopped         = false;  // true after close() is called

    // Event listener registry: Map<eventName, Set<handler>>
    // Events: 'connect', 'disconnect', 'message', 'error'
    this._listeners = new Map();

    // Subscribed matchIds (so we can re-subscribe after reconnect)
    this._subscriptions = new Set();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Start connecting (call once on page load). */
  async connect() {
    this._stopped = false;
    await this._attemptConnect();
  }

  /** Gracefully close the connection and stop reconnect attempts. */
  async close() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    if (this._transport) {
      this._transport.close();
      this._transport = null;
    }
    this._connected = false;
  }

  /**
   * Subscribe to live updates for a match.
   * Sends SUBSCRIBE over the bidirectional command stream.
   * @param {string} matchId
   */
  async subscribe(matchId) {
    this._subscriptions.add(matchId);
    if (this._connected) {
      await this._sendCommand(MSG.SUBSCRIBE, { matchId });
    }
    // If not connected, the subscription will be sent on next connect
  }

  /**
   * Unsubscribe from a match.
   * @param {string} matchId
   */
  async unsubscribe(matchId) {
    this._subscriptions.delete(matchId);
    if (this._connected) {
      await this._sendCommand(MSG.UNSUBSCRIBE, { matchId });
    }
  }

  /**
   * Register an event handler.
   * @param {'connect'|'disconnect'|'message'|'error'} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return this;  // enable chaining
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  get isConnected() { return this._connected; }

  // ── Private: connection lifecycle ─────────────────────────────────────────

  async _attemptConnect() {
    // ── Fetch server connection parameters ──────────────────────────────
    let serverInfo;
    try {
      const res = await fetch(this._serverInfoUrl);
      serverInfo = await res.json();
    } catch (err) {
      this._emit('error', { message: 'Failed to fetch server info: ' + err.message });
      this._scheduleReconnect();
      return;
    }

    const { wtPort, wtPath, certHash } = serverInfo;
    const url = `https://${location.hostname}:${wtPort}${wtPath}`;

    // ── Convert hex fingerprint to Uint8Array ───────────────────────────
    // The browser needs the raw bytes of the SHA-256 hash, not a hex string.
    // We convert: "aabbcc..." → Uint8Array([0xaa, 0xbb, 0xcc, ...])
    const certHashBytes = _hexToUint8Array(certHash);

    // ── Open WebTransport connection ────────────────────────────────────
    // serverCertificateHashes lets browsers accept self-signed certs.
    // IMPORTANT: Only works for certs valid ≤ 14 days (per spec).
    console.log('[wt] Connecting to', url);
    let transport;
    try {
      transport = new WebTransport(url, {
        serverCertificateHashes: [{
          algorithm: 'sha-256',
          value:     certHashBytes.buffer,
        }],
      });

      // Wait for TLS + HTTP/3 handshake to complete
      await transport.ready;
    } catch (err) {
      console.error('[wt] Connection failed:', err);
      this._emit('error', { message: 'WebTransport connection failed: ' + err.message });
      this._scheduleReconnect();
      return;
    }

    this._transport  = transport;
    this._connected  = true;
    this._reconnectDelay = 1000;  // reset backoff on successful connect

    console.log('[wt] Connected!');
    this._emit('connect', { serverInfo });

    // ── Open command channel (bidirectional stream) ────────────────────
    // We open ONE bidirectional stream that stays alive for the session.
    // The client writes SUBSCRIBE/UNSUBSCRIBE commands to it.
    // The server writes MATCH_STATE / ERROR replies back.
    try {
      const bidiStream  = await transport.createBidirectionalStream();
      this._commandWriter = bidiStream.writable.getWriter();

      // Read replies from the server on this same bidi stream
      this._readBidiReplies(bidiStream.readable).catch(console.error);
    } catch (err) {
      console.error('[wt] Failed to open command stream:', err);
    }

    // ── Re-subscribe to any active matches (after reconnect) ───────────
    for (const matchId of this._subscriptions) {
      await this._sendCommand(MSG.SUBSCRIBE, { matchId });
    }

    // ── Start reading server-pushed streams (BALL_EVENT, etc.) ─────────
    this._readIncomingStreams(transport).catch(console.error);

    // ── Start reading datagrams (SCORE_UPDATE, MATCH_LIST) ─────────────
    this._readDatagrams(transport).catch(console.error);

    // ── Wait for close and trigger reconnect ───────────────────────────
    transport.closed
      .then(() => {
        console.log('[wt] Connection closed');
        this._connected = false;
        this._transport = null;
        this._commandWriter = null;
        this._emit('disconnect', {});
        if (!this._stopped) this._scheduleReconnect();
      })
      .catch(err => {
        console.warn('[wt] Connection closed with error:', err);
        this._connected = false;
        this._transport = null;
        this._commandWriter = null;
        this._emit('disconnect', { error: err.message });
        if (!this._stopped) this._scheduleReconnect();
      });
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    console.log(`[wt] Reconnecting in ${this._reconnectDelay / 1000}s…`);
    this._reconnectTimer = setTimeout(() => {
      this._attemptConnect();
    }, this._reconnectDelay);

    // Exponential backoff: double the delay each time, cap at max
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
  }

  // ── Private: send command via bidi stream ─────────────────────────────────

  async _sendCommand(type, payload) {
    if (!this._commandWriter) {
      console.warn('[wt] No command stream open, queuing command for later');
      return;
    }
    try {
      await this._commandWriter.write(encode(type, payload));
    } catch (err) {
      console.error('[wt] Failed to send command:', err);
    }
  }

  // ── Private: read incoming WebTransport streams ───────────────────────────

  /**
   * Reads server-initiated unidirectional streams.
   * Each stream carries ONE message (ball event, status update, etc.).
   */
  async _readIncomingStreams(transport) {
    const reader = transport.incomingUnidirectionalStreams.getReader();
    try {
      while (true) {
        const { done, value: stream } = await reader.read();
        if (done) break;

        // Read all chunks from the stream and concatenate them
        // (a single stream = one message, but could be chunked)
        this._consumeStream(stream).then(data => {
          try {
            this._onMessage(decode(data));
          } catch (err) {
            console.warn('[wt] Failed to decode stream message:', err);
          }
        });
      }
    } catch (err) {
      if (!transport.closed) console.warn('[wt] Stream reader error:', err);
    }
  }

  /**
   * Reads all bytes from a ReadableStream and returns a concatenated Uint8Array.
   *
   * WHY concatenate? WebTransport streams can arrive in multiple chunks.
   * We must reassemble them before JSON-parsing.
   */
  async _consumeStream(stream) {
    const reader = stream.getReader();
    const chunks = [];
    let totalLen = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.byteLength;
    }

    // Merge chunks into one Uint8Array
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  /**
   * Reads replies from the server on our bidirectional command stream.
   * (MATCH_STATE after SUBSCRIBE, ERROR responses, etc.)
   */
  async _readBidiReplies(readable) {
    const data = await this._consumeStream(readable);
    try {
      this._onMessage(decode(data));
    } catch (err) {
      console.warn('[wt] Failed to decode bidi reply:', err);
    }
    // Note: the server keeps the bidi stream open; we'd need to loop here
    // for a production client.  For simplicity we handle one reply per open.
    // See: _readIncomingStreams handles subsequent server → client messages.
  }

  /**
   * Reads WebTransport datagrams (SCORE_UPDATE, MATCH_LIST heartbeats).
   *
   * Datagrams are UNORDERED and UNRELIABLE — a perfect fit for live score
   * tickers where missing one update is fine (the next one arrives in ~4s).
   */
  async _readDatagrams(transport) {
    const reader = transport.datagrams.readable.getReader();
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        try {
          this._onMessage(decode(chunk));
        } catch (err) {
          console.warn('[wt] Failed to decode datagram:', err);
        }
      }
    } catch (err) {
      if (!this._stopped) console.warn('[wt] Datagram reader error:', err);
    }
  }

  // ── Private: message dispatch ─────────────────────────────────────────────

  _onMessage(msg) {
    // Compute latency for debugging (server stamps every message with `ts`)
    if (msg.ts) {
      const latencyMs = Date.now() - msg.ts;
      if (latencyMs > 200) {
        console.debug(`[wt] High latency: ${latencyMs}ms for ${msg.type}`);
      }
    }
    this._emit('message', msg);
  }

  _emit(event, data) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(data); }
      catch (err) { console.error(`[wt] Handler error for ${event}:`, err); }
    }
  }
}

// ── Utility ─────────────────────────────────────────────────────────────────

/**
 * Converts a hex string like "aabbcc" to Uint8Array([0xaa, 0xbb, 0xcc]).
 * Used to convert the cert fingerprint from /api/server-info for WebTransport.
 */
function _hexToUint8Array(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
