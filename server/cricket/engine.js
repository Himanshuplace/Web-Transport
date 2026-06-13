/**
 * engine.js — Ball simulation engine with realistic cricket probabilities.
 *
 * WHAT this module does:
 *   Given the current match state (innings, over, required run rate, etc.) it
 *   produces a `BallResult` object describing what happened on that delivery.
 *
 * HOW the probabilities work:
 *   We model each delivery as a weighted random draw from the OUTCOME_WEIGHTS
 *   table.  The weights change depending on match situation:
 *     • Death overs (17–20): more sixes, more dot balls (bowlers try harder)
 *     • Low wickets remaining: batsmen play safer (fewer risky shots)
 *     • High RRR (required run rate): batsmen attack more
 *
 * DEBUGGING tip:
 *   Change BASE_WEIGHTS temporarily and watch the match unfold differently.
 *   e.g. set WICKET weight to 20 to make it rain wickets.
 */

// ── Outcome type constants ─────────────────────────────────────────────────────

export const OUTCOMES = {
  DOT:     'DOT',
  RUN_1:   'RUN_1',
  RUN_2:   'RUN_2',
  RUN_3:   'RUN_3',
  FOUR:    'FOUR',
  SIX:     'SIX',
  WIDE:    'WIDE',
  NO_BALL: 'NO_BALL',
  WICKET:  'WICKET',
};

export const DISMISSALS = {
  CAUGHT:  'caught',
  BOWLED:  'bowled',
  LBW:     'lbw',
  RUN_OUT: 'run out',
  STUMPED: 'stumped',
};

// ── Base probability weights (sum = 100) ──────────────────────────────────────
// Tuned to give ~7–9 RPO and ~6–7 wickets per innings (realistic T20 stats).
const BASE_WEIGHTS = {
  [OUTCOMES.DOT]:     37,
  [OUTCOMES.RUN_1]:   23,
  [OUTCOMES.RUN_2]:    9,
  [OUTCOMES.RUN_3]:    2,
  [OUTCOMES.FOUR]:    13,
  [OUTCOMES.SIX]:      5,
  [OUTCOMES.WIDE]:     4,
  [OUTCOMES.NO_BALL]:  2,
  [OUTCOMES.WICKET]:   5,
};

const DISMISSAL_WEIGHTS = [
  { type: DISMISSALS.CAUGHT,  weight: 40 },
  { type: DISMISSALS.BOWLED,  weight: 25 },
  { type: DISMISSALS.LBW,     weight: 20 },
  { type: DISMISSALS.RUN_OUT, weight: 10 },
  { type: DISMISSALS.STUMPED, weight:  5 },
];

/**
 * Picks a random item from a weighted array.
 * Algorithm: generate a random number in [0, totalWeight), then scan through
 * items subtracting weights until we go negative — that item wins.
 * This is the standard "weighted random selection" pattern.
 */
function weightedRandom(items) {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item.key ?? item.type;
  }
  return items[items.length - 1].key ?? items[items.length - 1].type;
}

/**
 * Adjusts probability weights based on the current match situation.
 */
function situationalWeights(innings) {
  const weights = { ...BASE_WEIGHTS };

  const overNumber = innings.totalOvers;
  const wickets    = innings.wickets;
  const ballsLeft  = (20 - overNumber) * 6 - innings.ballsInOver;

  // Death overs (17–20): bigger shots, harder bowling
  if (overNumber >= 16) {
    weights[OUTCOMES.SIX]    += 4;
    weights[OUTCOMES.FOUR]   += 3;
    weights[OUTCOMES.DOT]    += 3;
    weights[OUTCOMES.WICKET] += 2;
    weights[OUTCOMES.RUN_1]  -= 6;
    weights[OUTCOMES.RUN_2]  -= 6;
  }

  // Power play (overs 1–6): more boundaries, fielding restrictions
  if (overNumber < 6) {
    weights[OUTCOMES.FOUR]   += 3;
    weights[OUTCOMES.SIX]    += 1;
    weights[OUTCOMES.DOT]    -= 2;
  }

  // Low wickets: tail-enders struggle
  if (wickets >= 7) {
    weights[OUTCOMES.DOT]     += 6;
    weights[OUTCOMES.WICKET]  += 4;
    weights[OUTCOMES.SIX]     -= 4;
    weights[OUTCOMES.FOUR]    -= 4;
  }

  // 2nd innings chase: adjust based on required run rate
  if (innings.target !== null && innings.runsScored !== undefined) {
    const runsNeeded = innings.target - innings.runsScored;
    const rrr = runsNeeded > 0 && ballsLeft > 0 ? (runsNeeded / ballsLeft) * 6 : 0;

    if (rrr > 12) {
      // Desperate swinging
      weights[OUTCOMES.SIX]    += 5;
      weights[OUTCOMES.WICKET] += 4;
      weights[OUTCOMES.DOT]    -= 4;
    } else if (rrr < 6) {
      // Comfortable chase
      weights[OUTCOMES.RUN_1]  += 4;
      weights[OUTCOMES.DOT]    -= 3;
      weights[OUTCOMES.WICKET] -= 2;
    }
  }

  // Clamp all weights to >= 0
  for (const key of Object.keys(weights)) {
    weights[key] = Math.max(0, weights[key]);
  }

  return weights;
}

/**
 * Simulates a single ball delivery.
 * @returns {BallResult}
 */
