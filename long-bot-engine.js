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

function outsideHomePips(state, color) {
  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color) return total;
    const pos = pathPos(color, Number(point));
    return total + (pos >= 0 && pos < 18 ? stack.count * (18 - pos) : 0);
  }, 0);
}

function laggardRouteDebt(state, color) {
  if (headCheckers(state, color) > 0) return 0;
  const outside = Object.entries(state.points || {})
    .filter(([, stack]) => stack.color === color)
    .map(([point, stack]) => ({ pos: pathPos(color, Number(point)), count: Number(stack.count) || 0 }))
    .filter(item => item.pos >= 0 && item.pos < 18);
  if (!outside.length) return 0;

  const lastPos = Math.min(...outside.map(item => item.pos));
  return outside
    .filter(item => item.pos <= lastPos + 2)
    .reduce((total, item) => total + item.count * Math.pow(18 - item.pos, 2), 0);
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

function opponentHeadFreedomRisk(state, color) {
  const opponent = opponentOf(color);
  const opponentHeadCount = headCheckers(state, opponent);
  if (opponentHeadCount <= 2) return 0;
  const pressure = 1 + Math.max(0, opponentHeadCount - 4) / 4;
  let openLandings = 0;

  const landingRisk = HEAD_LANDING_DICE.reduce((risk, die) => {
    const target = pathFor(opponent)[die];
    const stack = target ? stackAt(state, target) : null;
    if (stack?.color === color) return risk;
    openLandings += 1;
    const dieWeight = headLandingDieWeight(die);
    const supported = stack?.color === opponent;
    return risk + dieWeight * (supported ? 5.4 : 3.7);
  }, 0);

  return pressure * (landingRisk + openLandings * openLandings * 1.35);
}

function opponentHeadFreedomMoveDelta(state, color, sequence = []) {
  const points = Object.fromEntries(
    Object.entries(state.points || {}).map(([point, stack]) => [point, { ...stack }]),
  );
  const after = { ...state, points };

  sequence.forEach(move => {
    const fromKey = String(move.from);
    const source = points[fromKey];
    if (source?.color === color) {
      source.count -= 1;
      if (source.count <= 0) delete points[fromKey];
    }
    if (move.bearOff || move.to === 0) return;
    const toKey = String(move.to);
    const target = points[toKey];
    if (target?.color === color) target.count += 1;
    else if (!target) points[toKey] = { color, count: 1 };
  });

  return opponentHeadFreedomRisk(state, color) - opponentHeadFreedomRisk(after, color);
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

function routeCompletionPressure(state, color) {
  const outside = outsideHomeCount(state, color);
  if (!outside) return 0;

  const opponent = opponentOf(color);
  const ownHome = homeBoardCount(state, color);
  const opponentOff = offCount(state, opponent);
  const opponentReady = homeReady(state, opponent);

  if (outside > 8 && opponentOff === 0 && !opponentReady) {
    return 0.18 + Math.min(0.32, ownHome * 0.025);
  }

  return Math.min(
    6.5,
    1
      + Math.max(0, 9 - outside) * 0.45
      + ownHome * 0.12
      + opponentOff * 0.62
      + (opponentReady ? 1.8 : 0),
  );
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

function fenceClosureRisk(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(color);
  let risk = 0;

  Object.entries(state.points || {}).forEach(([point, stack]) => {
    if (stack.color !== color) return;
    const pos = pathPos(color, Number(point));
    if (pos < 0 || pos >= 18) return;

    const checkerCount = Number(stack.count) || 0;
    for (let start = pos + 1; start <= Math.min(pos + 6, path.length - 6); start += 1) {
      const window = path.slice(start, start + 6);
      if (window.some(target => colorAt(state, target) === color)) continue;

      const blocked = window.filter(target => colorAt(state, target) === opponent).length;
      if (blocked < 3) continue;
      const reachableGaps = window.filter(target => (
        !colorAt(state, target) && canReachPoint(state, opponent, target)
      )).length;
      if (blocked + reachableGaps < 5) continue;

      const severity = blocked >= 5 ? 24 : blocked === 4 ? 7.5 : 2.2;
      const proximity = 1 + Math.max(0, 11 - pos) * 0.12;
      const headPressure = Number(point) === headPoint(color)
        ? 1 + Math.min(3.5, checkerCount * 0.28)
        : 1;
      risk += checkerCount * severity * proximity * headPressure
        * (1 + reachableGaps * 0.16);
    }
  });

  return risk;
}

function opponentHeadFenceBarrierScore(state, color) {
  const opponent = opponentOf(color);
  const opponentHead = headCheckers(state, opponent);
  if (opponentHead <= 2) return 0;
  const path = pathFor(opponent);
  const pressure = 1 + Math.max(0, opponentHead - 4) / 6;

  return [1, 2, 3, 4, 5, 6].reduce((score, die) => {
    const target = pathFor(opponent)[die];
    if (!target || colorAt(state, target) !== color) return score;

    let run = 1;
    for (let index = die - 1; index >= 0 && colorAt(state, path[index]) === opponent; index -= 1) {
      run += 1;
    }
    for (
      let index = die + 1;
      index < path.length && colorAt(state, path[index]) === opponent;
      index += 1
    ) {
      run += 1;
    }
    return score + (run >= 3 ? Math.pow(run, 3) * pressure : 0);
  }, 0);
}

function escapeGatewayRisk(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(color);
  const head = headPoint(color);
  let risk = 0;

  Object.entries(state.points || {}).forEach(([point, stack]) => {
    if (stack.color !== color) return;
    const pos = pathPos(color, Number(point));
    if (pos < 0 || pos >= 18) return;
    const targets = path.slice(pos + 1, pos + 7);
    const blocked = targets.filter(target => colorAt(state, target) === opponent).length;
    if (blocked < 3) return;

    const immediateOwnLandings = targets.filter(target => (
      colorAt(state, target) === color
      && gatewayHasMobility(state, color, pathPos(color, target))
    )).length;
    const extendedTargets = path.slice(pos + 7, pos + 13);
    const extendedOwnGateways = extendedTargets.filter(target => (
      colorAt(state, target) === color
      && canReachViaTwoDice(state, color, pos, pathPos(color, target))
      && gatewayHasMobility(state, color, pathPos(color, target))
    )).length;
    const ownLandings = immediateOwnLandings + extendedOwnGateways;
    const emptyLandings = targets.filter(target => !colorAt(state, target));
    const exposedEmpties = emptyLandings.filter(target => canReachPoint(state, opponent, target)).length;
    const checkerCount = Number(stack.count) || 0;
    const severity = checkerCount * Math.pow(blocked - 2, 2);
    const routePressure = 1 + Math.max(0, 12 - pos) * 0.14;
    const headPressure = Number(point) === head ? 1 + Math.min(3, checkerCount * 0.55) : 1;
    const supportFactor = ownLandings > 0 ? 0.18 : 1.15;
    const exposureFactor = exposedEmpties * 0.55;
    const narrowExitFactor = ownLandings + emptyLandings.length <= 1 ? 1.4 : 0;
    risk += severity * routePressure * headPressure
      * (supportFactor + exposureFactor + narrowExitFactor);
  });

  return risk;
}

function canReachViaTwoDice(state, color, fromPos, targetPos) {
  if (targetPos - fromPos < 7 || targetPos - fromPos > 12) return false;
  const opponent = opponentOf(color);
  const path = pathFor(color);
  for (let firstDie = 1; firstDie <= 6; firstDie += 1) {
    const secondDie = targetPos - fromPos - firstDie;
    if (secondDie < 1 || secondDie > 6) continue;
    const intermediate = path[fromPos + firstDie];
    if (intermediate && colorAt(state, intermediate) !== opponent) return true;
  }
  return false;
}

function gatewayHasMobility(state, color, gatewayPos) {
  const opponent = opponentOf(color);
  const path = pathFor(color);
  const exits = path.slice(gatewayPos + 1, gatewayPos + 7)
    .filter(target => colorAt(state, target) !== opponent)
    .length;
  return exits >= 2;
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

function entryContinuationMoveCount(sequence = [], color) {
  let total = 0;
  let trackedPoint = null;

  sequence.forEach(move => {
    const fromPos = pathPos(color, move.from);
    const toPos = move.bearOff || move.to === 0 ? 24 : pathPos(color, move.to);
    if (trackedPoint !== null && Number(move.from) === trackedPoint && toPos > fromPos) {
      total += 1;
      trackedPoint = move.bearOff || move.to === 0 ? null : Number(move.to);
      return;
    }
    trackedPoint = fromPos >= 12 && fromPos < 18 && toPos >= 18
      ? Number(move.to)
      : null;
  });

  return total;
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
  opponentHeadFreedom: 48000,
  escapeGatewayRisk: 800000,
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
  const ownFenceClosureRisk = fenceClosureRisk(state, color);
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
    - opponentHeadFreedomRisk(state, color) * weights.opponentHeadFreedom
    + footholdScore(state, color) * weights.foothold
    - footholdScore(state, opponent) * weights.foothold * 0.38
    - headLandingExposureRisk(state, color) * weights.headLandingExposure
    + headLandingExposureRisk(state, opponent) * weights.headLandingExposure * 0.18
    - prematureHomeRushPenalty(state, color) * weights.rushPenalty
    - entryZoneOutsideCount(state, color) * weights.homeEntry * entryPressure
    + entryZoneOutsideCount(state, opponent) * weights.homeEntry * lateEntryPressure(state, opponent) * 0.34
    - ownTrapRisk * weights.trapRisk
    - ownFenceClosureRisk * weights.trapRisk * 1.45
    + opponentTrapReward * weights.trapRisk * 0.055
    - escapeGatewayRisk(state, color) * weights.escapeGatewayRisk
    + escapeGatewayRisk(state, opponent) * weights.escapeGatewayRisk * 0.12;
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
  const outsideReduction = Math.max(0, outsideHomeCount(before, color) - outsideHomeCount(after, color));
  const outsidePipGain = Math.max(0, outsideHomePips(before, color) - outsideHomePips(after, color));
  const laggardDebtDelta = laggardRouteDebt(before, color) - laggardRouteDebt(after, color);
  const homeEntryMoves = homeEntryMoveCount(sequence, color);
  const trapDelta = opponentTrapRisk(before, color) - opponentTrapRisk(after, color);
  const trapBefore = opponentTrapRisk(before, color);
  const fenceClosureDelta = fenceClosureRisk(before, color) - fenceClosureRisk(after, color);
  const fenceClosureBefore = fenceClosureRisk(before, color);
  const opponent = opponentOf(color);
  const opponentTrapGain = Math.max(0, opponentTrapRisk(after, opponent) - opponentTrapRisk(before, opponent));
  const headLandingBreak = headLandingBreakRisk(before, after, color);
  const outsideDevelopmentMoves = outsideDevelopmentMoveCount(sequence, color);
  const entryContinuationMoves = entryContinuationMoveCount(sequence, color);
  const opponentHeadFreedomDelta = opponentHeadFreedomRisk(before, color)
    - opponentHeadFreedomRisk(after, color);
  const opponentHeadBarrierDelta = opponentHeadFenceBarrierScore(after, color)
    - opponentHeadFenceBarrierScore(before, color);
  const escapeGatewayDelta = escapeGatewayRisk(before, color) - escapeGatewayRisk(after, color);
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
    outsidePipGain,
    laggardDebtDelta,
    homeEntryMoves,
    trapDelta,
    trapBefore,
    fenceClosureDelta,
    fenceClosureBefore,
    opponentTrapGain,
    headLandingBreak,
    outsideDevelopmentMoves,
    entryContinuationMoves,
    opponentHeadFreedomDelta,
    opponentHeadBarrierDelta,
    escapeGatewayDelta,
    bearOffMoves,
    homeShuffleMoves,
  };
}

function scoreSequence(before, after, color, sequence = [], weights = DEFAULT_LONG_BOT_WEIGHTS) {
  const stats = sequenceStats(before, after, color, sequence);
  const pressure = phasePressure(before, color);
  const entryPressure = lateEntryPressure(before, color);
  const completionPressure = routeCompletionPressure(before, color);
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
  score += stats.outsideReduction * weights.homeEntry * 18 * completionPressure;
  score += stats.outsidePipGain * weights.tempo * 0.52 * completionPressure;
  score += stats.laggardDebtDelta * weights.homeEntry;
  score += stats.trapDelta * weights.trapRisk * 1.8;
  score += stats.fenceClosureDelta * weights.trapRisk * 2.35;
  score += cappedTrapReward(stats.opponentTrapGain) * weights.trapRisk * 0.08;
  score -= stats.headLandingBreak * weights.headLandingExposure * 1.35;
  score += stats.opponentHeadFreedomDelta * weights.opponentHeadFreedom * 1.55;
  score += stats.opponentHeadBarrierDelta * weights.opponentHeadFreedom * 0.55;
  score += stats.escapeGatewayDelta * weights.escapeGatewayRisk * 1.6;
  score += stats.outsideDevelopmentMoves * weights.homeEntry * 0.88 * development;
  score += stats.entryContinuationMoves * weights.tempo * 0.42;
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
      * Math.max(1, development)
      * Math.max(1, completionPressure);
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


/* bot-engine/long/analysis.ts */


const MAX_REPLY_SEQUENCES = 10;
const MAX_TACTICAL_CANDIDATES = 6;
const MAX_EXPERIENCE_PENALTY = 2600000;

const TACTICAL_ROLLS = [
  { dice: [6, 6], weight: 1 },
  { dice: [6, 5], weight: 2 },
  { dice: [5, 5], weight: 1 },
  { dice: [6, 4], weight: 2 },
  { dice: [5, 4], weight: 2 },
  { dice: [4, 4], weight: 1 },
  { dice: [6, 3], weight: 2 },
  { dice: [5, 3], weight: 2 },
  { dice: [4, 3], weight: 2 },
  { dice: [3, 3], weight: 1 },
  { dice: [6, 2], weight: 2 },
  { dice: [5, 2], weight: 2 },
  { dice: [4, 2], weight: 2 },
  { dice: [3, 2], weight: 2 },
  { dice: [2, 2], weight: 1 },
  { dice: [6, 1], weight: 2 },
  { dice: [5, 1], weight: 2 },
  { dice: [4, 1], weight: 2 },
  { dice: [3, 1], weight: 2 },
  { dice: [2, 1], weight: 2 },
  { dice: [1, 1], weight: 1 },
];

function analyzeOpponentReplies(
  adapter,
  color,
  candidates,
  weights,
  deadline,
) {
  const tacticalCandidates = candidates.slice(0, MAX_TACTICAL_CANDIDATES);
  if (tacticalCandidates.length < 2 || Date.now() >= deadline) return candidates;

  const opponent = opponentOf(color);
  const accumulators = tacticalCandidates.map(candidate => ({
    candidate,
    expectedImpact: 0,
    weight: 0,
    worstImpact: 0,
    rolls: 0,
  }));

  for (const roll of TACTICAL_ROLLS) {
    if (Date.now() >= deadline) break;
    let completedRoll = true;
    const rollResults = [];

    for (const accumulator of accumulators) {
      if (Date.now() >= deadline) {
        completedRoll = false;
        break;
      }
      const replyState = prepareReplyState(accumulator.candidate.after, opponent, roll.dice);
      const replySequences = sampledSequences(
        adapter.legalSequences(replyState, opponent),
        MAX_REPLY_SEQUENCES,
      );
      const beforeValue = evaluateState(replyState, color, weights);
      let worstValue = beforeValue;

      for (const reply of replySequences) {
        const replyAfter = adapter.applySequence(replyState, reply, opponent);
        const opponentGain = scoreSequence(replyState, replyAfter, opponent, reply, weights);
        const ownValue = evaluateState(replyAfter, color, weights);
        const replyValue = ownValue - Math.max(0, opponentGain) * 0.08;
        worstValue = Math.min(worstValue, replyValue);
      }
      rollResults.push(worstValue - beforeValue);
    }

    if (!completedRoll) break;
    rollResults.forEach((impact, index) => {
      const accumulator = accumulators[index];
      accumulator.expectedImpact += impact * roll.weight;
      accumulator.weight += roll.weight;
      accumulator.worstImpact = Math.min(accumulator.worstImpact, impact);
      accumulator.rolls += 1;
    });
  }

  accumulators.forEach((accumulator) => {
    if (!accumulator.weight) return;
    const expectedImpact = accumulator.expectedImpact / accumulator.weight;
    const tacticalAdjustment = expectedImpact * 0.42
      + accumulator.worstImpact * 0.14 * threatPressure(accumulator.candidate.after, color);
    accumulator.candidate.score += tacticalAdjustment;
    accumulator.candidate.tactical = {
      expectedImpact,
      worstImpact: accumulator.worstImpact,
      rolls: accumulator.rolls,
      adjustment: tacticalAdjustment,
    };
  });

  return candidates.sort((left, right) => right.score - left.score);
}

function threatPressure(state, color) {
  const opponent = opponentOf(color);
  const raceLead = Math.max(0, pipsFor(state, opponent) - pipsFor(state, color));
  return Math.min(3.4, 1
    + Math.min(1.2, raceLead / 42)
    + offCount(state, opponent) * 0.12
    + (homeReady(state, opponent) ? 0.75 : 0));
}

function experienceDescriptor(
  state,
  color,
  features,
  tactical = null,
) {
  const opponent = opponentOf(color);
  const ownHead = headCheckers(state, color);
  const outside = outsideHomeCount(state, color);
  const opponentOff = offCount(state, opponent);
  const ownOff = offCount(state, color);
  const trap = opponentTrapRisk(state, color);
  const pipDelta = pipsFor(state, color) - pipsFor(state, opponent);
  const phase = homeReady(state, color)
    ? 'bearoff'
    : opponentOff > 0 && ownOff === 0
      ? 'koks-rescue'
      : outside <= 4
        ? 'late-entry'
        : ownHead > 0
          ? 'head-development'
          : 'route';
  const contextKey = [
    phase,
    bucket('h', ownHead, [0, 1, 3, 7]),
    bucket('o', outside, [0, 2, 5, 9]),
    bucket('po', opponentOff, [0, 1, 5, 10]),
    bucket('tr', trap, [0, 40, 180, 600]),
    bucket('pd', pipDelta, [-36, -8, 9, 37]),
  ].join('|');

  const actionKey = [
    signedFlag('head', features.headGain),
    signedFlag('entry', features.outsideReduction),
    signedFlag('trap', features.trapDelta),
    signedFlag('freedom', features.opponentHeadFreedomDelta),
    signedFlag('distribution', features.distributionDelta),
    Number(features.headLandingBreak || 0) > 0 ? 'support:break' : 'support:keep',
    Number(features.homeShuffleMoves || 0) > 0 ? 'home:shuffle' : 'home:steady',
    Number(features.bearOffMoves || 0) > 0 ? 'off:yes' : 'off:no',
  ].join('|');

  const urgency = 1
    + opponentOff * 0.12
    + (homeReady(state, opponent) ? 0.65 : 0)
    + (phase === 'koks-rescue' ? 0.8 : 0);
  let mistakeSeverity = 0;
  mistakeSeverity += Math.min(3, Math.max(0, Number(features.headLandingBreak) || 0)) * 0.9;
  mistakeSeverity += Math.max(0, -(Number(features.opponentHeadFreedomDelta) || 0)) * 0.14;
  mistakeSeverity += Math.max(0, -(Number(features.fenceClosureDelta) || 0)) * 0.18;
  if (Number(features.trapBefore || 0) > 0 && Number(features.trapDelta || 0) <= 0) {
    mistakeSeverity += Math.min(2.4, Number(features.trapBefore) / 180);
  }
  if (outside > 0 && Number(features.homeShuffleMoves || 0) > 0 && Number(features.outsideReduction || 0) <= 0) {
    mistakeSeverity += 1.15 + Math.min(1.2, outside / 8);
  }
  if (ownHead > 0 && Number(features.headGain || 0) <= 0 && (ownHead <= 2 || opponentOff > 0)) {
    mistakeSeverity += 1.4;
  }
  if (tactical && Number(tactical.worstImpact) < -4000000) {
    mistakeSeverity += Math.min(2.2, Math.abs(Number(tactical.worstImpact)) / 16000000);
  }

  return {
    contextKey,
    actionKey,
    mistakeSeverity: Math.min(8, mistakeSeverity * urgency),
    phase,
  };
}

function normalizeExperiencePatterns(patterns = []) {
  const normalized = new Map();
  (Array.isArray(patterns) ? patterns : []).forEach((pattern) => {
    const contextKey = String(pattern?.contextKey || pattern?.context_key || '');
    const actionKey = String(pattern?.actionKey || pattern?.action_key || '');
    if (!contextKey || !actionKey) return;
    const key = `${contextKey}::${actionKey}`;
    const contribution = {
      contextKey,
      actionKey,
      samples: Math.max(0, Number(pattern.samples) || 0),
      losses: Math.max(0, Number(pattern.losses) || 0),
      severeLosses: Math.max(
        0,
        Number(pattern.severeLosses ?? pattern.severe_losses) || 0,
      ),
      signalWeight: Math.max(
        0,
        Number(pattern.signalWeight ?? pattern.signal_weight) || 0,
      ),
    };
    mergePattern(normalized, key, contribution, contextKey, actionKey);

    const phase = contextKey.split('|')[0] || 'route';
    mergePattern(normalized, `phase:${phase}::${actionKey}`, contribution, phase, actionKey);
    mergePattern(normalized, `*::${actionKey}`, contribution, '*', actionKey);
  });
  return normalized;
}

function experienceAdjustment(descriptor, experience) {
  if (!descriptor || !(experience instanceof Map)) return 0;
  const phase = descriptor.phase || String(descriptor.contextKey || '').split('|')[0] || 'route';
  const pattern = [
    experience.get(`${descriptor.contextKey}::${descriptor.actionKey}`),
    experience.get(`phase:${phase}::${descriptor.actionKey}`),
    experience.get(`*::${descriptor.actionKey}`),
  ].find(candidate => candidate?.samples >= 2);
  if (!pattern || pattern.samples < 2 || descriptor.mistakeSeverity <= 0) return 0;

  const lossRate = (pattern.losses + 1) / (pattern.samples + 2);
  if (lossRate <= 0.55) return 0;
  const severeRate = pattern.severeLosses / Math.max(1, pattern.samples);
  const confidence = Math.min(0.88, pattern.samples / (pattern.samples + 6));
  const learnedSeverity = Math.min(
    4,
    pattern.signalWeight / Math.max(1, pattern.samples),
  );
  const penalty = (
    280000
    * confidence
    * (lossRate - 0.5)
    * (1 + severeRate * 1.8)
    * (1 + learnedSeverity * 0.28)
    * Math.min(4, descriptor.mistakeSeverity)
  );
  return -Math.min(MAX_EXPERIENCE_PENALTY, penalty);
}

function mergePattern(target, key, pattern, contextKey, actionKey) {
  const current = target.get(key) || {
    contextKey,
    actionKey,
    samples: 0,
    losses: 0,
    severeLosses: 0,
    signalWeight: 0,
  };
  current.samples += pattern.samples;
  current.losses += pattern.losses;
  current.severeLosses += pattern.severeLosses;
  current.signalWeight += pattern.signalWeight;
  target.set(key, current);
}

function prepareReplyState(state, color, dice) {
  return {
    ...state,
    turn: color,
    phase: 'move',
    dice: [...dice],
    rolled: [...dice],
    turnMoves: [],
    headPlayedThisTurn: {
      ...(state.headPlayedThisTurn || {}),
      [color]: false,
    },
  };
}

function sampledSequences(sequences, limit) {
  const legal = (Array.isArray(sequences) ? sequences : []).filter(sequence => sequence?.length);
  if (legal.length <= limit) return legal;
  const sampled = [];
  const seen = new Set();
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round(index * (legal.length - 1) / Math.max(1, limit - 1));
    const sequence = legal[sourceIndex];
    const key = sequence.map(move => `${move.from}:${move.die}`).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    sampled.push(sequence);
  }
  return sampled;
}

function bucket(prefix, value, thresholds) {
  const number = Number(value) || 0;
  const index = thresholds.findIndex(threshold => number <= threshold);
  return `${prefix}${index < 0 ? thresholds.length : index}`;
}

function signedFlag(name, value) {
  const number = Number(value) || 0;
  return `${name}:${number > 0.001 ? 'gain' : number < -0.001 ? 'loss' : 'flat'}`;
}


/* bot-engine/long/engine.ts */



const DEFAULT_MAX_CANDIDATES = 64;
const DEFAULT_TIME_LIMIT_MS = 1600;

function createLongBotEngine(adapter, options = {}) {
  const defaultWeights = mergeWeights(options.weights);
  const defaultMaxCandidates = Number(options.maxCandidates) || DEFAULT_MAX_CANDIDATES;
  const defaultTimeLimitMs = Number(options.timeLimitMs) || DEFAULT_TIME_LIMIT_MS;
  const experienceSources = new Map();
  let experience = new Map();

  function rank(state, color = state.turn, runtimeOptions = {}) {
    if (!color) return [];
    const weights = mergeWeights({ ...defaultWeights, ...(runtimeOptions.weights || {}) });
    const startedAt = Date.now();
    const maxCandidates = Number(runtimeOptions.maxCandidates) || defaultMaxCandidates;
    const timeLimitMs = Number(runtimeOptions.timeLimitMs) || defaultTimeLimitMs;
    const deadline = startedAt + timeLimitMs;
    const staticDeadline = startedAt + Math.max(140, timeLimitMs * 0.42);
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
        features: sequenceStats(state, after, color, sequence),
      });
      if (Date.now() >= staticDeadline && ranked.length >= 12) break;
    }

    ranked.forEach((candidate) => {
      candidate.baseScore = candidate.score;
      candidate.score += strategicSafetyAdjustment(state, color, candidate.features);
      candidate.experience = experienceDescriptor(state, color, candidate.features);
      candidate.experienceAdjustment = experienceAdjustment(candidate.experience, experience);
      candidate.score += candidate.experienceAdjustment;
    });

    const strategicallyRanked = prioritizeForcedRacePlay(state, color, ranked)
      .sort((left, right) => right.score - left.score);
    analyzeOpponentReplies(adapter, color, strategicallyRanked, weights, deadline);
    strategicallyRanked.forEach((candidate) => {
      const previousExperienceAdjustment = Number(candidate.experienceAdjustment) || 0;
      candidate.experience = experienceDescriptor(
        state,
        color,
        candidate.features,
        candidate.tactical,
      );
      candidate.experienceAdjustment = experienceAdjustment(candidate.experience, experience);
      candidate.score += candidate.experienceAdjustment - previousExperienceAdjustment;
    });
    return strategicallyRanked.sort((left, right) => right.score - left.score);
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
    setExperience(patterns = [], source = 'runtime') {
      experienceSources.set(String(source || 'runtime'), Array.isArray(patterns) ? patterns : []);
      experience = normalizeExperiencePatterns(
        Array.from(experienceSources.values()).flat(),
      );
      return experience.size;
    },
    experienceSize() {
      return experience.size;
    },
  };
}

