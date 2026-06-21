/**
 * store.js — Client-side state store with observer pattern.
 *
 * WHY a store?
 *   Multiple UI components (match cards, scorecard, recent balls, over log)
 *   need to react to the same incoming data.  Instead of passing data around
 *   as function arguments, we centralise state here and let each component
 *   subscribe to only the changes it cares about.
 *
 *   This is the same idea behind Redux / Zustand — just much simpler.
 *
 * HOW to add a new UI component:
 *   1. Call `store.on('matchUpdated', (matchId) => renderMyWidget(store.getMatch(matchId)))`
 *   2. Your callback fires whenever that match's data changes.
 *
 * DEBUGGING tip:
 *   In DevTools console:  window._store.getState()
 *   You'll see the full current state of all matches and connection status.
 */

class CricketStore {
  constructor() {
    // Map<matchId, matchObject> — the source of truth for all match data
    this._matches = new Map();

    // array of brief match summaries (for the match selector)
    this._matchList = [];

    // WebTransport connection status
    this._connectionStatus = 'disconnected';  // 'connecting' | 'connected' | 'disconnected'

    // Currently viewed match (for the main scorecard panel)
    this._activeMatchId = null;

    // Event listeners: Map<eventName, Set<fn>>
    this._listeners = new Map();
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  getMatch(matchId) { return this._matches.get(matchId) || null; }

  /**
   * Returns summary objects for all matches, always using the freshest data.
   *
   * WHY not just return `_matchList`?
   *   `_matchList` is seeded from the MATCH_LIST message (summary objects).
   *   Once MATCH_STATE and SCORE_UPDATE messages arrive, the richer data lives
   *   in `_matches`.  Deriving summaries from `_matches` ensures the match
   *   tabs always show the latest run/wicket count.
   *
   *   We normalise team1/team2 to shortName strings here so that renderMatchTabs
   *   doesn't need to handle both "string" and "object with .shortName" cases.
   */
  getMatchList() {
    if (this._matches.size === 0) return this._matchList;

    return Array.from(this._matches.values()).map(m => {
      // team1/team2 is a string (shortName) in summaries but a full object in
      // MATCH_STATE — normalise to string for the tab renderer.
      const t1 = typeof m.team1 === 'string' ? m.team1 : m.team1?.shortName || '';
      const t2 = typeof m.team2 === 'string' ? m.team2 : m.team2?.shortName || '';
      const liveScore = m._liveScore;

      return {
        matchId: m.matchId,
        title:   m.title || `${t1} vs ${t2}`,
        team1:   t1,
        team2:   t2,
        status:  m.status,
        score:   liveScore ? `${liveScore.runs}/${liveScore.wickets}` : (m.score || '—'),
        overs:   liveScore ? liveScore.overs : (m.overs || '—'),
      };
    });
  }

  getStatus() { return this._connectionStatus; }
  getActiveMatchId()  { return this._activeMatchId; }
  getActiveMatch()    { return this._matches.get(this._activeMatchId) || null; }

  getState() {
    return {
      matchList:        this._matchList,
      matches:          Object.fromEntries(this._matches),
      connectionStatus: this._connectionStatus,
      activeMatchId:    this._activeMatchId,
    };
  }

  // ── Mutations (called by app.js when messages arrive) ────────────────────

  setMatchList(matches) {
    this._matchList = matches;

    const incomingIds = new Set(matches.map(m => m.matchId));

    // Prune matches that no longer exist (a completed match was replaced).
    for (const id of [...this._matches.keys()]) {
      if (!incomingIds.has(id)) this._matches.delete(id);
    }

    // Seed any new matches with their summary (full state arrives via MATCH_STATE).
    for (const m of matches) {
      if (!this._matches.has(m.matchId)) {
        this._matches.set(m.matchId, m);
      }
    }

    // If the active match was just pruned, switch to another so the scorecard
    // doesn't go blank.
    if (this._activeMatchId && !incomingIds.has(this._activeMatchId)) {
      this.setActiveMatch(matches[0]?.matchId || null);
    }

    this._emit('matchListUpdated', matches);
  }

  setMatchState(matchState) {
    this._matches.set(matchState.matchId, matchState);
    this._emit('matchUpdated', matchState.matchId);
    // If this is the first full state and no active match selected, auto-select
    if (!this._activeMatchId) {
      this.setActiveMatch(matchState.matchId);
    }
  }

  applyBallEvent(matchId, scorecard) {
    // The server sends the full updated scorecard with every ball event,
    // so we just replace the stored state.  In a high-frequency system
    // you'd apply a diff instead to save allocation.
    this._matches.set(matchId, scorecard);
    this._emit('matchUpdated', matchId);
    this._emit('ballDelivered', matchId);
  }

  applyScoreUpdate(update) {
    // Datagram-based lightweight update: only runs/wickets/overs
    const existing = this._matches.get(update.matchId);
    if (existing) {
      // Merge the lightweight update into the existing state
      // (don't overwrite the full scorecard — the bidi stream will do that)
      existing._liveScore = {
        runs:    update.runs,
        wickets: update.wickets,
        overs:   update.overs,
        target:  update.target,
      };
    }
    this._emit('scoreUpdated', update.matchId);
  }

  applyMatchStatus(update) {
    const existing = this._matches.get(update.matchId);
    if (existing) {
      existing.status = update.status;
      if (update.result) existing.result = update.result;
    }
    this._emit('matchStatusChanged', update.matchId);
    this._emit('matchUpdated', update.matchId);
  }

  setConnectionStatus(status) {
    this._connectionStatus = status;
    this._emit('connectionChanged', status);
  }

  setActiveMatch(matchId) {
    this._activeMatchId = matchId;
    this._emit('activeMatchChanged', matchId);
  }

  // ── Observer ──────────────────────────────────────────────────────────────

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return this;
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  _emit(event, data) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    for (const fn of handlers) {
      try { fn(data); }
      catch (err) { console.error('[store] Handler error:', err); }
    }
  }
}
