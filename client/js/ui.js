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
    connecting:   { text: 'Connecting…',     cls: 'status-connecting'   },
    connected:    { text: 'Live',             cls: 'status-connected'    },
    disconnected: { text: 'Disconnected',     cls: 'status-disconnected' },
    error:        { text: 'Connection error', cls: 'status-error'        },
  };

  const cfg = configs[status] || configs.disconnected;
  el.className = 'connection-status ' + cfg.cls;
  el.innerHTML = `<span class="status-dot"></span>${cfg.text}`;
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
    // `score` is already normalised by store.getMatchList() — just use it directly.
    const score = match.score || '—';

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

  const inn1   = match.innings?.[0];
  const inn2   = match.innings?.[1];
  const curIdx = (match.currentInnings || 1) - 1;
  const curInn = match.innings?.[curIdx];

  if (!curInn) {
    container.innerHTML = `<div class="loading">Loading match data…</div>`;
    return;
  }

  // ── Header: team names + score + overs ──────────────────────────────────
  const battingTeam = curInn.battingTeamId === match.team1?.id ? match.team1 : match.team2;

  // ── Toss info strip ──────────────────────────────────────────────────────
  // "Toss: Mumbai Stars won and chose to bat"
  // This is a cricket-standard piece of info shown above every scorecard.
  let tossHtml = '';
  if (match.toss) {
    const tossWinner = match.toss.winner === match.team1?.id
      ? match.team1?.name : match.team2?.name;
    tossHtml = `
      <div class="toss-info">
        Toss: <strong>${escapeHtml(tossWinner || '')}</strong>
        won and elected to
        <strong>${match.toss.decision === 'bat' ? 'bat' : 'bowl'}</strong> first
      </div>
    `;
  }

  const headerHtml = `
    <div class="scorecard-header">
      <div class="match-meta">
        <span class="venue-name">${escapeHtml(match.venue?.name || '')}</span>
        <span class="innings-label">Innings ${match.currentInnings}</span>
        ${match.status === 'IN_PROGRESS'   ? '<span class="live-badge">LIVE</span>'               : ''}
        ${match.status === 'INNINGS_BREAK' ? '<span class="break-badge">INNINGS BREAK</span>'     : ''}
        ${match.status === 'COMPLETED'     ? '<span class="completed-badge">COMPLETED</span>'     : ''}
      </div>
      <div class="main-score">
        <span class="batting-team-name">${escapeHtml(battingTeam?.name || '')}</span>
        <span class="score-runs">${curInn.runs}/${curInn.wickets}</span>
        <span class="score-overs">(${curInn.overs}.${curInn.ballsInOver} ov)</span>
      </div>
      <div class="run-rates">
        <span>CRR: <strong>${curInn.runRate || '0.00'}</strong></span>
        ${curInn.target
          ? `<span class="target">Target: <strong>${curInn.target}</strong></span>` : ''}
        ${curInn.requiredRunRate
          ? `<span class="rrr">RRR: <strong>${curInn.requiredRunRate}</strong></span>` : ''}
        ${curInn.target
          ? `<span class="needs">Need <strong>${Math.max(0, curInn.target - curInn.runs)}</strong>
             off <strong>${Math.max(0, (20 - curInn.overs) * 6 - curInn.ballsInOver)}</strong> balls</span>` : ''}
      </div>
    </div>
    ${tossHtml}
  `;

  // ── Previous innings summary (shown when 2nd innings is live) ─────────
  let prevInnHtml = '';
  if (inn1 && match.currentInnings === 2) {
    const prevTeam = inn1.battingTeamId === match.team1?.id ? match.team1 : match.team2;
    prevInnHtml = `
      <div class="prev-innings">
        <span>${escapeHtml(prevTeam?.name || '')} (1st innings):</span>
        <strong>${inn1.runs}/${inn1.wickets}</strong>
        <span>(${inn1.overs}.${inn1.ballsInOver} ov)</span>
        <span class="prev-extras">Extras: ${inn1.extras?.total || 0}</span>
      </div>
    `;
  }

  // ── Result banner ────────────────────────────────────────────────────────
  const resultHtml = match.result
    ? `<div class="result-banner">${escapeHtml(match.result.description)}</div>`
    : '';

  // ── Current over ball display ─────────────────────────────────────────
  const recentBallHtml = renderRecentBallsHtml(curInn.currentOverBalls || []);

  // ── Batting table ────────────────────────────────────────────────────────
  const battingHtml = renderBattingTable(curInn);

  // ── Bowling table ────────────────────────────────────────────────────────
  const bowlingHtml = renderBowlingTable(curInn);

  // ── Over-by-over log ─────────────────────────────────────────────────────
  const overLogHtml = renderOverLog(curInn);

  container.innerHTML = headerHtml + prevInnHtml + resultHtml
    + recentBallHtml + battingHtml + bowlingHtml + overLogHtml;
}

