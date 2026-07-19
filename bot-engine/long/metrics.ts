import type { LongBotColor, LongBotState } from './types.ts';

export const LONG_PATHS = {
  white: [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  dark: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13],
};

const HEAD_LANDING_DICE = [1, 3, 5, 6];

export function opponentOf(color) {
  return color === 'white' ? 'dark' : 'white';
}

export function pathFor(color) {
  return LONG_PATHS[color] || LONG_PATHS.white;
}

export function headPoint(color) {
  return pathFor(color)[0];
}

export function pathPos(color, point) {
  return pathFor(color).indexOf(Number(point));
}

export function stackAt(state, point) {
  return state.points?.[point] || state.points?.[String(point)] || null;
}

export function colorAt(state, point) {
  return stackAt(state, point)?.color || null;
}

export function countAt(state, point, color = null) {
  const stack = stackAt(state, point);
  if (!stack) return 0;
  if (color && stack.color !== color) return 0;
  return Number(stack.count) || 0;
}

export function offCount(state, color) {
  return Number(state.off?.[color]) || 0;
}

export function checkersInTrackRange(state, color, start, end) {
  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color) return total;
    const pos = pathPos(color, Number(point));
    return total + (pos >= start && pos <= end ? stack.count : 0);
  }, 0);
}

export function startZoneCount(state, color) {
  return checkersInTrackRange(state, color, 0, 5);
}

export function startZoneExitMoveCount(sequence = [], color) {
  return sequence.reduce((total, move) => {
    const fromPos = pathPos(color, move.from);
    const toPos = move.bearOff || move.to === 0 ? 24 : pathPos(color, move.to);
    return total + (fromPos >= 0 && fromPos <= 5 && toPos > 5 ? 1 : 0);
  }, 0);
}

export function koksRescuePressure(state, color) {
  if (offCount(state, color) > 0 || startZoneCount(state, color) === 0) return 0;
  const opponent = opponentOf(color);
  const opponentOff = offCount(state, opponent);
  if (opponentOff <= 0 && !homeReady(state, opponent)) return 0;
  const finishProximity = Math.max(0, 84 - pipsFor(state, opponent)) / 21;
  return Math.min(
    18,
    1 + opponentOff * 0.85 + (homeReady(state, opponent) ? 2.4 : 0) + finishProximity,
  );
}

export function occupiedInTrackRange(state, color, start, end) {
  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color) return total;
    const pos = pathPos(color, Number(point));
    return total + (pos >= start && pos <= end ? 1 : 0);
  }, 0);
}

export function madePointsInTrackRange(state, color, start, end) {
  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color || stack.count < 2) return total;
    const pos = pathPos(color, Number(point));
    return total + (pos >= start && pos <= end ? 1 : 0);
  }, 0);
}

export function outsideHomeCount(state, color) {
  return checkersInTrackRange(state, color, 0, 17);
}

export function outsideHomePips(state, color) {
  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color) return total;
    const pos = pathPos(color, Number(point));
    return total + (pos >= 0 && pos < 18 ? stack.count * (18 - pos) : 0);
  }, 0);
}

export function laggardRouteDebt(state, color) {
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

export function entryZoneOutsideCount(state, color) {
  return checkersInTrackRange(state, color, 12, 17);
}

export function homeBoardCount(state, color) {
  return checkersInTrackRange(state, color, 18, 23);
}

export function homeTotalCount(state, color) {
  return homeBoardCount(state, color) + offCount(state, color);
}

export function homeReady(state, color) {
  return outsideHomeCount(state, color) === 0;
}

export function headCheckers(state, color) {
  return countAt(state, headPoint(color), color);
}

export function pipsFor(state, color) {
  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color) return total;
    const pos = pathPos(color, Number(point));
    if (pos < 0) return total;
    return total + stack.count * Math.max(0, 24 - pos);
  }, 0);
}

