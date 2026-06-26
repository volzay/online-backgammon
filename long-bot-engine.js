/* generated from bot-engine/long/*.ts */
(function () {
  'use strict';

/* bot-engine/long/metrics.ts */

const LONG_PATHS = {
  white: [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  dark: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13],
};

const HEAD_LANDING_DICE = [1, 3, 5, 6];

function opponentOf(color) {
  return color === 'white' ? 'dark' : 'white';
}

function pathFor(color) {
  return LONG_PATHS[color] || LONG_PATHS.white;
}

function headPoint(color) {
  return pathFor(color)[0];
}

function pathPos(color, point) {
  return pathFor(color).indexOf(Number(point));
}

function stackAt(state, point) {
  return state.points?.[point] || state.points?.[String(point)] || null;
}

function colorAt(state, point) {
  return stackAt(state, point)?.color || null;
}

function countAt(state, point, color = null) {
  const stack = stackAt(state, point);
  if (!stack) return 0;
  if (color && stack.color !== color) return 0;
  return Number(stack.count) || 0;
}

function offCount(state, color) {
  return Number(state.off?.[color]) || 0;
}

function checkersInTrackRange(state, color, start, end) {
  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color) return total;
    const pos = pathPos(color, Number(point));
    return total + (pos >= start && pos <= end ? stack.count : 0);
  }, 0);
}

function occupiedInTrackRange(state, color, start, end) {
  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color) return total;
    const pos = pathPos(color, Number(point));
    return total + (pos >= start && pos <= end ? 1 : 0);
  }, 0);
}

function madePointsInTrackRange(state, color, start, end) {
  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color || stack.count < 2) return total;
    const pos = pathPos(color, Number(point));
    return total + (pos >= start && pos <= end ? 1 : 0);
  }, 0);
}

function outsideHomeCount(state, color) {
  return checkersInTrackRange(state, color, 0, 17);
}

function entryZoneOutsideCount(state, color) {
  return checkersInTrackRange(state, color, 12, 17);
}

function homeBoardCount(state, color) {
  return checkersInTrackRange(state, color, 18, 23);
}

function homeTotalCount(state, color) {
  return homeBoardCount(state, color) + offCount(state, color);
}

function homeReady(state, color) {
  return outsideHomeCount(state, color) === 0;
}

function headCheckers(state, color) {
  return countAt(state, headPoint(color), color);
}

function pipsFor(state, color) {
  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color) return total;
    const pos = pathPos(color, Number(point));
    if (pos < 0) return total;
    return total + stack.count * Math.max(0, 24 - pos);
  }, 0);
}

function distributionPenalty(state, color) {
  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color) return total;
    const pos = pathPos(color, Number(point));
    const count = Number(stack.count) || 0;
    const limit = pos >= 18 ? 3 : 3;
    const excess = Math.max(0, count - limit);
    const tower = Math.max(0, count - 5);
    const head = Number(point) === pathFor(color)[0] ? 1.35 : 1;
    return total + head * (excess * excess * 8 + tower * tower * 28);
  }, 0);
}

function headLandingSupportScore(state, color) {
  const head = headPoint(color);
  const headCount = countAt(state, head, color);
  if (headCount <= 2) return 0;
  const pressure = 1 + Math.max(0, headCount - 4) / 5;

  return HEAD_LANDING_DICE.reduce((score, die) => {
    const target = pathFor(color)[die];
    const stack = target ? stackAt(state, target) : null;
    const dieWeight = headLandingDieWeight(die);
    if (stack?.color === color) {
      const count = Number(stack.count) || 0;
      const blockValue = 1.72 + Math.min(2, Math.max(0, count - 1)) * 0.16;
      const stackPenalty = Math.max(0, count - 3) * 0.24;
      return score + dieWeight * Math.max(0.8, blockValue - stackPenalty);
    }
    if (!stack) return score - dieWeight * 0.95;
    return score - dieWeight * 2.4;
  }, 0) * pressure;
}

function headLandingExposureRisk(state, color) {
  const headCount = headCheckers(state, color);
  if (headCount <= 2) return 0;
  const opponent = opponentOf(color);
  const pressure = 1 + Math.max(0, headCount - 4) / 4;

  return HEAD_LANDING_DICE.reduce((risk, die) => {
    const target = pathFor(color)[die];
    const stack = target ? stackAt(state, target) : null;
    if (stack?.color === color) return risk;
    const dieWeight = headLandingDieWeight(die);
    const occupiedByOpponent = stack?.color === opponent;
    const reachable = !occupiedByOpponent && canReachPoint(state, opponent, target);
    return risk + dieWeight * pressure * (
      occupiedByOpponent ? 8.5 : 3.1 + (reachable ? 4.7 : 0)
    );
  }, 0);
}

