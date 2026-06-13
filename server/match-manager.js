/**
 * match-manager.js — Orchestrates multiple concurrent matches and broadcasts
 * live events to WebTransport subscriber sessions.
 *
 * RESPONSIBILITIES:
 *   1. Create and start N simultaneous T20 matches on a timer.
 *   2. Track which client sessions are subscribed to which match.
 *   3. Deliver ball events via:
 *        • Unidirectional stream  → BALL_EVENT + SCORE_UPDATE
 *        • Datagram               → lightweight SCORE_UPDATE heartbeat
 *   4. Send full MATCH_STATE to a session when it first subscribes.
 *   5. Clean up dead sessions automatically.
 *
 * DEBUGGING tip:
 *   Add `console.log('[manager] tick', id)` inside _tick() to watch every
 *   ball delivery cycle, or reduce BALL_INTERVAL_MS in config.js.
 */

import { Match }       from './cricket/match.js';
import { getMatchups } from './cricket/teams.js';
import { encode, MSG } from './protocol.js';
import {
  BALL_INTERVAL_MS,
  INNINGS_BREAK_MS,
  MAX_CONCURRENT_MATCHES,
} from './config.js';

export class MatchManager {
  constructor() {
    this.matches     = new Map();   // Map<matchId, Match>
    this.subscribers = new Map();   // Map<matchId, Set<Session>>
    this.timers      = new Map();   // Map<matchId, Timeout>
  }

  start() {
    const matchups = getMatchups(MAX_CONCURRENT_MATCHES);
    for (const { team1, team2, venue } of matchups) {
      const match = new Match({ team1, team2, venue });
      this.matches.set(match.matchId, match);
      this.subscribers.set(match.matchId, new Set());
      console.log(`[manager] Match created: ${match.title} (${match.matchId})`);
      this._startTicker(match.matchId);
    }
    console.log(`[manager] ${this.matches.size} matches running`);
  }

  stop() {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.matches.clear();
    this.subscribers.clear();
    console.log('[manager] All matches stopped');
  }

  subscribe(matchId, session) {
    const match = this.matches.get(matchId);
    if (!match) return null;
    this.subscribers.get(matchId).add(session);
    console.log(`[manager] Subscribed to ${match.title} (total: ${this.subscribers.get(matchId).size})`);
    return match.toJSON();
  }

  unsubscribe(matchId, session) {
    this.subscribers.get(matchId)?.delete(session);
  }

  removeSession(session) {
    for (const [matchId, subs] of this.subscribers) {
      if (subs.delete(session)) {
        console.log(`[manager] Session removed from match ${matchId}`);
      }
    }
  }

  getMatchList() {
    return Array.from(this.matches.values()).map(m => m.toSummary());
  }

  // ── Private: delivery ticker ───────────────────────────────────────────────

  _startTicker(matchId) {
    const timer = setInterval(() => this._tick(matchId), BALL_INTERVAL_MS);
    this.timers.set(matchId, timer);
  }

  async _tick(matchId) {
    const match = this.matches.get(matchId);
    if (!match || match.status === 'COMPLETED') {
      clearInterval(this.timers.get(matchId));
      this.timers.delete(matchId);
      console.log(`[manager] Match ${matchId} completed — timer stopped`);
      return;
    }

    if (match.status === 'INNINGS_BREAK') return;

    let ballResult, inningsEnded, matchEnded;
    try {
      ({ ballResult, inningsEnded, matchEnded } = match.deliverBall());
    } catch (err) {
      console.error(`[manager] deliverBall error:`, err.message);
      return;
    }

    const subs = this.subscribers.get(matchId) || new Set();

    // ── Broadcast BALL_EVENT via unidirectional stream ──────────────────────
    // A new stream per ball means each ball's data is independent and ordered.
    // Server-initiated unidirectional streams carry reliable, ordered data.
    await this._broadcastStream(subs, MSG.BALL_EVENT, {
      matchId,
      ball:      ballResult,
      scorecard: match.toJSON(),
    });

    // ── Broadcast SCORE_UPDATE as datagram ─────────────────────────────────
    // Datagrams are unreliable/unordered (UDP-like) — fine for quick tickers.
    // The UI uses these to update the match tab score badge between full updates.
    const inn = match.innings[match.currentInningsIndex];
    await this._broadcastDatagram(subs, MSG.SCORE_UPDATE, {
      matchId,
      team1:   match.team1.shortName,
      team2:   match.team2.shortName,
      runs:    inn ? inn.runs    : 0,
      wickets: inn ? inn.wickets : 0,
      overs:   inn ? `${inn.overs}.${inn.ballsInOver}` : '0.0',
      target:  inn ? inn.target : null,
    });

    if (inningsEnded && !matchEnded) {
      await this._broadcastStream(subs, MSG.MATCH_STATUS, {
        matchId,
        status:    'INNINGS_BREAK',
        inn1Score: `${match.innings[0].runs}/${match.innings[0].wickets}`,
      });

      setTimeout(() => {
        if (!this.matches.has(matchId)) return;
        match.startSecondInnings();
        this._broadcastStream(
          this.subscribers.get(matchId),
          MSG.MATCH_STATUS,
          { matchId, status: 'IN_PROGRESS', innings: 2 }
        );
      }, INNINGS_BREAK_MS);
    }

    if (matchEnded) {
      await this._broadcastStream(subs, MSG.MATCH_STATUS, {
        matchId,
        status:    'COMPLETED',
        result:    match.result,
        scorecard: match.toJSON(),
      });
    }
  }

  // ── Private: WebTransport broadcast helpers ────────────────────────────────

  /**
   * Sends a message to all sessions via a new server-initiated unidirectional stream.
   *
   * WHY a new stream per message?
   *   HTTP/3 multiplexes streams independently — a new stream per ball means
   *   no head-of-line blocking.  If stream N is slow, stream N+1 can still
   *   arrive at the browser immediately.
   */
  async _broadcastStream(sessions, type, payload) {
    const data = encode(type, payload);
    await Promise.allSettled(
      [...sessions].map(s => this._sendViaStream(s, data))
    );
  }

  async _sendViaStream(session, data) {
    try {
      // createUnidirectionalStream() opens a new HTTP/3 send stream
      const stream = await session.createUnidirectionalStream();
      const writer = stream.getWriter();
      await writer.write(data);
      await writer.close();
    } catch (err) {
      if (!String(err.message).includes('closed')) {
        console.warn('[manager] Stream send failed:', err.message);
      }
    }
  }

  /**
   * Sends a datagram to all sessions.
   * Datagrams fit in one QUIC packet (<1200 bytes) — perfect for score tickers.
   */
  async _broadcastDatagram(sessions, type, payload) {
    const data = encode(type, payload);
    await Promise.allSettled(
      [...sessions].map(s => this._sendViaDatagram(s, data))
    );
  }

  async _sendViaDatagram(session, data) {
    try {
      const writer = session.datagrams.writable.getWriter();
      await writer.write(data);
      writer.releaseLock();
    } catch (err) {
      if (!String(err.message).includes('closed')) {
        console.warn('[manager] Datagram send failed:', err.message);
      }
    }
  }
}