export function distributionPenalty(state, color) {
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

export function opponentFenceRun(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(color);
  let longest = 0;

  for (let start = 0; start < path.length; start += 1) {
    if (colorAt(state, path[start]) !== opponent) continue;
    const ownBehind = path.slice(0, start).some(point => colorAt(state, point) === color);
    if (!ownBehind) continue;
    let run = 0;
    while (start + run < path.length && colorAt(state, path[start + run]) === opponent) {
      run += 1;
    }
    longest = Math.max(longest, run);
  }

  return longest;
}

export function routeTowerRisk(state, color) {
  if (outsideHomeCount(state, color) <= 0) return 0;
  const fenceRun = opponentFenceRun(state, color);
  const fenceScale = 1
    + Math.pow(Math.max(0, fenceRun - 2), 2) * 0.72
    + Math.min(4, opponentTrapRisk(state, color) / 480);
  const head = headPoint(color);

  return Object.entries(state.points || {}).reduce((total, [point, stack]) => {
    if (stack.color !== color || Number(point) === Number(head)) return total;
    const count = Number(stack.count) || 0;
    const excess = Math.max(0, count - 3);
    if (!excess) return total;
    const severe = Math.max(0, count - 5);
    const pos = pathPos(color, Number(point));
    const routeWeight = pos >= 18 ? 1.45 : 1 + Math.max(0, 10 - pos) * 0.04;
    return total + (excess * excess * 6 + severe * severe * 34) * routeWeight * fenceScale;
  }, 0);
}

export function headLandingSupportScore(state, color) {
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

export function headLandingExposureRisk(state, color) {
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

export function headLandingBreakRisk(before, after, color) {
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

export function opponentHeadBlockScore(state, color) {
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

export function opponentHeadFreedomRisk(state, color) {
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

export function opponentHeadFreedomMoveDelta(state, color, sequence = []) {
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

export function footholdScore(state, color) {
  const defensive = madePointsInTrackRange(state, color, 1, 7) * 2.8
    + occupiedInTrackRange(state, color, 1, 7) * 0.75;
  const route = madePointsInTrackRange(state, color, 8, 17) * 1.6
    + occupiedInTrackRange(state, color, 8, 17) * 0.42;
  const attack = madePointsInTrackRange(state, color, 12, 18) * 2.3
    + occupiedInTrackRange(state, color, 12, 18) * 0.5;
  return defensive + route + attack;
}

export function prematureHomeRushPenalty(state, color) {
  if (homeReady(state, color) || offCount(state, color) > 0) return 0;
  const headDebt = Math.max(0, headCheckers(state, color) - 4);
  const outside = outsideHomeCount(state, color);
  const home = homeBoardCount(state, color);
  if (home <= 3 || outside <= 5) return 0;

  const support = Math.max(0, footholdScore(state, color)) + Math.max(0, headLandingSupportScore(state, color));
  const supportDebt = Math.max(0, 18 - support);
  return home * (headDebt * 1.8 + supportDebt * 0.42 + Math.max(0, outside - 8) * 0.35);
}

export function lateEntryPressure(state, color) {
  const outside = outsideHomeCount(state, color);
  if (!outside) return 0;
  const opponent = opponentOf(color);
  const entry = entryZoneOutsideCount(state, color);
  const lateRace = Math.max(0, 7 - outside) * 0.72;
  const opponentRace = offCount(state, opponent) * 0.32 + (homeReady(state, opponent) ? 1.8 : 0);
  const entryRatio = entry / Math.max(1, outside);
  return 1 + entryRatio * 2.4 + lateRace + opponentRace;
}

export function routeCompletionPressure(state, color) {
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

export function opponentTrapRisk(state, color) {
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

export function fenceClosureRisk(state, color) {
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

export function opponentHeadFenceBarrierScore(state, color) {
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

export function escapeGatewayRisk(state, color) {
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

export function homeEntryMoveCount(sequence = [], color) {
  return sequence.reduce((total, move) => {
    const fromPos = pathPos(color, move.from);
    const toPos = move.bearOff || move.to === 0 ? 24 : pathPos(color, move.to);
    return total + (fromPos >= 12 && fromPos < 18 && toPos >= 18 ? 1 : 0);
  }, 0);
}

export function homeShuffleMoveCount(sequence = [], color) {
  return sequence.reduce((total, move) => {
    const fromPos = pathPos(color, move.from);
    const toPos = move.bearOff || move.to === 0 ? 24 : pathPos(color, move.to);
    return total + (fromPos >= 18 && toPos >= 18 && !(move.bearOff || move.to === 0) ? 1 : 0);
  }, 0);
}

export function outsideDevelopmentMoveCount(sequence = [], color) {
  return sequence.reduce((total, move) => {
    const fromPos = pathPos(color, move.from);
    const toPos = move.bearOff || move.to === 0 ? 24 : pathPos(color, move.to);
    return total + (fromPos >= 0 && fromPos < 18 && toPos > fromPos && toPos < 18 ? 1 : 0);
  }, 0);
}

export function entryContinuationMoveCount(sequence = [], color) {
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

export function developmentPressure(state, color) {
  if (homeReady(state, color)) return 0;
  return 1
    + Math.min(2.4, headCheckers(state, color) / 4.5)
    + Math.min(1.8, outsideHomeCount(state, color) / 8);
}

export function blockadeScore(state, color) {
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

export function blockingPrimeScore(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(opponent);
  let score = 0;
  let runStart = -1;
  let runLength = 0;

  const trappedBefore = (index) => path.slice(0, index).reduce((total, point) => {
    const stack = stackAt(state, point);
    return total + (stack?.color === opponent ? Number(stack.count) || 0 : 0);
  }, 0);
  const scoreRun = () => {
    if (runLength < 2 || runStart < 0) return;
    const trapped = trappedBefore(runStart);
    if (!trapped) return;
    const runPoints = path.slice(runStart, runStart + runLength);
    const reserves = runPoints.reduce((total, point) => {
      const count = countAt(state, point, color);
      return total + Math.min(3, Math.max(0, count - 1));
    }, 0);
    const zone = runStart < 7 ? 1.5 : runStart < 13 ? 1.2 : 0.82;
    const closure = runLength >= 6
      ? 520 + (runLength - 6) * 180
      : Math.pow(runLength, 3) * (1 + reserves / Math.max(4, runLength * 2));
    score += trapped * closure * zone;
  };

  path.forEach((point, index) => {
    if (colorAt(state, point) === color) {
      if (!runLength) runStart = index;
      runLength += 1;
      return;
    }
    scoreRun();
    runStart = -1;
    runLength = 0;
  });
  scoreRun();

  for (let start = 1; start <= path.length - 6; start += 1) {
    const trapped = trappedBefore(start);
    if (!trapped) continue;
    const window = path.slice(start, start + 6);
    const ownPoints = window.filter(point => colorAt(state, point) === color).length;
    const opponentPoints = window.filter(point => colorAt(state, point) === opponent).length;
    if (ownPoints < 3 || ownPoints >= 6 || opponentPoints > 0) continue;
    const madePoints = window.filter(point => countAt(state, point, color) >= 2).length;
    const longest = longestColorRun(state, window, color);
    const zone = start < 7 ? 1.35 : start < 13 ? 1.08 : 0.72;
    const completion = Math.pow(ownPoints - 2, 2)
      * (1 + longest * 0.3)
      * (1 + madePoints * 0.1);
    score += trapped * completion * zone;
  }

  return score;
}

export function opponentMoveBlockScore(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(opponent);
  let score = 0;

  Object.entries(state.points || {}).forEach(([point, stack]) => {
    if (stack.color !== opponent) return;
    const pos = pathPos(opponent, Number(point));
    if (pos < 0 || pos >= 18) return;
    const checkerWeight = Math.min(5, Number(stack.count) || 0);
    const routePressure = 1 + Math.max(0, 11 - pos) * 0.06;
    let open = 0;
    let blockedWeight = 0;
    for (let die = 1; die <= 6; die += 1) {
      const target = path[pos + die];
      if (!target) continue;
      if (colorAt(state, target) === color) blockedWeight += 7 - die;
      else open += 1;
    }
    score += checkerWeight * blockedWeight * routePressure;
    if (open === 0) score += checkerWeight * 96 * routePressure;
    else if (open === 1) score += checkerWeight * 34 * routePressure;
    else if (open === 2) score += checkerWeight * 11 * routePressure;
  });

  return score;
}

export function blockingPrimeRun(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(opponent);
  let longest = 0;
  let run = 0;
  let runStart = 0;

  path.forEach((point, index) => {
    if (colorAt(state, point) === color) {
      if (!run) runStart = index;
      run += 1;
      const trapped = path.slice(0, runStart).some(
        target => colorAt(state, target) === opponent,
      );
      if (trapped) longest = Math.max(longest, run);
      return;
    }
    run = 0;
  });
  return longest;
}

function longestColorRun(state, points, color) {
  let longest = 0;
  let run = 0;
  points.forEach((point) => {
    if (colorAt(state, point) === color) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  });
  return longest;
}

export function stuckRisk(state, color) {
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

export function tempoValue(before, after, color) {
  const pipGain = pipsFor(before, color) - pipsFor(after, color);
  const offGain = offCount(after, color) - offCount(before, color);
  const homeGain = homeBoardCount(after, color) - homeBoardCount(before, color);
  const headGain = headCheckers(before, color) - headCheckers(after, color);
  return pipGain + offGain * 18 + Math.max(0, homeGain) * 2 + Math.max(0, headGain) * 5;
}

export function phasePressure(state, color) {
  const opponent = opponentOf(color);
  return 1
    + offCount(state, opponent) * 0.45
    + (homeReady(state, opponent) ? 1.6 : 0)
    + Math.max(0, 6 - outsideHomeCount(state, color)) * 0.22;
}
