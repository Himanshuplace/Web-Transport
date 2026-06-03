/**
 * ui.js — DOM rendering for the cricket score dashboard.
 *
 * DESIGN PRINCIPLES:
 *   • Pure functions: each render function takes data and returns/updates DOM.
 *   • No side effects inside render functions (no timers, no fetch calls).
 *   • All DOM manipulation happens here — app.js and store.js are data-only.
 *
 * DEBUGGING tip:
 *   Call renderScorecard(window._store.getActiveMatch()) in DevTools console
 *   to force a re-render with the current stored state.
 */

// ── Connection status banner ───────────────────────────────────────────────

function renderConnectionStatus(status) {
  const el = document.getElementById('connection-status');
  if (!el) return;

  const configs = {
    connecting:   { text: '⬤ Connecting…',         cls: 'status-connecting'   },
    connected:    { text: '⬤ Live',                 cls: 'status-connected'    },
    disconnected: { text: '⬤ Disconnected',         cls: 'status-disconnected' },
    error:        { text: '⬤ Connection error',     cls: 'status-error'        },
  };

  const cfg = configs[status] || configs.disconnected;
  el.textContent = cfg.text;
  el.className   = 'connection-status ' + cfg.cls;
}

// ── Match selector tabs ────────────────────────────────────────────────────

function renderMatchTabs(matches, activeMatchId, onSelect) {
  const container = document.getElementById('match-tabs');
  if (!container) return;

  container.innerHTML = '';

  for (const match of matches) {
    const tab = document.createElement('button');
    tab.className = 'match-tab' + (match.matchId === activeMatchId ? ' active' : '');

    const statusDot = match.status === 'IN_PROGRESS' ? '<span class="live-dot"></span>' : '';
    const score     = match._liveScore
      ? `${match._liveScore.runs}/${match._liveScore.wickets}`
      : (match.score || '—');

    tab.innerHTML = `
      <span class="tab-teams">${statusDot}${match.team1} vs ${match.team2}</span>
      <span class="tab-score">${score}</span>
    `;
    tab.addEventListener('click', () => onSelect(match.matchId));
    container.appendChild(tab);
  }
}

// ── Main scorecard ─────────────────────────────────────────────────────────

function renderScorecard(match) {
  const container = document.getElementById('scorecard');
  if (!container || !match) return;

  if (match.status === 'UPCOMING') {
    container.innerHTML = `<div class="upcoming-card">
      <h2>${match.title || 'Match'}</h2>
      <p>Toss to take place soon…</p>
    </div>`;
    return;
  }

  const inn1 = match.innings?.[0];
  const inn2 = match.innings?.[1];
  const curIdx = (match.currentInnings || 1) - 1;
  const curInn = match.innings?.[curIdx];

  if (!curInn) {
    container.innerHTML = `<div class="loading">Loading match data…</div>`;
    return;
  }

  // ── Header: team names + score + overs ──────────────────────────────────
  const battingTeam = match.innings?.[curIdx]?.battingTeamId === match.team1?.id
    ? match.team1 : match.team2;
  const bowlingTeam = battingTeam?.id === match.team1?.id ? match.team2 : match.team1;

  let headerHtml = `
    <div class="scorecard-header" style="border-left: 4px solid ${battingTeam?.color || '#fff'}">
      <div class="match-meta">
        <span class="venue-name">${match.venue?.name || ''}</span>
        <span class="innings-label">Innings ${match.currentInnings}</span>
        ${match.status === 'IN_PROGRESS' ? '<span class="live-badge">LIVE</span>' : ''}
        ${match.status === 'INNINGS_BREAK' ? '<span class="break-badge">INNINGS BREAK</span>' : ''}
        ${match.status === 'COMPLETED' ? '<span class="completed-badge">COMPLETED</span>' : ''}
      </div>
      <div class="main-score">
        <span class="batting-team-name">${battingTeam?.name || ''}</span>
        <span class="score-runs">${curInn.runs}/${curInn.wickets}</span>
        <span class="score-overs">(${curInn.overs}.${curInn.ballsInOver} ov)</span>
      </div>
      <div class="run-rates">
        <span>CRR: <strong>${curInn.runRate || '0.00'}</strong></span>
        ${curInn.target ? `<span class="target">Target: <strong>${curInn.target}</strong></span>` : ''}
        ${curInn.requiredRunRate ? `<span class="rrr">RRR: <strong>${curInn.requiredRunRate}</strong></span>` : ''}
        ${curInn.target ? `<span class="needs">Need <strong>${Math.max(0, curInn.target - curInn.runs)}</strong> off <strong>${Math.max(0, (20 - curInn.overs) * 6 - curInn.ballsInOver)}</strong> balls</span>` : ''}
      </div>
    </div>
  `;

  // ── Previous innings summary (shown when 2nd innings live) ─────────────
  let prevInnHtml = '';
  if (inn1 && match.currentInnings === 2) {
    const prevTeam = inn1.battingTeamId === match.team1?.id ? match.team1 : match.team2;
    prevInnHtml = `
      <div class="prev-innings">
        <span>${prevTeam?.name || ''} (1st innings): </span>
        <strong>${inn1.runs}/${inn1.wickets}</strong>
        <span>(${inn1.overs}.${inn1.ballsInOver} ov)</span>
      </div>
    `;
  }

  // ── Result banner ────────────────────────────────────────────────────────
  let resultHtml = '';
  if (match.result) {
    resultHtml = `<div class="result-banner">${match.result.description}</div>`;
  }

  // ── Batting table ────────────────────────────────────────────────────────
  const activeBatsmen = (curInn.battingLine || []).filter(b =>
    b.status === 'batting' || b.status === 'out'
  );

  const batRows = activeBatsmen.map(b => `
    <tr class="${b.status === 'batting' ? 'batting-now' : ''}">
      <td class="player-name">
        ${b.status === 'batting' ? '<span class="bat-icon">🏏</span> ' : ''}
        ${b.name}
        ${b.dismissal ? `<div class="dismissal">${b.dismissal}</div>` : ''}
      </td>
      <td class="stat-cell">${b.runs}</td>
      <td class="stat-cell">${b.balls}</td>
      <td class="stat-cell">${b.fours}</td>
      <td class="stat-cell">${b.sixes}</td>
      <td class="stat-cell">${b.strikeRate || '0.0'}</td>
    </tr>
  `).join('');

  const battingHtml = `
    <div class="scorecard-section">
      <table class="stats-table">
        <thead>
          <tr>
            <th class="player-col">Batter</th>
            <th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th>
          </tr>
        </thead>
        <tbody>${batRows}</tbody>
      </table>
    </div>
  `;

  // ── Bowling table ────────────────────────────────────────────────────────
  const activeBowlers = (curInn.bowlingLine || []).filter(b => b.overs > 0);

  const bowlRows = activeBowlers.map((b, i) => {
    const isCurrent = i === curInn.currentBowlerIdx;
    return `
      <tr class="${isCurrent ? 'bowling-now' : ''}">
        <td class="player-name">
          ${isCurrent ? '<span class="ball-icon">🎯</span> ' : ''}${b.name}
        </td>
        <td class="stat-cell">${b.overs}</td>
        <td class="stat-cell">${b.maidens}</td>
        <td class="stat-cell">${b.runs}</td>
        <td class="stat-cell">${b.wickets}</td>
        <td class="stat-cell">${b.economy || '0.00'}</td>
      </tr>
    `;
  }).join('');

  const bowlingHtml = `
    <div class="scorecard-section">
      <table class="stats-table">
        <thead>
          <tr>
            <th class="player-col">Bowler</th>
            <th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th>
          </tr>
        </thead>
        <tbody>${bowlRows}</tbody>
      </table>
    </div>
  `;

  // ── Recent balls (over-in-progress) ─────────────────────────────────────
  const recentBallHtml = renderRecentBallsHtml(match.recentBalls || [], curInn.currentOverBalls || []);

  container.innerHTML = headerHtml + prevInnHtml + resultHtml + recentBallHtml + battingHtml + bowlingHtml;
}