function headLandingBreakRisk(before, after, color) {
  const headCount = headCheckers(before, color);
  if (headCount <= 2) return 0;
  const opponent = opponentOf(color);
  const pressure = 1 + Math.max(0, headCount - 4) / 4;

  return HEAD_LANDING_DICE.reduce((risk, die) => {
    const target = pathFor(color)[die];
    const beforeStack = stackAt(before, target);
    const afterStack = stackAt(after, target);
    if (beforeStack?.color !== color || afterStack?.color === color) return risk;
    const reachable = canReachPoint(after, opponent, target);
    return risk + headLandingDieWeight(die) * pressure * (reachable ? 11 : 6.2);
  }, 0);
}

function headLandingDieWeight(die) {
  if (die === 1) return 3.45;
  if (die === 3) return 2.45;
  if (die === 5) return 2.25;
  return 1.75;
}

function canReachPoint(state, color, target) {
  const targetPos = pathPos(color, target);
  if (targetPos < 0) return false;
  return Object.entries(state.points || {}).some(([point, stack]) => {
    if (stack.color !== color) return false;
    const pos = pathPos(color, Number(point));
    const distance = targetPos - pos;
    return distance >= 1 && distance <= 6;
  });
}

function opponentHeadBlockScore(state, color) {
  const opponent = opponentOf(color);
  const opponentHeadCount = headCheckers(state, opponent);
  if (opponentHeadCount <= 2) return 0;
  const importantDice = [1, 3, 5, 6];
  const pressure = 1 + Math.max(0, opponentHeadCount - 4) / 5;

  return importantDice.reduce((score, die) => {
    const target = pathFor(opponent)[die];
    const stack = target ? stackAt(state, target) : null;
    const dieWeight = die === 1 || die === 3 || die === 5 ? 1.35 : 1.05;
    if (stack?.color === color) return score + dieWeight * (stack.count >= 2 ? 2.1 : 0.9);
    if (!stack) return score - dieWeight * 0.55;
    return score - dieWeight * 0.25;
  }, 0) * pressure;
}

function footholdScore(state, color) {
  const defensive = madePointsInTrackRange(state, color, 1, 7) * 2.8
    + occupiedInTrackRange(state, color, 1, 7) * 0.75;
  const route = madePointsInTrackRange(state, color, 8, 17) * 1.6
    + occupiedInTrackRange(state, color, 8, 17) * 0.42;
  const attack = madePointsInTrackRange(state, color, 12, 18) * 2.3
    + occupiedInTrackRange(state, color, 12, 18) * 0.5;
  return defensive + route + attack;
}

function prematureHomeRushPenalty(state, color) {
  if (homeReady(state, color) || offCount(state, color) > 0) return 0;
  const headDebt = Math.max(0, headCheckers(state, color) - 4);
  const outside = outsideHomeCount(state, color);
  const home = homeBoardCount(state, color);
  if (home <= 3 || outside <= 5) return 0;

  const support = Math.max(0, footholdScore(state, color)) + Math.max(0, headLandingSupportScore(state, color));
  const supportDebt = Math.max(0, 18 - support);
  return home * (headDebt * 1.8 + supportDebt * 0.42 + Math.max(0, outside - 8) * 0.35);
}

function lateEntryPressure(state, color) {
  const outside = outsideHomeCount(state, color);
  if (!outside) return 0;
  const opponent = opponentOf(color);
  const entry = entryZoneOutsideCount(state, color);
  const lateRace = Math.max(0, 7 - outside) * 0.72;
  const opponentRace = offCount(state, opponent) * 0.32 + (homeReady(state, opponent) ? 1.8 : 0);
  const entryRatio = entry / Math.max(1, outside);
  return 1 + entryRatio * 2.4 + lateRace + opponentRace;
}