function prefilterSequences(state, color, sequences, maxCandidates) {
  const ready = homeReady(state, color);
  const entryPressure = lateEntryPressure(state, color);
  const trapPressure = opponentTrapRisk(state, color);
  const development = developmentPressure(state, color);

  const head = headPoint(color);
  const scored = sequences
    .map(sequence => {
      const offMoves = sequence.reduce((total, move) => total + (move.bearOff || move.to === 0 ? 1 : 0), 0);
      const roughPips = sequence.reduce((total, move) => total + Number(move.die || 0), 0);
      const homeShuffle = ready ? sequence.length - offMoves : 0;
      const homeEntries = homeEntryMoveCount(sequence, color);
      const insideHomeMoves = homeShuffleMoveCount(sequence, color);
      const outsideMoves = sequence.reduce((total, move) => total + (pathPos(color, move.from) < 18 ? 1 : 0), 0);
      const headMoves = sequence.reduce(
        (total, move) => total + (Number(move.from) === Number(head) ? 1 : 0),
        0,
      );
      const opponentHeadControlGain = opponentHeadFreedomMoveDelta(state, color, sequence);
      return {
        sequence,
        offMoves,
        homeEntries,
        outsideMoves,
        headMoves,
        homeShuffle: insideHomeMoves,
        priority: (ready ? offMoves * 100000 - homeShuffle * 20000 : 0)
          + homeEntries * 65000 * entryPressure
          - insideHomeMoves * 26000 * Math.max(1, entryPressure) * Math.max(1, development)
          + outsideMoves * Math.min(90000, trapPressure * 320)
          + headMoves * (
            headCheckers(state, color) >= 7
              ? 250000 + headCheckers(state, color) * 30000
              : headCheckers(state, color) <= 2
                ? 180000
                : 95000
          )
          + opponentHeadControlGain * 18000
          + roughPips * 120
          + offCount(state, color) * 10
          - pipsFor(state, color) * 0.01,
      };
    })
    .sort((a, b) => b.priority - a.priority);

  const selected = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || selected.length >= maxCandidates) return;
    const key = item.sequence.map(move => `${move.from}:${move.die}`).join(',');
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(item.sequence);
  };
  const bestBy = (predicate, compare) => scored.filter(predicate).sort(compare)[0];

  add(bestBy(item => item.headMoves > 0, (a, b) => b.priority - a.priority));
  add(bestBy(item => item.homeEntries > 0, (a, b) => (
    b.homeEntries - a.homeEntries || b.priority - a.priority
  )));
  add(bestBy(item => item.outsideMoves > 0, (a, b) => (
    b.outsideMoves - a.outsideMoves || b.priority - a.priority
  )));
  add(bestBy(item => item.homeShuffle === 0, (a, b) => b.priority - a.priority));
  add(bestBy(item => item.offMoves > 0, (a, b) => (
    b.offMoves - a.offMoves || b.priority - a.priority
  )));
  scored.forEach(add);
  return selected;
}

