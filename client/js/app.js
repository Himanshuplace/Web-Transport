/**
 * app.js — Application bootstrapper: wires together the transport client,
 * state store, and UI renderers.
 *
 * FLOW:
 *   1. Check WebTransport browser support — show error if missing.
 *   2. Create store + transport client instances.
 *   3. Register message handlers on the transport client → mutations on store.
 *   4. Register store observers → UI re-renders.
 *   5. Call transport.connect() to start the WebTransport connection.
 *
 * HOW TO DEBUG end-to-end:
 *   a) Open DevTools Console — watch for [wt] and [store] log lines.
 *   b) window._store.getState() → inspect full current state.
 *   c) window._wt.subscribe('some-uuid') → manually subscribe.
 *   d) Network tab → filter by "webtransport" to see the session.
 */

// ── Browser support check ─────────────────────────────────────────────────
if (typeof WebTransport === 'undefined') {
  document.getElementById('wt-unsupported').style.display = 'block';
  document.getElementById('app').style.display = 'none';
  console.error(
    'WebTransport is not supported in this browser.\n' +
    'Use Chrome 97+ or Edge 97+ and make sure you\'re on HTTPS or localhost.'
  );
}

// ── Instantiate core objects ──────────────────────────────────────────────
const store     = new CricketStore();
const transport = new CricketTransportClient('/api/server-info');

// Expose to DevTools for manual debugging
window._store = store;
window._wt    = transport;

// ── Transport → Store: wire incoming messages ────────────────────────────
transport.on('connect', () => {
  store.setConnectionStatus('connected');
  renderConnectionStatus('connected');
  console.log('[app] WebTransport connected');
});

transport.on('disconnect', () => {
  store.setConnectionStatus('disconnected');
  renderConnectionStatus('disconnected');
  console.log('[app] WebTransport disconnected — will retry');
});

transport.on('error', ({ message }) => {
  store.setConnectionStatus('error');
  renderConnectionStatus('error');
  console.warn('[app] Transport error:', message);
});

/**
 * Central message dispatcher.
 * Every incoming WebTransport message (stream or datagram) ends up here.
 */
transport.on('message', (msg) => {
  switch (msg.type) {

    // ── MATCH_LIST: initial list of all matches ─────────────────────────
    // Arrives as a datagram immediately after connecting.
    case MSG.MATCH_LIST: {
      const matches = msg.payload.matches || [];
      const currentIds = new Set(matches.map(m => m.matchId));

      // A finished match may have been replaced — drop subscriptions to any
      // match that no longer exists so we don't keep stale state.
      for (const oldId of transport.subscriptions) {
        if (!currentIds.has(oldId)) transport.unsubscribe(oldId);
      }

      store.setMatchList(matches);

      // Subscribe to all current matches automatically (in a production app
      // you'd let the user pick). Re-subscribing to a tracked match is harmless.
      for (const m of matches) {
        transport.subscribe(m.matchId);
      }
      break;
    }

    // ── MATCH_STATE: full scorecard sent when we subscribe ─────────────
    case MSG.MATCH_STATE: {
      store.setMatchState(msg.payload);
      break;
    }

    // ── BALL_EVENT: one delivery outcome + updated scorecard ───────────
    case MSG.BALL_EVENT: {
      const { matchId, ball, scorecard } = msg.payload;

      // Update store with the full scorecard (comes with every ball)
      store.applyBallEvent(matchId, scorecard);

      // Add commentary for this ball
      const commentaryType = _commentaryType(ball);
      addCommentary(ball.commentary, commentaryType);

      break;
    }

    // ── SCORE_UPDATE: lightweight datagram ticker ──────────────────────
    // Just runs/wickets/overs — used for the match tab score badges.
    case MSG.SCORE_UPDATE: {
      store.applyScoreUpdate(msg.payload);
      break;
    }

    // ── MATCH_STATUS: innings break, match end, etc. ───────────────────
    case MSG.MATCH_STATUS: {
      store.applyMatchStatus(msg.payload);

      if (msg.payload.status === 'INNINGS_BREAK') {
        addCommentary(`INNINGS BREAK — 1st innings total: ${msg.payload.inn1Score}`, 'milestone');
      } else if (msg.payload.status === 'COMPLETED') {
        addCommentary(`MATCH OVER — ${msg.payload.result?.description}`, 'milestone');
      }
      break;
    }

    case MSG.ERROR: {
      console.error('[app] Server error:', msg.payload.message);
      break;
    }
  }
});

// ── Store → UI: register rendering callbacks ──────────────────────────────

store.on('connectionChanged', (status) => {
  renderConnectionStatus(status);
});

store.on('matchListUpdated', (matches) => {
  renderMatchTabs(
    matches,
    store.getActiveMatchId(),
    (matchId) => {
      store.setActiveMatch(matchId);
    }
  );
});

store.on('activeMatchChanged', (matchId) => {
  // Re-render tabs to highlight the selected one
  renderMatchTabs(
    store.getMatchList(),
    matchId,
    (id) => store.setActiveMatch(id)
  );
  // Render the scorecard for the newly selected match
  const match = store.getMatch(matchId);
  if (match) {
    renderScorecard(match);
    renderFallOfWickets(match);
  }
});

store.on('matchUpdated', (matchId) => {
  // Only re-render if this is the currently viewed match
  if (matchId !== store.getActiveMatchId()) return;

  const match = store.getMatch(matchId);
  renderScorecard(match);
  renderFallOfWickets(match);
});

store.on('scoreUpdated', () => {
  // Re-render match tabs to update the score badge on each tab
  renderMatchTabs(
    store.getMatchList(),
    store.getActiveMatchId(),
    (matchId) => store.setActiveMatch(matchId)
  );
});

// ── Initial render ────────────────────────────────────────────────────────
renderConnectionStatus('connecting');

// ── Start connection ──────────────────────────────────────────────────────
transport.connect().catch(err => {
  console.error('[app] Failed to start transport:', err);
});

// ── Helper: commentary type for styling ──────────────────────────────────
function _commentaryType(ball) {
  if (!ball) return 'normal';
  switch (ball.type) {
    case 'WICKET': return 'wicket';
    case 'SIX':    return 'six';
    case 'FOUR':   return 'four';
    default:       return 'normal';
  }
}