function opponentTrapRisk(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(color);
  let run = 0;
  let runStart = 0;
  let risk = 0;

  path.forEach((point, index) => {
    const stack = stackAt(state, point);
    if (stack?.color === opponent) {
      if (!run) runStart = index;
      run += 1;
      if (run >= 3) {
        const ownBehind = path.slice(0, runStart).reduce((total, behindPoint) => {
          const behind = stackAt(state, behindPoint);
          return total + (behind?.color === color ? Number(behind.count) || 0 : 0);
        }, 0);
        if (ownBehind > 0) {
          const zone = runStart < 8 ? 1.85 : runStart < 13 ? 1.45 : runStart < 18 ? 1.15 : 0.65;
          const severity = run >= 6 ? 22 : run >= 5 ? 9.5 : run >= 4 ? 4.2 : 1.75;
          const escapeGaps = path.slice(index + 1, index + 4).reduce((total, escapePoint) => {
            const escape = stackAt(state, escapePoint);
            return total + (escape?.color === opponent ? 0 : 1);
          }, 0);
          const gapRelief = 1 / (1 + escapeGaps * 0.45);
          risk += ownBehind * run * run * severity * zone * gapRelief;
        }
      }
      return;
    }
    run = 0;
  });

  return risk;
}

function homeEntryMoveCount(sequence = [], color) {
  return sequence.reduce((total, move) => {
    const fromPos = pathPos(color, move.from);
    const toPos = move.bearOff || move.to === 0 ? 24 : pathPos(color, move.to);
    return total + (fromPos >= 12 && fromPos < 18 && toPos >= 18 ? 1 : 0);
  }, 0);
}

function homeShuffleMoveCount(sequence = [], color) {
  return sequence.reduce((total, move) => {
    const fromPos = pathPos(color, move.from);
    const toPos = move.bearOff || move.to === 0 ? 24 : pathPos(color, move.to);
    return total + (fromPos >= 18 && toPos >= 18 && !(move.bearOff || move.to === 0) ? 1 : 0);
  }, 0);
}

function outsideDevelopmentMoveCount(sequence = [], color) {
  return sequence.reduce((total, move) => {
    const fromPos = pathPos(color, move.from);
    const toPos = move.bearOff || move.to === 0 ? 24 : pathPos(color, move.to);
    return total + (fromPos >= 0 && fromPos < 18 && toPos > fromPos && toPos < 18 ? 1 : 0);
  }, 0);
}

function developmentPressure(state, color) {
  if (homeReady(state, color)) return 0;
  return 1
    + Math.min(2.4, headCheckers(state, color) / 4.5)
    + Math.min(1.8, outsideHomeCount(state, color) / 8);
}

function blockadeScore(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(opponent);
  let run = 0;
  let score = 0;
  path.forEach((point, index) => {
    const stack = stackAt(state, point);
    if (stack?.color === color) {
      run += 1;
      const made = stack.count >= 2 ? 1 : 0.45;
      const zone = index < 12 ? 1.35 : index < 18 ? 1 : 0.55;
      score += (run * run * 4 + made * 12) * zone;
      return;
    }
    run = 0;
  });
  return score;
}

function stuckRisk(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(color);
  let risk = 0;

  Object.entries(state.points || {}).forEach(([point, stack]) => {
    if (stack.color !== color) return;
    const pos = pathPos(color, Number(point));
    if (pos < 0 || pos >= 18) return;
    let legalExits = 0;
    let progress = 0;
    for (let die = 1; die <= 6; die += 1) {
      const target = path[pos + die];
      if (!target) continue;
      const targetStack = stackAt(state, target);
      if (targetStack?.color === opponent) continue;
      legalExits += 1;
      progress += die;
    }

    const distancePressure = Math.max(0, 12 - pos) / 3;
    const count = Number(stack.count) || 0;
    if (!legalExits) risk += count * (60 + distancePressure * 22);
    else if (legalExits === 1) risk += count * (18 + distancePressure * 8);
    risk -= count * progress * 0.35;
  });

  return risk + opponentTrapRisk(state, color) * 0.72;
}

function tempoValue(before, after, color) {
  const pipGain = pipsFor(before, color) - pipsFor(after, color);
  const offGain = offCount(after, color) - offCount(before, color);
  const homeGain = homeBoardCount(after, color) - homeBoardCount(before, color);
  const headGain = headCheckers(before, color) - headCheckers(after, color);
  return pipGain + offGain * 18 + Math.max(0, homeGain) * 2 + Math.max(0, headGain) * 5;
}

function phasePressure(state, color) {
  const opponent = opponentOf(color);
  return 1
    + offCount(state, opponent) * 0.45
    + (homeReady(state, opponent) ? 1.6 : 0)
    + Math.max(0, 6 - outsideHomeCount(state, color)) * 0.22;
}