// ── Batting table ──────────────────────────────────────────────────────────

function renderBattingTable(inn) {
  const activeBatsmen = (inn.battingLine || []).filter(b =>
    b.status === 'batting' || b.status === 'out'
  );

  const batRows = activeBatsmen.map(b => `
    <tr class="${b.status === 'batting' ? 'batting-now' : ''}">
      <td class="player-name">
        ${escapeHtml(b.name)}${b.status === 'batting' ? ' *' : ''}
        ${b.dismissal ? `<div class="dismissal">${escapeHtml(b.dismissal)}</div>` : ''}
      </td>
      <td class="stat-cell">${b.runs}</td>
      <td class="stat-cell">${b.balls}</td>
      <td class="stat-cell">${b.fours}</td>
      <td class="stat-cell">${b.sixes}</td>
      <td class="stat-cell">${b.strikeRate || '0.0'}</td>
    </tr>
  `).join('');

  // ── Extras row — always shown in cricket scorecards ─────────────────────
  // Standard format: Extras (W x, NB y) — Total z
  const ex   = inn.extras || {};
  const extParts = [];
  if (ex.wides   > 0) extParts.push(`w ${ex.wides}`);
  if (ex.noBalls > 0) extParts.push(`nb ${ex.noBalls}`);
  if (ex.byes    > 0) extParts.push(`b ${ex.byes}`);
  if (ex.legByes > 0) extParts.push(`lb ${ex.legByes}`);
  const extStr = extParts.length ? ` (${extParts.join(', ')})` : '';

  const extrasRow = `
    <tr class="extras-row">
      <td class="player-name extras-label">Extras${extStr}</td>
      <td class="stat-cell extras-total" colspan="5">${ex.total || 0}</td>
    </tr>
    <tr class="total-row">
      <td class="player-name total-label">Total</td>
      <td class="stat-cell total-score" colspan="5">
        ${inn.runs}/${inn.wickets}
        <span class="total-meta">(${inn.overs}.${inn.ballsInOver} ov, RR: ${inn.runRate || '0.00'})</span>
      </td>
    </tr>
  `;

  // ── "Yet to bat" summary ─────────────────────────────────────────────────
  const yetToBat = (inn.battingLine || []).filter(b => b.status === 'yet to bat');
  const yetHtml = yetToBat.length
    ? `<tr class="yet-to-bat-row"><td colspan="6" class="yet-label">
         Yet to bat: ${yetToBat.map(b => escapeHtml(b.name)).join(', ')}
       </td></tr>`
    : '';

  return `
    <div class="scorecard-section">
      <table class="stats-table">
        <thead>
          <tr><th class="player-col">Batter</th>
            <th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th>
          </tr>
        </thead>
        <tbody>${batRows}${extrasRow}${yetHtml}</tbody>
      </table>
    </div>
  `;
}

// ── Bowling table ──────────────────────────────────────────────────────────