function prioritizeForcedRacePlay(state, color, ranked) {
  if (!ranked.length) return ranked;
  if (homeReady(state, color)) {
    const maxOff = Math.max(...ranked.map(candidate => Number(candidate.features.offGain) || 0));
    return ranked.filter(candidate => Number(candidate.features.offGain) === maxOff);
  }

  const opponent = opponentOf(color);
  const outside = outsideHomeCount(state, color);
  const opponentOff = offCount(state, opponent);
  const trapPressure = opponentTrapRisk(state, color);
  const maxEntry = Math.max(...ranked.map(candidate => Number(candidate.features.outsideReduction) || 0));
  const maxHeadRelease = Math.max(...ranked.map(candidate => Number(candidate.features.headGain) || 0));
  const headRemaining = headCheckers(state, color);
  const urgentHeadRelease = headCheckers(state, color) > 0
    && maxHeadRelease > 0
    && (
      headCheckers(state, color) <= 2
      || opponentOff > 0
      || homeReady(state, opponent)
      || trapPressure > 80
    );

  ranked.forEach((candidate) => {
    const features = candidate.features;
    if (headRemaining >= 7 && maxHeadRelease > 0) {
      const release = Number(features.headGain || 0);
      const developmentScale = 52000000 + headRemaining * 5200000;
      candidate.score += release * developmentScale;
      if (release < maxHeadRelease) candidate.score -= developmentScale * 0.72;
      if (release <= 0 && Number(features.outsideReduction || 0) > 0) {
        candidate.score -= 26000000 + headRemaining * 2800000;
      }
    } else if (headRemaining >= 4 && maxHeadRelease > 0) {
      candidate.score += Number(features.headGain || 0) * 18000000;
    }
    if (urgentHeadRelease) {
      candidate.score += Number(features.headGain || 0) * 36000000;
      if (Number(features.headGain || 0) < maxHeadRelease) candidate.score -= 28000000;
    }
    if (outside <= 4 && maxEntry > 0) {
      candidate.score += Number(features.outsideReduction || 0)
        * (14000000 + opponentOff * 3500000);
      if (Number(features.outsideReduction || 0) < maxEntry) {
        candidate.score -= (maxEntry - Number(features.outsideReduction || 0))
          * (9000000 + opponentOff * 2200000);
      }
    }
    if (trapPressure > 850 && maxEntry > 0) {
      const entry = Number(features.outsideReduction || 0);
      const trapScale = Math.min(72000000, trapPressure * 52000);
      candidate.score += entry * (18000000 + trapScale);
      if (entry < maxEntry) {
        candidate.score -= (maxEntry - entry) * (16000000 + trapScale * 0.82);
      }
      candidate.score -= Number(features.homeShuffleMoves || 0)
        * (12000000 + trapScale * 0.72);
    }
    if (trapPressure < 120 && headRemaining >= 7 && maxHeadRelease > 0) {
      candidate.score += Number(features.headGain || 0) * 24000000;
      candidate.score -= Number(features.homeEntryMoves || 0) * 18000000;
    }
    if (opponentOff >= 3 && offCount(state, color) === 0) {
      candidate.score += Number(features.bearOffMoves || 0) * 42000000;
      candidate.score += Number(features.outsideReduction || 0) * 15000000;
      candidate.score += Number(features.headGain || 0) * 12000000;
      candidate.score -= Number(features.homeShuffleMoves || 0) * 14000000;
    }
  });
  return ranked;
}