/* bot-engine/long/evaluator.ts */


const DEFAULT_LONG_BOT_WEIGHTS = {
  progress: 92,
  homeCheckers: 420,
  borneOff: 18000,
  blockade: 950,
  stuckRisk: 2100,
  distribution: 780,
  tempo: 1650,
  bearOffPriority: 90000000,
  headRelease: 9800,
  foothold: 4300,
  rushPenalty: 12500,
  homeEntry: 145000,
  trapRisk: 62000,
  headLandingExposure: 62000,
};

function mergeWeights(weights = {}) {
  return { ...DEFAULT_LONG_BOT_WEIGHTS, ...(weights || {}) };
}

function evaluateState(state, color, weights = DEFAULT_LONG_BOT_WEIGHTS) {
  const opponent = opponentOf(color);
  const ownPips = pipsFor(state, color);
  const opponentPips = pipsFor(state, opponent);
  const ownOff = offCount(state, color);
  const opponentOff = offCount(state, opponent);
  const pressure = phasePressure(state, color);
  const entryPressure = lateEntryPressure(state, color);
  const ownTrapRisk = opponentTrapRisk(state, color);
  const opponentTrapReward = cappedTrapReward(opponentTrapRisk(state, opponent));

  return (opponentPips - ownPips) * weights.progress
    + homeTotalCount(state, color) * weights.homeCheckers
    - homeTotalCount(state, opponent) * weights.homeCheckers * 0.62
    + ownOff * weights.borneOff
    - opponentOff * weights.borneOff * 1.12
    + blockadeScore(state, color) * weights.blockade
    - blockadeScore(state, opponent) * weights.blockade * 0.58
    - stuckRisk(state, color) * weights.stuckRisk * pressure
    + stuckRisk(state, opponent) * weights.stuckRisk * 0.42
    - distributionPenalty(state, color) * weights.distribution
    + distributionPenalty(state, opponent) * weights.distribution * 0.2
    + headLandingSupportScore(state, color) * weights.headRelease
    - headLandingSupportScore(state, opponent) * weights.headRelease * 0.34
    + opponentHeadBlockScore(state, color) * weights.headRelease * 0.82
    + footholdScore(state, color) * weights.foothold
    - footholdScore(state, opponent) * weights.foothold * 0.38
    - headLandingExposureRisk(state, color) * weights.headLandingExposure
    + headLandingExposureRisk(state, opponent) * weights.headLandingExposure * 0.18
    - prematureHomeRushPenalty(state, color) * weights.rushPenalty
    - entryZoneOutsideCount(state, color) * weights.homeEntry * entryPressure
    + entryZoneOutsideCount(state, opponent) * weights.homeEntry * lateEntryPressure(state, opponent) * 0.34
    - ownTrapRisk * weights.trapRisk
    + opponentTrapReward * weights.trapRisk * 0.055;
}

function sequenceStats(before, after, color, sequence = []) {
  const offGain = offCount(after, color) - offCount(before, color);
  const homeGain = homeBoardCount(after, color) - homeBoardCount(before, color);
  const pipGain = pipsFor(before, color) - pipsFor(after, color);
  const riskDelta = stuckRisk(before, color) - stuckRisk(after, color);
  const distributionDelta = distributionPenalty(before, color) - distributionPenalty(after, color);
  const blockadeGain = blockadeScore(after, color) - blockadeScore(before, color);
  const headGain = headCheckers(before, color) - headCheckers(after, color);
  const footholdGain = footholdScore(after, color) - footholdScore(before, color);
  const outsideReduction = Math.max(0, entryZoneOutsideCount(before, color) - entryZoneOutsideCount(after, color));
  const homeEntryMoves = homeEntryMoveCount(sequence, color);
  const trapDelta = opponentTrapRisk(before, color) - opponentTrapRisk(after, color);
  const trapBefore = opponentTrapRisk(before, color);
  const opponent = opponentOf(color);
  const opponentTrapGain = Math.max(0, opponentTrapRisk(after, opponent) - opponentTrapRisk(before, opponent));
  const headLandingBreak = headLandingBreakRisk(before, after, color);
  const outsideDevelopmentMoves = outsideDevelopmentMoveCount(sequence, color);
  const bearOffMoves = sequence.filter(move => move.bearOff || move.to === 0).length;
  const homeShuffleMoves = homeShuffleMoveCount(sequence, color);

  return {
    offGain,
    homeGain,
    pipGain,
    riskDelta,
    distributionDelta,
    blockadeGain,
    headGain,
    footholdGain,
    outsideReduction,
    homeEntryMoves,
    trapDelta,
    trapBefore,
    opponentTrapGain,
    headLandingBreak,
    outsideDevelopmentMoves,
    bearOffMoves,
    homeShuffleMoves,
  };
}