export function simulateBall(innings, batsman, bowler, fielders) {
  const adjWeights = situationalWeights(innings);
  const items = Object.entries(adjWeights).map(([key, weight]) => ({ key, weight }));
  const outcomeType = weightedRandom(items);

  const result = {
    type:        outcomeType,
    runs:        0,
    isExtra:     false,
    extraRuns:   0,
    isLegalBall: true,
    wicket:      null,
    batsman,
    bowler,
    commentary:  '',
  };

  switch (outcomeType) {
    case OUTCOMES.DOT:
      result.runs = 0;
      result.commentary = generateCommentary('dot', bowler, batsman);
      break;
    case OUTCOMES.RUN_1:
      result.runs = 1;
      result.commentary = generateCommentary('single', bowler, batsman);
      break;
    case OUTCOMES.RUN_2:
      result.runs = 2;
      result.commentary = generateCommentary('two', bowler, batsman);
      break;
    case OUTCOMES.RUN_3:
      result.runs = 3;
      result.commentary = generateCommentary('three', bowler, batsman);
      break;
    case OUTCOMES.FOUR:
      result.runs = 4;
      result.commentary = generateCommentary('four', bowler, batsman);
      break;
    case OUTCOMES.SIX:
      result.runs = 6;
      result.commentary = generateCommentary('six', bowler, batsman);
      break;
    case OUTCOMES.WIDE:
      result.isExtra   = true;
      result.extraRuns = 1;
      result.isLegalBall = false;
      result.commentary = generateCommentary('wide', bowler, batsman);
      break;
    case OUTCOMES.NO_BALL:
      result.runs      = Math.random() < 0.3 ? Math.floor(Math.random() * 3) + 1 : 0;
      result.isExtra   = true;
      result.extraRuns = 1;
      result.isLegalBall = false;
      result.commentary = generateCommentary('noball', bowler, batsman);
      break;
    case OUTCOMES.WICKET: {
      result.isLegalBall = true;
      const dismissalType = weightedRandom(DISMISSAL_WEIGHTS);
      const fielder = (dismissalType === DISMISSALS.CAUGHT ||
                       dismissalType === DISMISSALS.RUN_OUT ||
                       dismissalType === DISMISSALS.STUMPED)
        ? pickRandom(fielders) : null;
      result.wicket = { type: dismissalType, fielder, batsman, bowler };
      result.commentary = generateCommentary('wicket', bowler, batsman, { dismissalType, fielder });
      break;
    }
  }

  return result;
}

// ── Commentary templates ───────────────────────────────────────────────────────

const COMMENTARY_TEMPLATES = {
  dot:    [
    (b, bat) => `${b} bowls a tight line — ${bat} defends solidly. Dot ball.`,
    (b, bat) => `Good length from ${b}. ${bat} pushed to mid-on, no run.`,
    (b, bat) => `${b} beats ${bat} outside the off stump! Excellent delivery.`,
    (b, bat) => `Blocked firmly by ${bat}. ${b} testing the patience.`,
  ],
  single: [
    (b, bat) => `Clipped off the pads by ${bat}, gets a single to square leg.`,
    (b, bat) => `${bat} pushes ${b} through covers for one.`,
    (b, bat) => `Worked to mid-wicket by ${bat}, quick single.`,
  ],
  two:    [
    (b, bat) => `Driven through the gap! ${bat} and his partner turn two.`,
    (b, bat) => `Edged past point — ${bat} and partner ran well for two.`,
    (b, bat) => `${bat} plays the late cut, good running gives them two.`,
  ],
  three:  [
    (b, bat) => `Misfield at long-on! ${bat} runs hard and gets three.`,
    (b, bat) => `Driven powerfully, the fielder fumbles — THREE runs!`,
  ],
  four:   [
    (b, bat) => `FOUR! ${bat} creams ${b} through the covers. Beautiful timing.`,
    (b, bat) => `FOUR! Pulls hard off the pads — screams to the boundary.`,
    (b, bat) => `FOUR! ${b} drops short, ${bat} rocks back and pulls.`,
    (b, bat) => `FOUR! Elegant drive by ${bat}, right through the gap.`,
    (b, bat) => `FOUR! Slapped over mid-off! ${bat} is in great form.`,
  ],
  six:    [
    (b, bat) => `SIX! ${bat} launches ${b} into the crowd! What a shot!`,
    (b, bat) => `SIX! Huge maximum over long-on from ${bat}.`,
    (b, bat) => `SIX! Effortless swing from ${bat} — straight over the bowler's head!`,
    (b, bat) => `SIX! It's gone into the second tier! ${bat} with a monstrous hit.`,
  ],
  wide:   [
    (b, _) => `Wide! ${b} strays down leg side. The umpire signals. 1 extra.`,
    (b, _) => `Too wide outside off stump — umpire calls wide.`,
  ],
  noball: [
    (b, bat) => `No-ball! ${b} overstepped. Free hit for ${bat} next ball.`,
    (b, _) => `No-ball called! ${b} was over the crease.`,
  ],
  wicket: [
    (b, bat, { dismissalType, fielder }) => {
      switch (dismissalType) {
        case 'caught':  return `OUT! ${bat} is caught by ${fielder} off ${b}! Big wicket!`;
        case 'bowled':  return `BOWLED! ${b} crashes through the gate! ${bat} is gone!`;
        case 'lbw':     return `LBW! ${b} traps ${bat} in front! The umpire raises the finger!`;
        case 'run out': return `RUN OUT! Direct hit from ${fielder}! ${bat} is short of his ground!`;
        case 'stumped': return `STUMPED! ${fielder} is lightning quick! ${bat} is a long way out!`;
        default:        return `${bat} is out! ${b} gets the wicket!`;
      }
    },
  ],
};

function generateCommentary(event, bowler, batsman, extras = {}) {
  const templates = COMMENTARY_TEMPLATES[event];
  const template  = pickRandom(templates);
  return typeof template === 'function'
    ? template(bowler, batsman, extras)
    : template;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
