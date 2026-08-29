/* generated from bot-engine/short/*.ts */
(function () {
  'use strict';

/* bot-engine/short/metrics.ts */
const SHORT_ANCHOR_VALUE_BY_POSITION = [1, 2, 4, 7, 10, 8];

// Gerald Tesauro's public-domain Pubeval evaluator. Keeping this independent
// from the handcrafted metrics prevents a single feature bug from steering the
// whole policy in contact positions.
const SHORT_PUBEVAL_RACE_WEIGHTS = Object.freeze([
  0.00000, -0.17160, 0.27010, 0.29906, -0.08471, 0.00000, -1.40375, -1.05121,
  0.07217, -0.01351, 0.00000, -1.29506, -2.16183, 0.13246, -1.03508, 0.00000,
  -2.29847, -2.34631, 0.17253, 0.08302, 0.00000, -1.27266, -2.87401, -0.07456,
  -0.34240, 0.00000, -1.34640, -2.46556, -0.13022, -0.01591, 0.00000, 0.27448,
  0.60015, 0.48302, 0.25236, 0.00000, 0.39521, 0.68178, 0.05281, 0.09266,
  0.00000, 0.24855, -0.06844, -0.37646, 0.05685, 0.00000, 0.17405, 0.00430,
  0.74427, 0.00576, 0.00000, 0.12392, 0.31202, -0.91035, -0.16270, 0.00000,
  0.01418, -0.10839, -0.02781, -0.88035, 0.00000, 1.07274, 2.00366, 1.16242,
  0.22520, 0.00000, 0.85631, 1.06349, 1.49549, 0.18966, 0.00000, 0.37183,
  -0.50352, -0.14818, 0.12039, 0.00000, 0.13681, 0.13978, 1.11245, -0.12707,
  0.00000, -0.22082, 0.20178, -0.06285, -0.52728, 0.00000, -0.13597, -0.19412,
  -0.09308, -1.26062, 0.00000, 3.05454, 5.16874, 1.50680, 5.35000, 0.00000,
  2.19605, 3.85390, 0.88296, 2.30052, 0.00000, 0.92321, 1.08744, -0.11696,
  -0.78560, 0.00000, -0.09795, -0.83050, -1.09167, -4.94251, 0.00000,
  -1.00316, -3.66465, -2.56906, -9.67677, 0.00000, -2.77982, -7.26713,
  -3.40177, -12.32252, 0.00000, 3.42040,
]);

const SHORT_PUBEVAL_CONTACT_WEIGHTS = Object.freeze([
  0.25696, -0.66937, -1.66135, -2.02487, -2.53398, -0.16092, -1.11725,
  -1.06654, -0.92830, -1.99558, -1.10388, -0.80802, 0.09856, -0.62086,
  -1.27999, -0.59220, -0.73667, 0.89032, -0.38933, -1.59847, -1.50197,
  -0.60966, 1.56166, -0.47389, -1.80390, -0.83425, -0.97741, -1.41371,
  0.24500, 0.10970, -1.36476, -1.05572, 1.15420, 0.11069, -0.38319,
  -0.74816, -0.59244, 0.81116, -0.39511, 0.11424, -0.73169, -0.56074,
  1.09792, 0.15977, 0.13786, -1.18435, -0.43363, 1.06169, -0.21329,
  0.04798, -0.94373, -0.22982, 1.22737, -0.13099, -0.06295, -0.75882,
  -0.13658, 1.78389, 0.30416, 0.36797, -0.69851, 0.13003, 1.23070,
  0.40868, -0.21081, -0.64073, 0.31061, 1.59554, 0.65718, 0.25429,
  -0.80789, 0.08240, 1.78964, 0.54304, 0.41174, -1.06161, 0.07851,
  2.01451, 0.49786, 0.91936, -0.90750, 0.05941, 1.83120, 0.58722,
  1.28777, -0.83711, -0.33248, 2.64983, 0.52698, 0.82132, -0.58897,
  -1.18223, 3.35809, 0.62017, 0.57353, -0.07276, -0.36214, 4.37655,
  0.45481, 0.21746, 0.10504, -0.61977, 3.54001, 0.04612, -0.18108,
  0.63211, -0.87046, 2.47673, -0.48016, -1.27157, 0.86505, -1.11342,
  1.24612, -0.82385, -2.77082, 1.23606, -1.59529, 0.10438, -1.30206,
  -4.11520, 5.62596, -2.75800,
]);

function shortPubevalScore(state, color, phaseHint = '') {
  const opponent = NarduGame.opponentOf(color);
  const board = new Array(27).fill(0);
  Object.entries(state.points || {}).forEach(([rawPoint, stack]) => {
    const point = Number(rawPoint);
    const canonicalPoint = color === 'white' ? point : 25 - point;
    board[canonicalPoint] = stack.color === color
      ? Number(stack.count) || 0
      : -(Number(stack.count) || 0);
  });
  board[0] = -(Number(state.bar?.[opponent]) || 0);
  board[25] = Number(state.bar?.[color]) || 0;
  board[26] = Number(state.off?.[color]) || 0;

  const embedded = new Array(122).fill(0);
  for (let index = 1; index <= 24; index += 1) {
    const count = board[25 - index];
    const offset = (index - 1) * 5;
    if (count === -1) embedded[offset] = 1;
    if (count === 1) embedded[offset + 1] = 1;
    if (count >= 2) embedded[offset + 2] = 1;
    if (count === 3) embedded[offset + 3] = 1;
    if (count >= 4) embedded[offset + 4] = (count - 3) / 2;
  }
  embedded[120] = -board[0] / 2;
  embedded[121] = board[26] / 15;

  let ownLast = 25;
  while (ownLast > 0 && board[ownLast] <= 0) ownLast -= 1;
  let opponentFirst = 0;
  while (opponentFirst < 25 && board[opponentFirst] >= 0) opponentFirst += 1;
  const raceScore = embedded.reduce((score, value, index) => (
    score + value * SHORT_PUBEVAL_RACE_WEIGHTS[index]
  ), 0);
  if (phaseHint === 'race' || phaseHint === 'bearoff') return raceScore;
  const contactScore = embedded.reduce((score, value, index) => (
    score + value * SHORT_PUBEVAL_CONTACT_WEIGHTS[index]
  ), 0);
  if (phaseHint === 'contact' || phaseHint === 'bar') return contactScore;
  if (ownLast <= opponentFirst) return raceScore;
  if ((state.bar?.[color] || 0) > 0 || (state.bar?.[opponent] || 0) > 0) {
    return contactScore;
  }
  const contactQuality = clampShortMetric(shortMetrics(state, color).contactQuality, 0, 1);
  return raceScore + (contactScore - raceScore) * contactQuality;
}

function shortMetrics(state, color) {
  const opponent = NarduGame.opponentOf(color);
  const path = NarduGame.pathFor(color, state);
  const opponentPositionsOnOwnTrack = Object.entries(state.points || {})
    .filter(([, stack]) => stack.color === opponent)
    .map(([point]) => NarduGame.pathPos(color, Number(point), state));
  const contactBoundary = opponentPositionsOnOwnTrack.length
    ? Math.max(...opponentPositionsOnOwnTrack)
    : -1;
  let made = 0;
  let homeMade = 0;
  let homeCheckers = Number(state.off?.[color]) || 0;
  let blots = 0;
  let exposure = 0;
  let stacks = 0;
  let anchors = 0;
  let anchorValue = 0;
  let longestPrime = 0;
  let run = 0;
  let outsideHome = 0;
  let outsideHomePips = 0;
  let backmost = 24;
  let contactCheckers = 0;
  let contactMade = 0;
  let contactBlots = 0;
  let contactExposure = 0;
  let safeContactBlotWeight = 0;

  path.forEach((point, pos) => {
    const stack = state.points?.[point];
    if (stack?.color !== color) {
      run = 0;
      return;
    }
    backmost = Math.min(backmost, pos);
    if (pos < 18) {
      outsideHome += stack.count;
      outsideHomePips += stack.count * (18 - pos);
    }
    if (pos >= 18) homeCheckers += stack.count;
    if (stack.count >= 2) {
      made += 1;
      run += 1;
      longestPrime = Math.max(longestPrime, run);
      if (pos >= 18) homeMade += 1;
      if (pos <= 5) {
        anchors += 1;
        anchorValue += SHORT_ANCHOR_VALUE_BY_POSITION[pos];
      }
    } else {
      run = 0;
      blots += 1;
      const risk = blotRisk(state, color, point, pos);
      exposure += risk;
      if (pos <= contactBoundary) {
        contactExposure += risk;
        safeContactBlotWeight += clampShortMetric((20 - risk) / 18, 0, 1);
      }
    }
    if (pos <= contactBoundary) {
      contactCheckers += stack.count;
      if (stack.count >= 2) contactMade += 1;
      else contactBlots += 1;
    }
    const excess = Math.max(0, stack.count - (pos >= 18 ? 5 : 4));
    stacks += excess * excess;
  });

  let pressureRun = 0;
  let primePressure = 0;
  const opponentPath = NarduGame.pathFor(opponent, state);
  opponentPath.forEach((point, opponentPos) => {
    const stack = state.points?.[point];
    if (stack?.color !== color || stack.count < 2) {
      pressureRun = 0;
      return;
    }
    pressureRun += 1;
    const runStart = opponentPos - pressureRun + 1;
    const trapped = opponentPath.slice(0, runStart).reduce((total, trappedPoint) => {
      const trappedStack = state.points?.[trappedPoint];
      return total + (trappedStack?.color === opponent ? trappedStack.count : 0);
    }, 0) + (Number(state.bar?.[opponent]) || 0);
    primePressure += pressureRun * pressureRun * trapped;
  });

  const protectedContactCheckers = Math.max(0, contactCheckers - contactBlots);
  const contactQuality = clampShortMetric(
    contactMade * 0.18
      + Math.min(0.46, protectedContactCheckers * 0.075)
      + safeContactBlotWeight * 0.08,
    0,
    1,
  );

  return {
    pips: NarduGame.pipsFor(state, color),
    off: Number(state.off?.[color]) || 0,
    bar: Number(state.bar?.[color]) || 0,
    opponentBar: Number(state.bar?.[opponent]) || 0,
    made,
    homeMade,
    homeCheckers,
    blots,
    exposure,
    stacks,
    anchors,
    anchorValue,
    longestPrime,
    outsideHome,
    outsideHomePips,
    backmost,
    primePressure,
    contactCheckers,
    contactMade,
    contactBlots,
    contactExposure,
    contactQuality,
  };
}

function clampShortMetric(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function blotRisk(state, color, point, pos = NarduGame.pathPos(color, point, state)) {
  const opponent = NarduGame.opponentOf(color);
  let hittingDice = 0;
  const sources = Number(state.bar?.[opponent]) > 0
    ? [NarduGame.barPoint(opponent)]
    : Object.entries(state.points || {})
      .filter(([, stack]) => stack.color === opponent)
      .map(([source]) => Number(source));
  for (let die = 1; die <= 6; die += 1) {
    if (sources.some(source => NarduGame.moveTo(opponent, source, die, state) === Number(point))) {
      hittingDice += 1;
    }
  }
  if (!hittingDice) return 2 + (pos >= 18 ? 3 : 0);
  const zone = pos >= 18 ? 2.2 : pos <= 5 ? 1.35 : 1.7;
  return 8 + hittingDice * 11 * zone;
}

function shortPhase(state, color) {
  const opponent = NarduGame.opponentOf(color);
  if ((state.bar?.[color] || 0) > 0 || (state.bar?.[opponent] || 0) > 0) return 'bar';
  if (shortHasContact(state, color)) return 'contact';
  if (NarduGame.homeReady(state, color)) return 'bearoff';
  return 'race';
}

function shortHasContact(state, color) {
  const opponent = NarduGame.opponentOf(color);
  if ((state.bar?.[color] || 0) > 0 || (state.bar?.[opponent] || 0) > 0) return true;
  const ownPositions = Object.entries(state.points || {})
    .filter(([, stack]) => stack.color === color)
    .map(([point]) => NarduGame.pathPos(color, Number(point), state));
  const opponentPositionsOnOwnTrack = Object.entries(state.points || {})
    .filter(([, stack]) => stack.color === opponent)
    .map(([point]) => NarduGame.pathPos(color, Number(point), state));
  if (!ownPositions.length || !opponentPositionsOnOwnTrack.length) return false;
  return Math.min(...ownPositions) <= Math.max(...opponentPositionsOnOwnTrack);
}


/* bot-engine/short/engine.ts */
const SHORT_REPLY_ROLLS = [];
for (let first = 1; first <= 6; first += 1) {
  for (let second = first; second <= 6; second += 1) {
    SHORT_REPLY_ROLLS.push({
      dice: first === second ? [first, first, first, first] : [first, second],
      probability: first === second ? 1 / 36 : 2 / 36,
    });
  }
}

const SHORT_REPLY_POOL_CAP = 32;
const SHORT_SCORE_WEIGHTS = Object.freeze({
  base: 0.75,
  expectedReply: 0.2,
  worstReply: 0.05,
});
const SHORT_STRUCTURAL_DOMINANCE_BASE_MARGIN = 90_000;
const SHORT_STRUCTURAL_DOMINANCE_EXPOSURE_MARGIN = 2;
const SHORT_PUBEVAL_SCALE = 10_000_000;
const SHORT_HANDCRAFTED_BLEND = 0.01;

function clampShort(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cloneShortState(state) {
  return JSON.parse(JSON.stringify(state || {}));
}

function shortSequenceSignature(sequence, state, color) {
  return JSON.stringify((sequence || []).map(move => [
    Number(move.from) === NarduGame.barPoint(color)
      ? -1
      : NarduGame.pathPos(color, Number(move.from), state),
    move.bearOff || Number(move.to) === 0
      ? 24
      : NarduGame.pathPos(color, Number(move.to), state),
    Number(move.die),
    Boolean(move.bearOff),
  ]));
}

function terminalShortScore(state, color) {
  if (!state?.winner) return null;
  if (state.winner === color) return 1_000_000_000;
  const opponent = NarduGame.opponentOf(color);
  const severity = state.resultType === 'koks' ? 3 : state.resultType === 'mars' ? 2 : 1;
  const ownOff = Number(state.off?.[color]) || 0;
  const opponentOff = Number(state.off?.[opponent]) || 0;
  return -1_000_000_000 - severity * 80_000_000 + ownOff * 2_000_000 - opponentOff * 500_000;
}

function createShortBotEngine(adapter, options = {}) {
  const experience = new Map();
  const experienceSources = new Map();

  function evaluateState(state, color, pubevalPhase = '') {
    const terminal = terminalShortScore(state, color);
    if (terminal !== null) return terminal;
    const opponent = NarduGame.opponentOf(color);
    const own = shortMetrics(state, color);
    const other = shortMetrics(state, opponent);
    const raceLead = other.pips - own.pips;
    const phase = shortPhase(state, color);
    const raceResultSafety = own.off === 0
      ? -(other.off * 70000 + (other.off >= 8 ? 180000 : 0))
      : own.off * 35000;
    const raceScore = raceLead * 4800
      + (own.off - other.off) * 520000
      + (own.backmost - other.backmost) * 22000
      + (other.outsideHome - own.outsideHome) * 72000
      + (other.outsideHomePips - own.outsideHomePips) * 6500
      + (other.stacks - own.stacks) * 3200
      + raceResultSafety;
    let handcraftedScore = raceScore;
    if (phase !== 'contact' && phase !== 'bar') {
      return shortPubevalScore(state, color, pubevalPhase) * SHORT_PUBEVAL_SCALE
        + handcraftedScore * SHORT_HANDCRAFTED_BLEND;
    }
    const ownBoard = own.homeMade * own.homeMade * (3600 + other.bar * 11000);
    const otherBoard = other.homeMade * other.homeMade * (3600 + own.bar * 11000);
    const barValue = (
      other.bar * (52000 + own.homeMade * 17000)
      - own.bar * (65000 + other.homeMade * 21000)
    );
    const resultSafety = own.off === 0
      ? -(other.off * 24000 + (other.off >= 8 ? 90000 : 0))
      : own.off * 19000;
    const contactScore = raceLead * 1180
      + (own.off - other.off) * 150000
      + barValue
      + (own.made - other.made) * 10500
      + ownBoard - otherBoard
      + (own.primePressure - other.primePressure) * 8200
      + (other.exposure - own.exposure) * 7600
      + (own.anchorValue - other.anchorValue) * 5200
      + (other.stacks - own.stacks) * 13500
      + (own.backmost - other.backmost) * 7200
      + (other.outsideHome - own.outsideHome) * 13000
      + resultSafety;
    if (phase === 'bar') handcraftedScore = contactScore;
    else {
      const contactQuality = clampShort(Number(own.contactQuality) || 0, 0, 1);
      handcraftedScore = raceScore + (contactScore - raceScore) * contactQuality;
    }
    return shortPubevalScore(state, color, pubevalPhase) * SHORT_PUBEVAL_SCALE
      + handcraftedScore * SHORT_HANDCRAFTED_BLEND;
  }

  function positionFeatures(before, after, color, sequence) {
    const opponent = NarduGame.opponentOf(color);
    const ownBefore = shortMetrics(before, color);
    const ownAfter = shortMetrics(after, color);
    const otherBefore = shortMetrics(before, opponent);
    const otherAfter = shortMetrics(after, opponent);
    const hits = Math.max(0, otherAfter.bar - otherBefore.bar);
    const entries = Math.max(0, ownBefore.bar - ownAfter.bar);
    const offGain = ownAfter.off - ownBefore.off;
    let preview = cloneShortState(before);
    let capturedExposure = 0;
    (sequence || []).forEach(move => {
      const target = move.bearOff ? null : preview.points?.[Number(move.to)];
      if (target?.color === opponent && Number(target.count) === 1) {
        capturedExposure += blotRisk(preview, opponent, Number(move.to));
      }
      preview = adapter.applySequence(preview, [move], color);
    });
    return {
      pipsGain: ownBefore.pips - ownAfter.pips,
      hits,
      entries,
      offGain,
      madeGain: ownAfter.made - ownBefore.made,
      homeMadeGain: ownAfter.homeMade - ownBefore.homeMade,
      primeGain: ownAfter.longestPrime - ownBefore.longestPrime,
      backmostGain: ownAfter.backmost - ownBefore.backmost,
      exposureDelta: ownAfter.exposure - ownBefore.exposure,
      opponentExposureGain: otherAfter.exposure - otherBefore.exposure,
      capturedExposure,
      anchorDelta: ownAfter.anchorValue - ownBefore.anchorValue,
      stackDelta: ownAfter.stacks - ownBefore.stacks,
      ownBarAfter: ownAfter.bar,
      opponentBarAfter: otherAfter.bar,
      homeShuffleMoves: sequence.filter(move => (
        !move.bearOff
        && NarduGame.pathPos(color, move.from, before) >= 18
        && NarduGame.pathPos(color, move.to, before) >= 18
      )).length,
    };
  }

  function descriptor(state, color, features) {
    const opponent = NarduGame.opponentOf(color);
    const own = shortMetrics(state, color);
    const other = shortMetrics(state, opponent);
    const lead = clampShort(Math.round((other.pips - own.pips) / 20), -4, 4);
    const phase = shortPhase(state, color);
    const contextKey = [
      phase,
      `lead:${lead}`,
      `bar:${Math.min(2, own.bar)}-${Math.min(2, other.bar)}`,
      `board:${Math.min(6, own.homeMade)}-${Math.min(6, other.homeMade)}`,
      `off:${Math.min(3, Math.floor(own.off / 5))}-${Math.min(3, Math.floor(other.off / 5))}`,
    ].join('|');
    const actionKey = [
      `hit:${Math.min(2, features.hits)}`,
      `enter:${Math.min(2, features.entries)}`,
      `off:${Math.min(2, features.offGain)}`,
      `make:${clampShort(features.madeGain, -1, 2)}`,
      `prime:${clampShort(features.primeGain, -1, 2)}`,
      `risk:${clampShort(Math.round(features.exposureDelta / 25), -3, 3)}`,
    ].join('|');
    const contactSeverity = phase === 'contact' || phase === 'bar'
      ? features.ownBarAfter * 1.3
        + Math.max(0, features.exposureDelta) / 35
        + Math.max(0, -features.madeGain) * 0.75
      : 0;
    const bearoffWaste = phase === 'bearoff' && features.offGain === 0 ? 1.4 : 0;
    const structuralSeverity = phase === 'bearoff'
      ? 0
      : Math.max(0, features.stackDelta) * 0.25;
    const mistakeSeverity = Math.max(0,
      contactSeverity
      + structuralSeverity
      + bearoffWaste
      + (phase !== 'bearoff' && features.homeShuffleMoves > 0 && features.offGain === 0 ? 0.65 : 0));
    return { phase, contextKey, actionKey, mistakeSeverity };
  }

  function experienceAdjustment(item) {
    const pattern = experience.get(`${item.experience.contextKey}::${item.experience.actionKey}`);
    if (!pattern) return 0;
    const samples = Math.max(1, Number(pattern.samples) || 1);
    const wins = Number(pattern.wins) || 0;
    const losses = Number(pattern.losses) || 0;
    const winWeight = Number(pattern.winWeight) || wins;
    const lossWeight = Number(pattern.lossWeight) || losses;
    const confidence = Math.min(1, Math.log2(samples + 1) / 4);
    return clampShort((winWeight - lossWeight * 1.15) / samples * 13000 * confidence, -18000, 18000);
  }

  function baseCandidate(state, color, sequence, baseline = false, pubevalPhase = '') {
    const after = adapter.applySequence(state, sequence, color);
    const features = positionFeatures(state, after, color, sequence);
    const exp = descriptor(state, color, features);
    let score = evaluateState(after, color, pubevalPhase);
    score += features.hits * 21000;
    score += features.capturedExposure * 7600 * SHORT_HANDCRAFTED_BLEND;
    score += features.entries * 17000;
    score += features.offGain * 28000;
    score += features.madeGain * 9000;
    score += features.homeMadeGain * 14000;
    score += features.primeGain * 12000;
    score -= Math.max(0, features.exposureDelta) * 2600;
    score -= Math.max(0, features.stackDelta) * 3500;
    if (features.homeShuffleMoves && features.offGain === 0 && !NarduGame.homeReady(state, color)) {
      const outside = shortMetrics(state, color).outsideHome;
      score -= features.homeShuffleMoves * (26000 + outside * 6500);
    }
    if (baseline) score += 18000;
    return { sequence, after, features, experience: exp, baseline, baseScore: score, score };
  }

  function analyzeReplies(candidate, color, runtimeOptions) {
    const opponent = NarduGame.opponentOf(color);
    const replyLimit = Math.max(8, Number(runtimeOptions.replyLimit) || 12);
    const replyPoolLimit = Math.min(
      SHORT_REPLY_POOL_CAP,
      Math.max(replyLimit + 8, replyLimit * 2),
    );
    let expected = 0;
    let worst = Infinity;
    let blockedProbability = 0;
    let probabilityMass = 0;
    const reservations = {
      hitRolls: 0,
      barEntryRolls: 0,
      terminalRolls: 0,
      staticRolls: 0,
      outsideGeneric: 0,
    };
    let replyPoolCandidates = 0;
    let repliesEvaluated = 0;
    SHORT_REPLY_ROLLS.forEach(({ dice, probability }) => {
      const replyState = cloneShortState(candidate.after);
      replyState.turn = opponent;
      replyState.phase = 'move';
      replyState.dice = [...dice];
      replyState.rolled = [...dice];
      replyState.turnMoves = [];
      const pool = adapter.tacticalSequences
        ? adapter.tacticalSequences(replyState, opponent, { limit: replyPoolLimit })
        : adapter.legalSequences(replyState, opponent, { limit: replyPoolLimit });
      const genericSignatures = new Set(pool.slice(0, replyLimit)
        .map(sequence => shortSequenceSignature(sequence, replyState, opponent)));
      const annotated = pool.map(sequence => ({
        sequence,
        signature: shortSequenceSignature(sequence, replyState, opponent),
        features: replySequenceFeatures(replyState, opponent, sequence),
        botScore: evaluateState(
          adapter.applySequence(replyState, sequence, opponent),
          color,
          candidate.pubevalPhase,
        ),
      }));
      const generic = annotated.slice(0, replyLimit);
      const worstStatic = annotated
        .slice()
        .sort((left, right) => left.botScore - right.botScore
          || left.signature.localeCompare(right.signature))[0] || null;
      const reserved = [
        ['terminalRolls', strongestReplyFeature(annotated, 'terminal')],
        ['hitRolls', strongestReplyFeature(annotated, 'hits')],
        ['barEntryRolls', strongestReplyFeature(annotated, 'entries')],
        ['staticRolls', worstStatic],
      ];
      const selected = [];
      const selectedSignatures = new Set();
      reserved.forEach(([counter, item]) => {
        if (!item || selectedSignatures.has(item.signature) || selected.length >= replyLimit) return;
        selected.push(item);
        selectedSignatures.add(item.signature);
        reservations[counter] += 1;
        if (!genericSignatures.has(item.signature)) reservations.outsideGeneric += 1;
      });
      generic.forEach(item => {
        if (selected.length >= replyLimit || selectedSignatures.has(item.signature)) return;
        selected.push(item);
        selectedSignatures.add(item.signature);
      });
      replyPoolCandidates += pool.length;
      repliesEvaluated += selected.length;
      let botScore;
      if (!selected.length) {
        blockedProbability += probability;
        botScore = evaluateState(replyState, color, candidate.pubevalPhase) + 28000;
      } else {
        botScore = Math.min(...selected.map(reply => reply.botScore));
      }
      expected += botScore * probability;
      worst = Math.min(worst, botScore);
      probabilityMass += probability;
    });
    const tactical = {
      expectedImpact: expected - candidate.baseScore,
      worstImpact: worst - candidate.baseScore,
      rolls: SHORT_REPLY_ROLLS.length,
      probabilityMass,
      blockedProbability,
      replyPoolLimit,
      replyPoolCandidates,
      repliesEvaluated,
      reservations,
      plies: 2,
    };
    return {
      ...candidate,
      tactical: {
        ...tactical,
        scoreWeights: { ...SHORT_SCORE_WEIGHTS },
      },
      score: candidate.baseScore * SHORT_SCORE_WEIGHTS.base
        + expected * SHORT_SCORE_WEIGHTS.expectedReply
        + worst * SHORT_SCORE_WEIGHTS.worstReply,
    };
  }

  function replySequenceFeatures(state, color, sequence) {
    const opponent = NarduGame.opponentOf(color);
    const points = cloneShortState(state.points || {});
    const barPoint = NarduGame.barPoint(color);
    let hits = 0;
    let entries = 0;
    let bearOffs = 0;
    let pips = 0;
    (sequence || []).forEach(move => {
      const from = Number(move.from);
      const to = Number(move.to) || 0;
      if (from === barPoint) entries += 1;
      if (move.bearOff || to === 0) {
        bearOffs += 1;
      } else {
        const target = points[to];
        if (move.hit || (target?.color === opponent && Number(target.count) === 1)) hits += 1;
        points[to] = { color, count: target?.color === color ? Number(target.count) + 1 : 1 };
      }
      if (from !== barPoint && points[from]?.color === color) {
        points[from].count -= 1;
        if (points[from].count <= 0) delete points[from];
      }
      pips += Number(move.die) || 0;
    });
    return {
      hits,
      entries,
      terminal: (Number(state.off?.[color]) || 0) + bearOffs >= 15 ? 1 : 0,
      pips,
    };
  }

  function strongestReplyFeature(annotated, feature) {
    return annotated
      .filter(item => Number(item.features?.[feature]) > 0)
      .sort((left, right) => (
        Number(right.features[feature]) - Number(left.features[feature])
        || left.botScore - right.botScore
        || Number(right.features.hits) - Number(left.features.hits)
        || Number(right.features.entries) - Number(left.features.entries)
        || Number(right.features.pips) - Number(left.features.pips)
        || left.signature.localeCompare(right.signature)
      ))[0] || null;
  }

  function structurallyDominates(left, right) {
    const sameTacticalProgress = ['pipsGain', 'hits', 'entries', 'offGain']
      .every(key => Number(left.features[key]) === Number(right.features[key]));
    if (!sameTacticalProgress) return false;
    const structuralKeys = ['madeGain', 'homeMadeGain', 'primeGain'];
    const preservesStructure = structuralKeys
      .every(key => Number(left.features[key]) >= Number(right.features[key]));
    const improvesStructure = structuralKeys
      .some(key => Number(left.features[key]) > Number(right.features[key]));
    const exposureImprovement = Number(right.features.exposureDelta)
      - Number(left.features.exposureDelta);
    return preservesStructure
      && improvesStructure
      && exposureImprovement >= SHORT_STRUCTURAL_DOMINANCE_EXPOSURE_MARGIN
      && left.baseScore - right.baseScore >= SHORT_STRUCTURAL_DOMINANCE_BASE_MARGIN;
  }

  function removeStructurallyDominated(candidates) {
    return candidates.filter(candidate => !candidates.some(other => (
      other !== candidate && structurallyDominates(other, candidate)
    )));
  }

  function removePrematureAnchorBreaks(candidates, state, color) {
    const opponent = NarduGame.opponentOf(color);
    const other = shortMetrics(state, opponent);
    if (other.pips < 90) return candidates;
    return candidates.filter(candidate => {
      const features = candidate.features;
      const fragileBreak = features.hits === 0
        && features.entries === 0
        && features.offGain === 0
        && features.madeGain <= 0
        && features.anchorDelta < 0
        && features.exposureDelta >= 20;
      if (!fragileBreak) return true;
      return !candidates.some(otherCandidate => {
        const safer = otherCandidate.features;
        return safer.pipsGain === features.pipsGain
          && safer.hits === features.hits
          && safer.entries === features.entries
          && safer.offGain === features.offGain
          && safer.madeGain >= features.madeGain
          && safer.anchorDelta >= 0
          && safer.exposureDelta <= features.exposureDelta - 20;
      });
    });
  }

  function removeUnsafeBarEntryBlots(candidates, state, color) {
    if ((Number(state.bar?.[color]) || 0) <= 0) return candidates;
    const continuesEnteredChecker = sequence => {
      const entryDestinations = new Set();
      for (const move of sequence || []) {
        if (Number(move.from) === NarduGame.barPoint(color)) {
          if (!move.bearOff && Number(move.to)) entryDestinations.add(Number(move.to));
        } else if (entryDestinations.has(Number(move.from))) {
          return true;
        }
      }
      return false;
    };
    return candidates.filter(candidate => {
      const features = candidate.features;
      const exposedEntry = features.entries > 0
        && features.hits === 0
        && features.exposureDelta >= 50
        && !continuesEnteredChecker(candidate.sequence);
      if (!exposedEntry) return true;
      return !candidates.some(otherCandidate => {
        const safer = otherCandidate.features;
        return safer.pipsGain === features.pipsGain
          && safer.hits === features.hits
          && safer.entries === features.entries
          && safer.offGain === features.offGain
          && safer.madeGain >= features.madeGain
          && continuesEnteredChecker(otherCandidate.sequence)
          && safer.exposureDelta <= features.exposureDelta - 45;
      });
    });
  }

  function rank(state, color, runtimeOptions = {}) {
    const maxCandidates = Math.max(6, Number(runtimeOptions.maxCandidates) || 48);
    const analyzeCount = Math.max(4, Number(runtimeOptions.analyzeCandidates) || 6);
    const sequences = adapter.legalSequences(state, color, { limit: 0 });
    if (!sequences.length) return [];
    const baseline = adapter.baselineSequence?.(state, color) || [];
    if (baseline.length) sequences.push(baseline);
    const unique = new Map();
    const pubevalPhase = shortPhase(state, color);
    sequences.forEach(sequence => {
      const isBaseline = baseline.length > 0
        && JSON.stringify(sequence.map(move => [move.from, move.die]))
          === JSON.stringify(baseline.map(move => [move.from, move.die]));
      const item = {
        ...baseCandidate(state, color, sequence, isBaseline, pubevalPhase),
        pubevalPhase,
      };
      const signature = JSON.stringify({
        points: item.after.points,
        bar: item.after.bar,
        off: item.after.off,
      });
      const previous = unique.get(signature);
      if (!previous || item.baseScore > previous.baseScore || item.baseline) unique.set(signature, item);
    });
    let prefiltered = Array.from(unique.values())
      .sort((left, right) => right.baseScore - left.baseScore
        || shortSequenceSignature(left.sequence, state, color)
          .localeCompare(shortSequenceSignature(right.sequence, state, color)));
    const phase = shortPhase(state, color);
    if (phase === 'bearoff') {
      const maximumOff = Math.max(...prefiltered.map(item => item.features.offGain));
      prefiltered = prefiltered.filter(item => item.features.offGain === maximumOff);
    }
    if (phase === 'race'
      && !NarduGame.homeReady(state, color)
      && shortMetrics(state, color).outsideHome <= 4) {
      const maximumBackmostGain = Math.max(...prefiltered.map(item => item.features.backmostGain));
      if (maximumBackmostGain > 0) {
        prefiltered = prefiltered.filter(item => item.features.backmostGain === maximumBackmostGain);
      }
    }
    if (phase === 'contact' || phase === 'bar') {
      prefiltered = removeStructurallyDominated(prefiltered);
      prefiltered = removePrematureAnchorBreaks(prefiltered, state, color);
      prefiltered = removeUnsafeBarEntryBlots(prefiltered, state, color);
    }
    prefiltered = prefiltered.slice(0, maxCandidates);
    const selected = prefiltered.slice(0, Math.min(analyzeCount, 2));
    return selected
      .map(item => {
        const analyzed = analyzeReplies(item, color, runtimeOptions);
        const adjustment = experienceAdjustment(analyzed);
        return { ...analyzed, experienceAdjustment: adjustment, score: analyzed.score + adjustment };
      })
      .sort((left, right) => right.score - left.score
        || shortSequenceSignature(left.sequence, state, color)
          .localeCompare(shortSequenceSignature(right.sequence, state, color)));
  }

  return {
    rank,
    evaluateState,
    describeSequence(state, sequence, color) {
      const item = baseCandidate(state, color, sequence);
      return {
        sequence: item.sequence,
        score: item.score,
        features: item.features,
        experience: item.experience,
      };
    },
    setExperience(patterns, source = 'runtime') {
      const sourcePatterns = new Map();
      (Array.isArray(patterns) ? patterns : []).forEach(pattern => {
        if (pattern?.contextKey && pattern?.actionKey) {
          sourcePatterns.set(`${pattern.contextKey}::${pattern.actionKey}`, { ...pattern });
        }
      });
      experienceSources.set(String(source || 'runtime'), sourcePatterns);
      experience.clear();
      experienceSources.forEach(patternMap => patternMap.forEach((pattern, key) => {
        const previous = experience.get(key);
        if (!previous) {
          experience.set(key, { ...pattern });
          return;
        }
        experience.set(key, {
          ...previous,
          samples: (Number(previous.samples) || 0) + (Number(pattern.samples) || 0),
          losses: (Number(previous.losses) || 0) + (Number(pattern.losses) || 0),
          wins: (Number(previous.wins) || 0) + (Number(pattern.wins) || 0),
          lossWeight: (Number(previous.lossWeight) || 0) + (Number(pattern.lossWeight) || 0),
          severeLosses: (Number(previous.severeLosses) || 0) + (Number(pattern.severeLosses) || 0),
          signalWeight: (Number(previous.signalWeight) || 0) + (Number(pattern.signalWeight) || 0),
          winWeight: (Number(previous.winWeight) || 0) + (Number(pattern.winWeight) || 0),
        });
      }));
      return experience.size;
    },
    experienceSize: () => experience.size,
  };
}


/* bot-engine/short/nardu-game-adapter.ts */
function createShortNarduGameAdapter(game) {
  function normalizeSequence(state, color, sequence) {
    return sequence.map(move => ({
      from: Number(move.from),
      die: Number(move.die),
      to: move.bearOff ? 0 : Number(move.to || game.moveTo(color, move.from, move.die, state)),
      bearOff: Boolean(move.bearOff || move.to === 0),
      hit: Boolean(move.hit),
    }));
  }

  return {
    legalSequences(state, color, options = {}) {
      const prepared = { ...state, turn: color || state.turn, phase: 'move' };
      const limit = Math.max(0, Number(options.limit) || 0);
      const sequences = limit && game.sampledMoveSequences
        ? game.sampledMoveSequences(prepared, color, limit)
        : shortExactMoveSequences(game, prepared, color);
      return sequences
        .filter(sequence => sequence?.length)
        .map(sequence => normalizeSequence(prepared, color, sequence));
    },
    tacticalSequences(state, color, options = {}) {
      const prepared = { ...state, turn: color || state.turn, phase: 'move' };
      const limit = Math.max(4, Math.min(64, Math.floor(Number(options.limit) || 24)));
      const fallback = game.sampledMoveSequences
        ? game.sampledMoveSequences(prepared, color, limit)
        : game.bestMoveSequences(prepared, color);
      return shortTacticalMoveSequences(game, prepared, color, limit, fallback)
        .filter(sequence => sequence?.length)
        .map(sequence => normalizeSequence(prepared, color, sequence));
    },
    applySequence(state, sequence, color) {
      return applyKnownShortSequence(game, state, sequence, color || state.turn);
    },
    baselineSequence(state, color) {
      return (game.chooseBotSequence?.(state, color, { difficulty: 'hard' }) || []).map(move => ({
        from: Number(move.from),
        die: Number(move.die),
        to: move.bearOff ? 0 : Number(move.to || game.moveTo(color, move.from, move.die, state)),
        bearOff: Boolean(move.bearOff || move.to === 0),
      }));
    },
  };
}

function shortExactMoveSequences(game, state, color) {
  const maximumDepth = Math.max(1, state.dice?.length || 0);
  let frontier = [{
    state: JSON.parse(JSON.stringify(state || {})),
    sequence: [],
  }];
  const terminal = [];

  for (let depth = 0; depth < maximumDepth && frontier.length; depth += 1) {
    const unique = new Map();
    frontier.forEach(node => {
      const moves = game.legalNextMoves(node.state, color);
      if (!moves.length || node.state.winner) {
        terminal.push(node);
        return;
      }
      moves.forEach(move => {
        const next = applyKnownShortSequence(game, node.state, [move], color);
        const candidate = { state: next, sequence: [...node.sequence, move] };
        const key = shortTacticalStateKey(next);
        const previous = unique.get(key);
        if (!previous || shortCanonicalSequenceKey(candidate.sequence, game, color, state)
          < shortCanonicalSequenceKey(previous.sequence, game, color, state)) {
          unique.set(key, candidate);
        }
      });
    });
    frontier = Array.from(unique.values());
  }

  terminal.push(...frontier);
  const maximumLength = Math.max(0, ...terminal.map(node => node.sequence.length));
  let complete = terminal.filter(node => node.sequence.length === maximumLength);
  const remainingValues = [...new Set(state.dice || [])];
  if (maximumLength === 1 && state.dice?.length === 2 && remainingValues.length === 2) {
    const high = Math.max(...remainingValues);
    const highDie = complete.filter(node => node.sequence[0]?.die === high);
    if (highDie.length) complete = highDie;
  }
  return complete
    .sort((left, right) => shortCanonicalSequenceKey(left.sequence, game, color, state)
      .localeCompare(shortCanonicalSequenceKey(right.sequence, game, color, state)))
    .map(node => node.sequence);
}

function shortTacticalMoveSequences(game, state, color, limit, fallbackSequences = []) {
  const maximumDepth = Math.max(1, state.dice?.length || 0);
  let frontier = [{
    state: JSON.parse(JSON.stringify(state || {})),
    sequence: [],
    features: { hits: 0, entries: 0, offGain: 0, terminal: 0 },
    rootKey: '',
  }];
  const terminal = [];

  for (let depth = 0; depth < maximumDepth && frontier.length; depth += 1) {
    const expanded = [];
    frontier.forEach(node => {
      const moves = game.legalNextMoves(node.state, color);
      if (!moves.length || node.state.winner) {
        terminal.push(node);
        return;
      }
      moves.forEach(rawMove => {
        const target = rawMove.bearOff ? null : node.state.points?.[rawMove.to];
        const move = {
          ...rawMove,
          hit: Boolean(target?.color && target.color !== color && Number(target.count) === 1),
        };
        const next = applyKnownShortSequence(game, node.state, [move], color);
        const features = {
          hits: node.features.hits + (move.hit ? 1 : 0),
          entries: node.features.entries + (Number(move.from) === game.barPoint(color) ? 1 : 0),
          offGain: node.features.offGain + (move.bearOff ? 1 : 0),
          terminal: next.winner === color ? 1 : 0,
        };
        expanded.push({
          state: next,
          sequence: [...node.sequence, move],
          features,
          rootKey: node.rootKey || shortCanonicalMoveKey(move, game, color, state),
        });
      });
    });

    const unique = new Map();
    expanded.forEach(node => {
      const key = shortTacticalStateKey(node.state);
      const previous = unique.get(key);
      if (!previous || compareShortTacticalNodes(node, previous, game, color) < 0) unique.set(key, node);
    });
    frontier = selectShortTacticalBeam(Array.from(unique.values()), limit, game, color);
  }

  terminal.push(...frontier);
  const fallback = (fallbackSequences || []).filter(sequence => sequence?.length).map(sequence => {
    const after = applyKnownShortSequence(game, state, sequence, color);
    const opponent = game.opponentOf(color);
    return {
      state: after,
      sequence,
      features: {
        hits: Math.max(0, (Number(after.bar?.[opponent]) || 0) - (Number(state.bar?.[opponent]) || 0)),
        entries: Math.max(0, (Number(state.bar?.[color]) || 0) - (Number(after.bar?.[color]) || 0)),
        offGain: Math.max(0, (Number(after.off?.[color]) || 0) - (Number(state.off?.[color]) || 0)),
        terminal: after.winner === color ? 1 : 0,
      },
      rootKey: shortCanonicalMoveKey(sequence[0], game, color, state),
    };
  });
  const candidates = [...terminal, ...fallback];
  const maxLength = Math.max(0, ...candidates.map(node => node.sequence.length));
  let complete = selectShortTacticalBeam(
    candidates.filter(node => node.sequence.length === maxLength),
    limit,
    game,
    color,
  );
  const remainingValues = [...new Set(state.dice || [])];
  if (maxLength === 1 && state.dice?.length === 2 && remainingValues.length === 2) {
    const high = Math.max(...remainingValues);
    const highDie = complete.filter(node => node.sequence[0]?.die === high);
    if (highDie.length) complete = highDie;
  }
  return complete.map(node => node.sequence);
}

function selectShortTacticalBeam(nodes, limit, game, color) {
  const ordered = nodes
    .slice()
    .sort((left, right) => compareShortTacticalNodes(left, right, game, color));
  const selected = [];
  const signatures = new Set();
  const add = node => {
    if (!node || selected.length >= limit) return;
    const signature = shortTacticalStateKey(node.state);
    if (signatures.has(signature)) return;
    selected.push(node);
    signatures.add(signature);
  };
  const reserveStrongest = feature => ordered
    .filter(node => Number(node.features?.[feature]) > 0)
    .slice(0, Math.max(2, Math.ceil(limit / 8)))
    .forEach(add);

  reserveStrongest('terminal');
  reserveStrongest('hits');
  reserveStrongest('entries');
  reserveStrongest('offGain');

  const rootRepresentatives = new Map();
  ordered.forEach(node => {
    if (!rootRepresentatives.has(node.rootKey)) rootRepresentatives.set(node.rootKey, node);
  });
  rootRepresentatives.forEach(add);

  const endpointRepresentatives = new Map();
  ordered.forEach(node => {
    const last = node.sequence[node.sequence.length - 1];
    const key = shortCanonicalMoveKey(last, game, color, node.state);
    if (!endpointRepresentatives.has(key)) endpointRepresentatives.set(key, node);
  });
  endpointRepresentatives.forEach(add);
  ordered.forEach(add);
  return selected.sort((left, right) => compareShortTacticalNodes(left, right, game, color));
}

function compareShortTacticalNodes(left, right, game, color) {
  const scoreDifference = shortTacticalNodePriority(right, game, color)
    - shortTacticalNodePriority(left, game, color);
  if (scoreDifference) return scoreDifference;
  return shortCanonicalSequenceKey(left.sequence, game, color, left.state)
    .localeCompare(shortCanonicalSequenceKey(right.sequence, game, color, right.state));
}

function shortTacticalNodePriority(node, game, color) {
  const opponent = game.opponentOf(color);
  const made = Object.values(node.state.points || {}).reduce((total, point) => (
    total + (point.color === color && Number(point.count) >= 2 ? 1 : 0)
  ), 0);
  return Number(node.features.terminal) * 1_000_000_000
    + Number(node.features.hits) * 20_000_000
    + Number(node.features.entries) * 4_000_000
    + (Number(node.state.off?.[color]) || 0) * 1_000_000
    + (Number(node.state.bar?.[opponent]) || 0) * 600_000
    - (Number(node.state.bar?.[color]) || 0) * 750_000
    - game.pipsFor(node.state, color) * 1200
    + made * 1800;
}

function shortCanonicalMoveKey(move, game, color, state) {
  if (!move) return '';
  const from = Number(move.from) === game.barPoint(color)
    ? -1
    : game.pathPos(color, Number(move.from), state);
  const to = move.bearOff || Number(move.to) === 0
    ? 24
    : game.pathPos(color, Number(move.to), state);
  return `${String(from).padStart(2, '0')}:${String(to).padStart(2, '0')}:${Number(move.die)}`;
}

function shortCanonicalSequenceKey(sequence, game, color, state) {
  return (sequence || []).map(move => shortCanonicalMoveKey(move, game, color, state)).join('|');
}

function shortTacticalStateKey(state) {
  const points = Object.entries(state.points || {})
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([point, stack]) => `${point}:${stack.color}:${stack.count}`)
    .join('|');
  return `${(state.dice || []).slice().sort().join(',')}|${state.bar?.white || 0}:${state.bar?.dark || 0}|${state.off?.white || 0}:${state.off?.dark || 0}|${points}`;
}

function applyKnownShortSequence(game, state, sequence, color) {
  const next = JSON.parse(JSON.stringify(state || {}));
  next.turn = color;
  next.phase = 'move';
  next.points ||= {};
  next.bar ||= { white: 0, dark: 0 };
  next.off ||= { white: 0, dark: 0 };
  next.score ||= { white: 0, dark: 0 };
  next.dice ||= [];
  next.turnMoves ||= [];
  const opponent = game.opponentOf(color);
  const barPoint = game.barPoint(color);

  (sequence || []).forEach(move => {
    const from = Number(move.from);
    const die = Number(move.die);
    const bearOff = Boolean(move.bearOff || Number(move.to) === 0);
    const to = bearOff ? 0 : Number(move.to || game.moveTo(color, from, die, next));
    if (from === barPoint) {
      next.bar[color] = Math.max(0, (Number(next.bar[color]) || 0) - 1);
    } else {
      const source = next.points[from];
      if (source?.color === color) {
        source.count -= 1;
        if (source.count <= 0) delete next.points[from];
      }
    }
    if (bearOff) {
      next.off[color] = (Number(next.off[color]) || 0) + 1;
      next.score[color] = (Number(next.score[color]) || 0) + 24 - game.pathPos(color, from, next);
    } else {
      const target = next.points[to];
      if (target?.color === opponent && Number(target.count) === 1) {
        next.bar[opponent] = (Number(next.bar[opponent]) || 0) + 1;
        delete next.points[to];
      }
      if (!next.points[to]) next.points[to] = { color, count: 0 };
      next.points[to].count += 1;
      next.score[color] = (Number(next.score[color]) || 0) + die;
    }
    const dieIndex = Number.isInteger(move.dieIndex) && next.dice[move.dieIndex] === die
      ? move.dieIndex
      : next.dice.indexOf(die);
    if (dieIndex !== -1) next.dice.splice(dieIndex, 1);
    next.turnMoves.push({ color, from, to, die, bearOff });
    if ((Number(next.off[color]) || 0) >= 15) {
      next.winner = color;
      next.resultType = game.resultTypeFor(next, color);
      next.phase = 'over';
    }
  });
  return next;
}


/* bot-engine/short/browser.ts */
const SHORT_ENGINE_VERSION = 'short-analytic-v3';

function createBrowserShortBotEngine(game, options = {}) {
  const engine = createShortBotEngine(createShortNarduGameAdapter(game), options);
  let lastDecision = null;
  return {
    plan(state, runtimeOptions = {}) {
      const color = state?.turn;
      if (!state || state.variant !== 'short' || !color) return [];
      const ranked = engine.rank(state, color, runtimeOptions);
      lastDecision = shortDecisionRecord(state, color, ranked, engine.experienceSize());
      return (ranked[0]?.sequence || []).map(move => ({ from: move.from, die: move.die }));
    },
    rank(state, runtimeOptions = {}) {
      if (!state || state.variant !== 'short' || !state.turn) return [];
      return engine.rank(state, state.turn, runtimeOptions);
    },
    describeSequence(state, sequence, runtimeOptions = {}) {
      const color = runtimeOptions.color || state?.turn;
      return state && color && sequence?.length
        ? engine.describeSequence(state, sequence, color)
        : null;
    },
    evaluateState: engine.evaluateState,
    setExperience: engine.setExperience,
    experienceSize: engine.experienceSize,
    consumeLastDecision() {
      const decision = lastDecision;
      lastDecision = null;
      return decision;
    },
    version: SHORT_ENGINE_VERSION,
  };
}

function shortDecisionRecord(state, color, ranked, experienceSize) {
  const candidates = ranked.slice(0, 4).map(candidate => ({
    score: Math.round(candidate.score),
    moves: candidate.sequence.map(move => ({
      from: move.from,
      to: move.bearOff ? 0 : move.to,
      die: move.die,
    })),
    features: { ...candidate.features },
    tactical: candidate.tactical ? { ...candidate.tactical } : null,
    experience: { ...candidate.experience },
    experienceAdjustment: Math.round(candidate.experienceAdjustment || 0),
  }));
  if (!candidates.length) return null;
  const source = `${color}|${(state.dice || []).join(',')}|${JSON.stringify(state.points)}|${JSON.stringify(state.bar)}|${JSON.stringify(state.off)}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    id: `sb1-${(hash >>> 0).toString(16).padStart(8, '0')}`,
    at: new Date().toISOString(),
    engineVersion: SHORT_ENGINE_VERSION,
    experienceSize,
    color,
    dice: [...(state.dice || [])],
    position: {
      points: JSON.parse(JSON.stringify(state.points || {})),
      bar: { white: Number(state.bar?.white) || 0, dark: Number(state.bar?.dark) || 0 },
      off: { white: Number(state.off?.white) || 0, dark: Number(state.off?.dark) || 0 },
    },
    selected: candidates[0],
    alternatives: candidates.slice(1),
    experience: candidates[0].experience,
  };
}

function installBrowserShortBotEngine(root = globalThis) {
  if (!root?.NarduGame) return null;
  const api = createBrowserShortBotEngine(root.NarduGame);
  root.NarduShortBotEngine = api;
  return api;
}

if (typeof window !== 'undefined') installBrowserShortBotEngine(window);

}());