function renderBowlingTable(inn) {
  const activeBowlers = (inn.bowlingLine || []).filter(b => b.overs > 0);
  if (activeBowlers.length === 0) return '';

  const bowlRows = activeBowlers.map((b, i) => {
    const isCurrent = i === inn.currentBowlerIdx;
    return `
      <tr class="${isCurrent ? 'bowling-now' : ''}">
        <td class="player-name">
          ${escapeHtml(b.name)}${isCurrent ? ' *' : ''}
        </td>
        <td class="stat-cell">${b.overs}</td>
        <td class="stat-cell">${b.maidens}</td>
        <td class="stat-cell">${b.runs}</td>
        <td class="stat-cell">${b.wickets}</td>
        <td class="stat-cell">${b.economy || '0.00'}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="scorecard-section">
      <table class="stats-table">
        <thead>
          <tr><th class="player-col">Bowler</th>
            <th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th>
          </tr>
        </thead>
        <tbody>${bowlRows}</tbody>
      </table>
    </div>
  `;
}

// ── Over-by-over log ───────────────────────────────────────────────────────

/**
 * Renders a compact over-by-over run summary.
 *
 * Each completed over shows:
 *   Over 1: [ 0 1 4 0 W 1 ]  (6 ball symbols)
 *
 * WHY show this?
 *   Classic cricket coverage always has an over-by-over breakdown.  It lets
 *   you spot momentum shifts: a cluster of 4s/6s in one over, a maiden, etc.
 *
 * DEBUGGING tip:
 *   If balls are missing or duplicated here, check `_applyBallResult` in
 *   match.js — specifically the `inn.currentOverBalls` push logic.
 */
function renderOverLog(inn) {
  const log = inn.overLog || [];
  if (log.length === 0) return '';

  const ballSymbol = (s) => {
    let cls = 'ball-dot';
    if (s === 'W')              cls = 'ball-wicket';
    else if (s === '4')         cls = 'ball-four';
    else if (s === '6')         cls = 'ball-six';
    else if (s === 'Wd' || s === 'NB') cls = 'ball-extra';
    else if (s !== '0')         cls = 'ball-runs';
    return `<span class="ball-symbol ${cls} ball-sm">${s}</span>`;
  };

  // Show last 10 overs (oldest → newest)
  const recent = log.slice(-10);

  const rows = recent.map(ov => {
    const ballsHtml = (ov.balls || []).map(ballSymbol).join('');
    // Sum legal ball runs (excluding 'W', 'Wd', 'NB')
    const runs = (ov.balls || []).reduce((s, b) => {
      if (b === 'W' || b === 'Wd' || b === 'NB') return s;
      return s + (Number(b) || 0);
    }, 0);
    const wickets = (ov.balls || []).filter(b => b === 'W').length;
    return `
      <tr>
        <td class="over-num">Ov ${ov.over}</td>
        <td class="over-balls">${ballsHtml}</td>
        <td class="over-runs">${runs}${wickets ? ` <span class="over-wkt">(${wickets}W)</span>` : ''}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="scorecard-section over-log-section">
      <div class="section-title">Over-by-Over</div>
      <table class="over-log-table">
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ── Recent balls (current over in progress) ────────────────────────────────

function renderRecentBallsHtml(currentOverBalls) {
  const ballSymbolHtml = (symbol) => {
    let cls = 'ball-dot';
    if (symbol === 'W')                    cls = 'ball-wicket';
    else if (symbol === '4')               cls = 'ball-four';
    else if (symbol === '6')               cls = 'ball-six';
    else if (symbol === 'Wd' || symbol === 'NB') cls = 'ball-extra';
    else if (symbol !== '0')               cls = 'ball-runs';
    return `<span class="ball-symbol ${cls}">${symbol}</span>`;
  };

  if (currentOverBalls.length === 0) return '';

  return `
    <div class="recent-balls">
      <span class="over-label">This over:</span>
      ${currentOverBalls.map(ballSymbolHtml).join('')}
    </div>
  `;
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
  const heading   = document.getElementById('fow-heading');
  if (!container || !match) return;

  const curIdx = (match.currentInnings || 1) - 1;
  const curInn = match.innings?.[curIdx];

  if (!curInn?.fallOfWickets?.length) {
    container.innerHTML = '';
    if (heading) heading.style.display = 'none';
    return;
  }

  if (heading) heading.style.display = 'block';
  const fowHtml = curInn.fallOfWickets.map(fw =>
    `<span class="fow-item">${fw.score} (${escapeHtml(fw.batsman)}, ${fw.over} ov)</span>`
  ).join(' &nbsp;·&nbsp; ');

  container.innerHTML = `<div class="fow-list" style="padding:0 14px 10px">${fowHtml}</div>`;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}