function scoreSequence(before, after, color, sequence = [], weights = DEFAULT_LONG_BOT_WEIGHTS) {
  const stats = sequenceStats(before, after, color, sequence);
  const pressure = phasePressure(before, color);
  const entryPressure = lateEntryPressure(before, color);
  const development = developmentPressure(before, color);
  let score = evaluateState(after, color, weights) - evaluateState(before, color, weights);

  score += tempoValue(before, after, color) * weights.tempo * pressure;
  score += stats.blockadeGain * weights.blockade * 0.9;
  score += stats.riskDelta * weights.stuckRisk * 1.35;
  score += stats.distributionDelta * weights.distribution * 0.7;
  score += stats.offGain * weights.borneOff * 2.3;
  score += Math.max(0, stats.headGain) * weights.headRelease * (homeReady(before, color) ? 0.12 : 1.15);
  score += stats.footholdGain * weights.foothold * 1.2;
  score += stats.homeEntryMoves * weights.homeEntry * 4.2 * entryPressure;
  score += stats.outsideReduction * weights.homeEntry * 3.6 * entryPressure;
  score += stats.trapDelta * weights.trapRisk * 1.8;
  score += cappedTrapReward(stats.opponentTrapGain) * weights.trapRisk * 0.08;
  score -= stats.headLandingBreak * weights.headLandingExposure * 1.35;
  score += stats.outsideDevelopmentMoves * weights.homeEntry * 0.88 * development;
  if (stats.trapBefore > 0 && stats.trapDelta <= 0) {
    score -= Math.min(stats.trapBefore, 260) * weights.trapRisk * 0.38;
  }
  if (!homeReady(before, color)) {
    const tacticalJustification = cappedTrapReward(stats.opponentTrapGain) * weights.trapRisk * 0.11
      + Math.max(0, stats.blockadeGain) * weights.blockade * 0.85;
    const shufflePenalty = stats.homeShuffleMoves
      * weights.homeEntry
      * 1.18
      * Math.max(1, entryPressure)
      * Math.max(1, development);
    score -= Math.max(0, shufflePenalty - tacticalJustification);
  }

  if (homeReady(before, color)) {
    score += stats.offGain * weights.bearOffPriority * pressure;
    score += stats.pipGain * weights.tempo * 5;
    score -= stats.homeShuffleMoves * weights.bearOffPriority * 0.22;
  } else if (homeReady(after, color)) {
    score += weights.borneOff * 1.8;
  }

  return score;
}

function cappedTrapReward(value) {
  const risk = Math.max(0, Number(value) || 0);
  return Math.min(850, risk);
}


/* bot-engine/long/engine.ts */


const DEFAULT_MAX_CANDIDATES = 64;
const DEFAULT_TIME_LIMIT_MS = 900;

function createLongBotEngine(adapter, options = {}) {
  const defaultWeights = mergeWeights(options.weights);
  const defaultMaxCandidates = Number(options.maxCandidates) || DEFAULT_MAX_CANDIDATES;
  const defaultTimeLimitMs = Number(options.timeLimitMs) || DEFAULT_TIME_LIMIT_MS;

  function rank(state, color = state.turn, runtimeOptions = {}) {
    if (!color) return [];
    const weights = mergeWeights({ ...defaultWeights, ...(runtimeOptions.weights || {}) });
    const startedAt = Date.now();
    const maxCandidates = Number(runtimeOptions.maxCandidates) || defaultMaxCandidates;
    const timeLimitMs = Number(runtimeOptions.timeLimitMs) || defaultTimeLimitMs;
    const sequences = adapter.legalSequences(state, color).filter(sequence => sequence?.length);
    if (!sequences.length) return [];

    const candidates = prefilterSequences(state, color, sequences, maxCandidates);
    const ranked = [];
    for (const sequence of candidates) {
      const after = adapter.applySequence(state, sequence, color);
      ranked.push({
        sequence,
        after,
        score: scoreSequence(state, after, color, sequence, weights),
      });
      if (Date.now() - startedAt > timeLimitMs && ranked.length >= 8) break;
    }

    return ranked.sort((a, b) => b.score - a.score);
  }

  function plan(state, color = state.turn, runtimeOptions = {}) {
    const ranked = rank(state, color, runtimeOptions);
    return (ranked[0]?.sequence || []).map(move => ({ from: move.from, die: move.die }));
  }

  return {
    plan,
    rank,
    evaluateState(state, color, weights = defaultWeights) {
      return evaluateState(state, color, mergeWeights(weights));
    },
    scoreSequence(state, sequence, color = state.turn, weights = defaultWeights) {
      const after = adapter.applySequence(state, sequence, color);
      return scoreSequence(state, after, color, sequence, mergeWeights(weights));
    },
  };
}

