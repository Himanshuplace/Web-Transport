/**
 * match.js — T20 match state machine.
 *
 * WHAT this class does:
 *   Manages the full lifecycle of a T20 cricket match:
 *     UPCOMING → IN_PROGRESS → INNINGS_BREAK → IN_PROGRESS (2nd innings) → COMPLETED
 *
 *   It delegates WHAT happened on each ball to engine.js, and this class is
 *   responsible for updating all the bookkeeping:
 *     — runs, wickets, extras, over counts
 *     — batsman and bowler career stats for this match
 *     — run rate, required run rate
 *     — fall of wickets, over-by-over log
 *     — deciding when an innings ends and when the match ends
 *
 * DEBUGGING tips:
 *   console.log(JSON.stringify(match.toJSON(), null, 2)) to see full state.
 *   Reduce MAX_OVERS to 5 for quick end-to-end testing.
 */

import { v4 as uuidv4 } from 'uuid';
import { simulateBall, OUTCOMES } from './engine.js';

const MAX_OVERS       = 20;
const MAX_WICKETS     = 10;
const MAX_BOWLER_OVERS = 4;

export class Match {
  constructor({ team1, team2, venue }) {
    this.matchId = uuidv4();
    this.team1   = team1;
    this.team2   = team2;
    this.venue   = venue;
    this.title   = `${team1.shortName} vs ${team2.shortName}`;

    // UPCOMING → IN_PROGRESS → INNINGS_BREAK → IN_PROGRESS → COMPLETED
    this.status = 'UPCOMING';
    this.toss   = null;
    this.innings = [null, null];
    this.currentInningsIndex = 0;
    this.result = null;
    this.recentBalls = [];

    this._doToss();
    this._startInnings(0);
    this.status = 'IN_PROGRESS';
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Simulates ONE ball delivery.
   * Returns { ballResult, inningsEnded, matchEnded }.
   * Manager calls this on a timer and broadcasts the result.
   */
  deliverBall() {
    if (this.status !== 'IN_PROGRESS') {
      throw new Error(`Cannot deliver ball — match status is "${this.status}"`);
    }

    const inn        = this._currentInnings();
    const striker    = inn.battingLine[inn.strikerIdx];
    const nonStriker = inn.battingLine[inn.nonStrikerIdx]; // eslint-disable-line no-unused-vars
    const bowler     = inn.bowlingLine[inn.currentBowlerIdx];
    const fielders   = this._fieldingSide().players.map(p => p.name);

    const result = simulateBall(
      {
        totalOvers:  inn.overs,
        ballsInOver: inn.ballsInOver,
        wickets:     inn.wickets,
        target:      inn.target,
        runsScored:  inn.runs,
      },
      striker.name,
      bowler.name,
      fielders
    );

    this._applyBallResult(result, inn, striker, bowler);

    this.recentBalls.unshift(this._summariseBall(result));
    if (this.recentBalls.length > 12) this.recentBalls.pop();

    let inningsEnded = false;
    let matchEnded   = false;

    if (this._isInningsOver(inn)) {
      inningsEnded = true;
      inn.endedAt  = Date.now();

      if (this.currentInningsIndex === 0) {
        this.status = 'INNINGS_BREAK';
      } else {
        matchEnded = true;
        this._calculateResult();
        this.status = 'COMPLETED';
      }
    }

    return { ballResult: result, inningsEnded, matchEnded };
  }

  startSecondInnings() {
    if (this.currentInningsIndex !== 0 || this.status !== 'INNINGS_BREAK') {
      throw new Error('Cannot start 2nd innings now');
    }
    this.currentInningsIndex = 1;
    this._startInnings(1);
    this.status = 'IN_PROGRESS';
  }

  toJSON() {
    return {
      matchId:        this.matchId,
      title:          this.title,
      venue:          this.venue,
      status:         this.status,
      toss:           this.toss,
      team1:          this._teamSummary(this.team1),
      team2:          this._teamSummary(this.team2),
      innings:        this.innings,
      currentInnings: this.currentInningsIndex + 1,
      recentBalls:    this.recentBalls,
      result:         this.result,
    };
  }

  toSummary() {
    const inn = this._currentInnings();
    return {
      matchId:  this.matchId,
      title:    this.title,
      venue:    this.venue.name,
      status:   this.status,
      team1:    this.team1.shortName,
      team2:    this.team2.shortName,
      score:    inn ? `${inn.runs}/${inn.wickets}` : '—',
      overs:    inn ? this._formatOvers(inn) : '—',
      result:   this.result ? this.result.description : null,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _doToss() {
    const winner   = Math.random() < 0.5 ? this.team1.id : this.team2.id;
    const decision = Math.random() < 0.5 ? 'bat' : 'field';
    this.toss = { winner, decision };
  }

  _startInnings(index) {
    const tossWinner   = this.toss.winner;
    const tossDecision = this.toss.decision;

    let battingTeam, bowlingTeam;

    if (index === 0) {
      battingTeam = tossDecision === 'bat'
        ? this._teamById(tossWinner)
        : this._otherTeam(tossWinner);
      bowlingTeam = tossDecision === 'bat'
        ? this._otherTeam(tossWinner)
        : this._teamById(tossWinner);
    } else {
      // Teams swap for 2nd innings
      battingTeam = this.innings[0].bowlingTeamId === this.team1.id ? this.team1 : this.team2;
      bowlingTeam = this.innings[0].battingTeamId === this.team1.id ? this.team1 : this.team2;
    }

    const battingLine = battingTeam.players
      .sort((a, b) => a.battingPos - b.battingPos)
      .map(p => ({
        name: p.name, role: p.role,
        runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: 0,
        status: 'yet to bat', dismissal: null,
      }));

    battingLine[0].status = 'batting';
    battingLine[1].status = 'batting';

    const bowlingLine = bowlingTeam.players
      .filter(p => p.role === 'BOWL' || p.role === 'AR')
      .map(p => ({
        name: p.name, role: p.role,
        overs: 0, maidens: 0, runs: 0, wickets: 0, economy: 0,
      }));

    this.innings[index] = {
      battingTeamId:  battingTeam.id,
      bowlingTeamId:  bowlingTeam.id,
      battingLine,
      bowlingLine,
      runs:    0,
      wickets: 0,
      overs:   0,
      ballsInOver: 0,
      extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0, total: 0 },
      strikerIdx:    0,
      nonStrikerIdx: 1,
      nextBatsmanIdx: 2,
      currentBowlerIdx: 0,
      lastBowlerIdx: null,
      runRate:          0.0,
      target:           index === 1 ? this.innings[0].runs + 1 : null,
      requiredRunRate:  null,
      fallOfWickets:    [],
      overLog:          [],
      currentOverBalls: [],
      startedAt: Date.now(),
      endedAt:   null,
    };

    this._selectNextBowler(this.innings[index]);
  }

  _applyBallResult(result, inn, striker, bowler) {
    const isWide   = result.type === OUTCOMES.WIDE;
    const isNoBall = result.type === OUTCOMES.NO_BALL;
    const isWicket = result.type === OUTCOMES.WICKET;

    const totalRunsThisBall = result.runs + result.extraRuns;
    inn.runs += totalRunsThisBall;

    if (isWide || isNoBall) {
      inn.extras[isWide ? 'wides' : 'noBalls'] += result.extraRuns;
      inn.extras.total += result.extraRuns;
    }

    bowler.runs += totalRunsThisBall;

    if (!isWide) {
      striker.runs  += result.runs;
      striker.balls += result.isLegalBall ? 1 : 0;
      if (result.type === OUTCOMES.FOUR) striker.fours++;
      if (result.type === OUTCOMES.SIX)  striker.sixes++;
      if (striker.balls > 0) {
        striker.strikeRate = +((striker.runs / striker.balls) * 100).toFixed(1);
      }
    }

    if (result.isLegalBall) {
      inn.ballsInOver++;
      inn.currentOverBalls.push(this._ballSymbol(result));
    } else {
      inn.currentOverBalls.push(isWide ? 'Wd' : 'NB');
    }

    if (isWicket && !isNoBall) {
      inn.wickets++;
      striker.status   = 'out';
      striker.dismissal = this._dismissalText(result.wicket);
      bowler.wickets++;

      inn.fallOfWickets.push({
        wicket:  inn.wickets,
        score:   `${inn.runs}/${inn.wickets}`,
        batsman: striker.name,
        over:    this._formatOvers(inn),
      });

      if (inn.nextBatsmanIdx < inn.battingLine.length) {
        const newBat = inn.battingLine[inn.nextBatsmanIdx++];
        newBat.status  = 'batting';
        inn.strikerIdx = inn.battingLine.indexOf(newBat);
      }
    }

    if (result.runs % 2 === 1) {
      [inn.strikerIdx, inn.nonStrikerIdx] = [inn.nonStrikerIdx, inn.strikerIdx];
    }

    if (inn.ballsInOver === 6) {
      inn.overLog.push({
        over:    inn.overs + 1,
        balls:   [...inn.currentOverBalls],
      });

      // A maiden is an over with no runs and no extras (wides/no-balls break maiden)
      const isMaiden = inn.currentOverBalls.every(b => b === '0' || b === 'W');
      if (isMaiden) bowler.maidens++;

      bowler.overs++;
      if (bowler.overs > 0) {
        bowler.economy = +((bowler.runs / bowler.overs)).toFixed(2);
      }

      inn.overs++;
      inn.ballsInOver  = 0;
      inn.currentOverBalls = [];

      // Swap strike at end of over
      [inn.strikerIdx, inn.nonStrikerIdx] = [inn.nonStrikerIdx, inn.strikerIdx];

      if (!this._isInningsOver(inn)) this._selectNextBowler(inn);
    }

    const totalBallsBowled = inn.overs * 6 + inn.ballsInOver;
    if (totalBallsBowled > 0) {
      inn.runRate = +((inn.runs / totalBallsBowled) * 6).toFixed(2);
    }

    if (inn.target !== null) {
      const ballsLeft  = (MAX_OVERS * 6) - totalBallsBowled;
      const runsNeeded = inn.target - inn.runs;
      inn.requiredRunRate = ballsLeft > 0 && runsNeeded > 0
        ? +((runsNeeded / ballsLeft) * 6).toFixed(2)
        : null;
    }
  }

  _isInningsOver(inn) {
    if (inn.wickets >= MAX_WICKETS) return true;
    if (inn.overs   >= MAX_OVERS)   return true;
    if (inn.target !== null && inn.runs >= inn.target) return true;
    return false;
  }

  _selectNextBowler(inn) {
    const eligible = inn.bowlingLine.filter((b, idx) =>
      b.overs < MAX_BOWLER_OVERS && idx !== inn.lastBowlerIdx
    );

    if (eligible.length === 0) {
      const fallback = inn.bowlingLine.find(b => b.overs < MAX_BOWLER_OVERS);
      if (!fallback) return;
      inn.lastBowlerIdx    = inn.currentBowlerIdx;
      inn.currentBowlerIdx = inn.bowlingLine.indexOf(fallback);
    } else {
      const choice = eligible[Math.floor(Math.random() * eligible.length)];
      inn.lastBowlerIdx    = inn.currentBowlerIdx;
      inn.currentBowlerIdx = inn.bowlingLine.indexOf(choice);
    }
  }

  _calculateResult() {
    const inn1 = this.innings[0];
    const inn2 = this.innings[1];

    if (inn2.runs >= inn2.target) {
      const wktsRemaining = MAX_WICKETS - inn2.wickets;
      const winner = inn2.battingTeamId;
      this.result = {
        winner,
        description: `${this._teamById(winner).name} won by ${wktsRemaining} wicket${wktsRemaining !== 1 ? 's' : ''}`,
      };
    } else {
      const margin = inn1.runs - inn2.runs;
      const winner = inn1.battingTeamId;
      this.result = {
        winner,
        description: margin === 0
          ? 'Match tied!'
          : `${this._teamById(winner).name} won by ${margin} run${margin !== 1 ? 's' : ''}`,
      };
    }
  }

  _currentInnings()     { return this.innings[this.currentInningsIndex]; }
  _fieldingSide()       { return this._teamById(this._currentInnings().bowlingTeamId); }
  _teamById(id)         { return this.team1.id === id ? this.team1 : this.team2; }
  _otherTeam(id)        { return this.team1.id === id ? this.team2 : this.team1; }
  _teamSummary(team)    { return { id: team.id, name: team.name, shortName: team.shortName, color: team.color }; }
  _formatOvers(inn)     { return `${inn.overs}.${inn.ballsInOver}`; }

  _summariseBall(result) {
    return {
      type:      result.type,
      runs:      result.runs,
      isExtra:   result.isExtra,
      extraRuns: result.extraRuns,
      wicket:    result.wicket,
      batsman:   result.batsman,
      bowler:    result.bowler,
    };
  }

  _ballSymbol(result) {
    switch (result.type) {
      case OUTCOMES.WICKET: return 'W';
      case OUTCOMES.FOUR:   return '4';
      case OUTCOMES.SIX:    return '6';
      case OUTCOMES.DOT:    return '0';
      default:              return String(result.runs);
    }
  }

  _dismissalText(wicket) {
    switch (wicket.type) {
      case 'caught':  return `c ${wicket.fielder} b ${wicket.bowler}`;
      case 'bowled':  return `b ${wicket.bowler}`;
      case 'lbw':     return `lbw b ${wicket.bowler}`;
      case 'run out': return `run out (${wicket.fielder})`;
      case 'stumped': return `st ${wicket.fielder} b ${wicket.bowler}`;
      default:        return wicket.type;
    }
  }
}