// ── Recent balls widget ────────────────────────────────────────────────────

function renderRecentBallsHtml(recentBalls, currentOverBalls) {
  const ballSymbolHtml = (symbol) => {
    let cls = 'ball-dot';
    if (symbol === 'W')     cls = 'ball-wicket';
    else if (symbol === '4') cls = 'ball-four';
    else if (symbol === '6') cls = 'ball-six';
    else if (symbol === 'Wd' || symbol === 'NB') cls = 'ball-extra';
    else if (symbol !== '0') cls = 'ball-runs';
    return `<span class="ball-symbol ${cls}">${symbol}</span>`;
  };

  const currentOverHtml = currentOverBalls.length > 0
    ? `<div class="current-over">
         <span class="over-label">This over:</span>
         ${currentOverBalls.map(ballSymbolHtml).join('')}
       </div>`
    : '';

  return `<div class="recent-balls">${currentOverHtml}</div>`;
}

// ── Commentary feed ────────────────────────────────────────────────────────

function addCommentary(text, type = 'normal') {
  const feed = document.getElementById('commentary-feed');
  if (!feed) return;

  const item = document.createElement('div');
  item.className = `commentary-item commentary-${type}`;

  const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  item.innerHTML = `<span class="commentary-time">${time}</span> ${escapeHtml(text)}`;

  // Insert at top (latest commentary first)
  feed.insertBefore(item, feed.firstChild);

  // Keep only the last 50 commentary items to prevent DOM bloat
  while (feed.children.length > 50) {
    feed.removeChild(feed.lastChild);
  }

  // Animate entry
  item.style.opacity = '0';
  item.style.transform = 'translateY(-8px)';
  requestAnimationFrame(() => {
    item.style.transition = 'all 0.3s ease';
    item.style.opacity = '1';
    item.style.transform = 'translateY(0)';
  });
}

// ── Fall of wickets ────────────────────────────────────────────────────────

function renderFallOfWickets(match) {
  const container = document.getElementById('fall-of-wickets');
  if (!container || !match) return;

  const curIdx = (match.currentInnings || 1) - 1;
  const curInn = match.innings?.[curIdx];
  if (!curInn?.fallOfWickets?.length) {
    container.innerHTML = '<p class="no-data">No wickets yet</p>';
    return;
  }

  const fowHtml = curInn.fallOfWickets.map(fw => `
    <span class="fow-item">${fw.score} (${fw.batsman}, ${fw.over} ov)</span>
  `).join(' • ');

  container.innerHTML = `<div class="fow-list">${fowHtml}</div>`;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}