function prefilterSequences(state, color, sequences, maxCandidates) {
  if (sequences.length <= maxCandidates) return sequences;
  const ready = homeReady(state, color);
  const entryPressure = lateEntryPressure(state, color);
  const trapPressure = opponentTrapRisk(state, color);
  const development = developmentPressure(state, color);

  return sequences
    .map(sequence => {
      const offMoves = sequence.reduce((total, move) => total + (move.bearOff || move.to === 0 ? 1 : 0), 0);
      const roughPips = sequence.reduce((total, move) => total + Number(move.die || 0), 0);
      const homeShuffle = ready ? sequence.length - offMoves : 0;
      const homeEntries = homeEntryMoveCount(sequence, color);
      const insideHomeMoves = homeShuffleMoveCount(sequence, color);
      const outsideMoves = sequence.reduce((total, move) => total + (pathPos(color, move.from) < 18 ? 1 : 0), 0);
      return {
        sequence,
        priority: (ready ? offMoves * 100000 - homeShuffle * 20000 : 0)
          + homeEntries * 65000 * entryPressure
          - insideHomeMoves * 26000 * Math.max(1, entryPressure) * Math.max(1, development)
          + outsideMoves * Math.min(90000, trapPressure * 320)
          + roughPips * 120
          + offCount(state, color) * 10
          - pipsFor(state, color) * 0.01,
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxCandidates)
    .map(item => item.sequence);
}


/* bot-engine/long/nardu-game-adapter.ts */
function createNarduGameAdapter(game) {
  return {
    legalSequences(state, color) {
      if (!game?.bestMoveSequences) return [];
      const prepared = {
        ...state,
        turn: color || state.turn,
        phase: 'move',
      };
      return game.bestMoveSequences(prepared, color)
        .filter(sequence => sequence?.length)
        .map(sequence => sequence.map(move => ({
          from: Number(move.from),
          die: Number(move.die),
          to: move.bearOff ? 0 : Number(move.to || game.moveTo(color, move.from, move.die, prepared)),
          bearOff: Boolean(move.bearOff || move.to === 0),
        })));
    },

    applySequence(state, sequence, color) {
      const next = JSON.parse(JSON.stringify(state || {}));
      next.turn = color || state.turn;
      next.phase = 'move';
      sequence.forEach(move => {
        game.applyMove(next, move.from, move.die, { autoEnd: false });
      });
      return next;
    },

    moveTo(state, color, from, die) {
      return game.moveTo(color, from, die, state);
    },
  };
}


/* bot-engine/long/browser.ts */


function createBrowserLongBotEngine(game, options = {}) {
  const adapter = createNarduGameAdapter(game);
  const engine = createLongBotEngine(adapter, options);

  return {
    plan(state, runtimeOptions = {}) {
      const color = state?.turn;
      if (!state || (state.variant && state.variant !== 'long') || !color) return [];
      return engine.plan(state, color, runtimeOptions);
    },

    rank(state, runtimeOptions = {}) {
      const color = state?.turn;
      if (!state || (state.variant && state.variant !== 'long') || !color) return [];
      return engine.rank(state, color, runtimeOptions);
    },

    evaluateState(state, color = state?.turn, weights = undefined) {
      if (!state || !color) return 0;
      return engine.evaluateState(state, color, weights);
    },
  };
}

function installBrowserLongBotEngine(root = globalThis) {
  const game = root?.NarduGame;
  if (!game) return null;
  const api = createBrowserLongBotEngine(game);
  root.NarduLongBotEngine = api;
  return api;
}

if (typeof window !== 'undefined') {
  installBrowserLongBotEngine(window);
}

}());