function strategicSafetyAdjustment(state, color, features) {
  const opponent = opponentOf(color);
  const opponentOff = offCount(state, opponent);
  const outside = outsideHomeCount(state, color);
  let score = 0;

  score -= Math.max(0, Number(features.headLandingBreak) || 0)
    * (4200000 + headCheckers(state, color) * 620000);
  score += Number(features.opponentHeadFreedomDelta || 0)
    * (2200000 + Math.max(0, headCheckers(state, opponent) - 2) * 240000);
  if (Number(features.trapBefore || 0) > 0) {
    score += Number(features.trapDelta || 0) * (380000 + opponentOff * 70000);
    if (Number(features.trapDelta || 0) <= 0) {
      score -= Math.min(24000000, Number(features.trapBefore) * 68000);
    }
  }
  if (Number(features.fenceClosureBefore || 0) > 0) {
    score += Number(features.fenceClosureDelta || 0) * 950000;
    if (Number(features.fenceClosureDelta || 0) < 0) {
      score += Number(features.fenceClosureDelta || 0) * 1800000;
    }
  }
  if (outside > 0 && Number(features.homeShuffleMoves || 0) > 0) {
    score -= Number(features.homeShuffleMoves)
      * (3800000 + Math.max(0, 6 - outside) * 1600000 + opponentOff * 1100000);
  }
  if (outside > 0 && Number(features.homeShuffleMoves || 0) > 0 && Number(features.trapBefore || 0) > 850) {
    score -= Number(features.homeShuffleMoves)
      * Math.min(160000000, Number(features.trapBefore) * 9500);
  }
  score += Math.max(0, Number(features.laggardDebtDelta) || 0)
    * (155000 + developmentPressure(state, color) * 42000);
  return score;
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


const ENGINE_VERSION = 'long-analytic-v10';

function createBrowserLongBotEngine(game, options = {}) {
  const adapter = createNarduGameAdapter(game);
  const engine = createLongBotEngine(adapter, options);
  let lastDecision = null;

  return {
    plan(state, runtimeOptions = {}) {
      const color = state?.turn;
      if (!state || (state.variant && state.variant !== 'long') || !color) return [];
      const ranked = engine.rank(state, color, runtimeOptions);
      lastDecision = decisionRecord(state, color, ranked, runtimeOptions.weights);
      return (ranked[0]?.sequence || []).map(move => ({ from: move.from, die: move.die }));
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

    setExperience(patterns, source = 'runtime') {
      return engine.setExperience(patterns, source);
    },

    experienceSize() {
      return engine.experienceSize();
    },

    consumeLastDecision() {
      const decision = lastDecision;
      lastDecision = null;
      return decision;
    },

    version: ENGINE_VERSION,
  };
}

function decisionRecord(state, color, ranked, weights = undefined) {
  const candidates = ranked.slice(0, 4).map(candidate => ({
    score: Math.round(candidate.score),
    moves: candidate.sequence.map(move => ({
      from: move.from,
      to: move.bearOff ? 0 : move.to,
      die: move.die,
    })),
    features: { ...(candidate.features || {}) },
    tactical: candidate.tactical ? {
      expectedImpact: Math.round(candidate.tactical.expectedImpact),
      worstImpact: Math.round(candidate.tactical.worstImpact),
      rolls: candidate.tactical.rolls,
      adjustment: Math.round(candidate.tactical.adjustment),
    } : null,
    experience: candidate.experience ? { ...candidate.experience } : null,
    experienceAdjustment: Math.round(Number(candidate.experienceAdjustment) || 0),
  }));
  if (!candidates.length) return null;

  return {
    id: positionFingerprint(state, color),
    at: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    weights: weights && typeof weights === 'object'
      ? Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Math.round(Number(value) || 0)]))
      : {},
    color,
    dice: [...(state.dice || [])],
    position: {
      points: JSON.parse(JSON.stringify(state.points || {})),
      off: { white: Number(state.off?.white) || 0, dark: Number(state.off?.dark) || 0 },
    },
    selected: candidates[0],
    alternatives: candidates.slice(1),
    experience: candidates[0].experience ? { ...candidates[0].experience } : null,
  };
}

function positionFingerprint(state, color) {
  const points = Object.entries(state.points || {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([point, stack]) => `${point}:${stack.color[0]}${stack.count}`)
    .join(',');
  const source = `${color}|${(state.dice || []).join(',')}|${points}|${state.off?.white || 0}:${state.off?.dark || 0}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `lb4-${(hash >>> 0).toString(16).padStart(8, '0')}`;
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
