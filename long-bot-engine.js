/* generated from bot-engine/long/*.ts */
(function () {
  'use strict';
  const NARDU_LONG_BOT_POLICY_IMPLEMENTATION_ID = 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1';

/* bot-engine/long/metrics.ts */

const LONG_PATHS = {
  white: [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  dark: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13],
};

const HEAD_LANDING_DICE = [1, 2, 3, 4, 5, 6];

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

function startZoneCount(state, color) {
  return checkersInTrackRange(state, color, 0, 5);
}

function startZoneExitMoveCount(sequence = [], color) {
  return sequence.reduce((total, move) => {
    const fromPos = pathPos(color, move.from);
    const toPos = move.bearOff || move.to === 0 ? 24 : pathPos(color, move.to);
    return total + (fromPos >= 0 && fromPos <= 5 && toPos > 5 ? 1 : 0);
  }, 0);
}

function koksRescuePressure(state, color) {
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
  const head = headPoint(color);
  const outside = Object.entries(state.points || {})
    .filter(([, stack]) => stack.color === color)
    .map(([point, stack]) => ({
      pos: pathPos(color, Number(point)),
      count: Number(point) === Number(head)
        ? Math.min(1, Number(stack.count) || 0)
        : Number(stack.count) || 0,
    }))
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

function opponentFenceRun(state, color) {
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

function immediateHeadFenceRun(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(color);
  let run = 0;

  for (let index = 1; index <= 6; index += 1) {
    if (colorAt(state, path[index]) !== opponent) break;
    run += 1;
  }
  return run;
}

function latentFenceExposure(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(color);
  const rear = Object.entries(state.points || {})
    .filter(([, stack]) => stack.color === color)
    .map(([point, stack]) => ({
      point: Number(point),
      pos: pathPos(color, Number(point)),
      count: Number(stack.count) || 0,
    }))
    .filter(checker => checker.pos >= 0 && checker.pos < 18)
    .sort((left, right) => left.pos - right.pos)[0];
  if (!rear) return 0;

  const window = path.slice(rear.pos + 1, Math.min(18, rear.pos + 7));
  const occupied = window.reduce((items, point, index) => {
    const stack = stackAt(state, point);
    if (stack?.color !== opponent) return items;
    items.push({ offset: index + 1, count: Number(stack.count) || 0 });
    return items;
  }, []);
  if (occupied.length < 2) return 0;

  const coverage = (occupied.length - 1) * 18
    + occupied.reduce((total, item) => (
      total + Math.min(2, item.count) * (7 - item.offset) * 0.7
    ), 0);
  const startZonePressure = rear.pos <= 5
    ? 1.55 + (5 - rear.pos) * 0.08
    : 1;
  const stackPressure = 1 + Math.min(4, Math.max(0, rear.count - 1)) * 0.35;
  return coverage * startZonePressure * stackPressure;
}

// Measures the step before latentFenceExposure: an own point has just been
// vacated (or is otherwise open), and the opponent can use the next roll to
// extend an adjacent anchor into a fence in front of our remaining checkers.
// The calculation is deliberately local and bounded to the 21 dice outcomes.
function prospectiveFenceExtensionRisk(state, color) {
  let risk = 0;

  for (let targetPos = 1; targetPos < 18; targetPos += 1) {
    risk += prospectiveFenceExtensionAt(state, color, targetPos);
  }

  return risk;
}

function prospectiveFenceExtensionRiskAt(state, color, point) {
  return prospectiveFenceExtensionAt(state, color, pathPos(color, Number(point)));
}

function prospectiveFenceInterruptionBreak(before, after, color) {
  const path = pathFor(color);
  return path.slice(1, 18).reduce((risk, point, offset) => {
    const beforeStack = stackAt(before, point);
    if (beforeStack?.color !== color || colorAt(after, point)) return risk;
    return risk + prospectiveFenceExtensionAt(after, color, offset + 1);
  }, 0);
}

function prospectiveFenceExtensionAt(state, color, targetPos) {
  const opponent = opponentOf(color);
  const path = pathFor(color);
  const target = path[targetPos];
  if (!target || colorAt(state, target)) return 0;

  const behind = path.slice(0, targetPos).reduce((items, point, pos) => {
    const stack = stackAt(state, point);
    if (stack?.color !== color) return items;
    items.push({ pos, count: Number(stack.count) || 0 });
    return items;
  }, []);
  const behindCount = behind.reduce((total, checker) => total + checker.count, 0);
  if (behindCount < 2) return 0;

  const closestBehind = Math.max(...behind.map(checker => checker.pos));
  const routeDistance = targetPos - closestBehind;
  if (routeDistance < 1 || routeDistance > 6) return 0;

  const leftRun = contiguousOpponentRun(state, path, targetPos - 1, -1, opponent);
  const rightRun = contiguousOpponentRun(state, path, targetPos + 1, 1, opponent);
  const anchorRun = leftRun.length + rightRun.length;
  if (!anchorRun) return 0;

  const reachableWeight = nextRollLandingWeight(state, opponent, target);
  if (!reachableWeight) return 0;

  const anchorCheckers = [...leftRun, ...rightRun].reduce(
    (total, point) => total + countAt(state, point, opponent),
    0,
  );
  const reachProbability = reachableWeight / 36;
  const distancePressure = 1 + (7 - routeDistance) * 0.2;
  const routePressure = targetPos < 6 ? 1.65 : targetPos < 12 ? 1.3 : 1;
  const anchorPressure = 1 + anchorRun * 0.65;
  const anchorStability = 1 + Math.min(3, Math.max(0, anchorCheckers - anchorRun)) * 0.12;
  return behindCount
    * reachProbability
    * distancePressure
    * routePressure
    * anchorPressure
    * anchorStability
    * 4;
}

function contiguousOpponentRun(state, path, start, step, opponent) {
  const points = [];
  for (let pos = start; pos >= 0 && pos < path.length; pos += step) {
    const point = path[pos];
    if (colorAt(state, point) !== opponent) break;
    points.push(point);
  }
  return points;
}

function nextRollLandingWeight(state, color, target) {
  const path = pathFor(color);
  const targetPos = pathPos(color, target);
  if (targetPos < 0) return 0;
  const sources = Object.entries(state.points || {})
    .filter(([, stack]) => stack.color === color && Number(stack.count) > 0)
    .map(([point]) => pathPos(color, Number(point)))
    .filter(pos => pos >= 0 && pos < targetPos);
  if (!sources.length) return 0;

  let weight = 0;
  for (let high = 1; high <= 6; high += 1) {
    for (let low = 1; low <= high; low += 1) {
      const dice = high === low ? [high, high, high, high] : [high, low];
      const reachable = sources.some(source => canLandWithRoll(
        state,
        color,
        path,
        source,
        targetPos,
        dice,
      ));
      if (reachable) weight += high === low ? 1 : 2;
    }
  }
  return weight;
}

function canLandWithRoll(state, color, path, sourcePos, targetPos, dice) {
  const opponent = opponentOf(color);
  const visit = (pos, remaining) => {
    if (pos === targetPos) return true;
    if (pos > targetPos || !remaining.length) return false;
    for (let index = 0; index < remaining.length; index += 1) {
      if (index > 0 && remaining[index] === remaining[index - 1]) continue;
      const nextPos = pos + remaining[index];
      if (nextPos > targetPos || colorAt(state, path[nextPos]) === opponent) continue;
      const nextDice = remaining.slice();
      nextDice.splice(index, 1);
      if (visit(nextPos, nextDice)) return true;
    }
    return false;
  };
  return visit(sourcePos, [...dice].sort((left, right) => left - right));
}

function routeTowerRisk(state, color) {
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
  const pressure = 1 + Math.max(0, opponentHeadCount - 4) / 5;

  return HEAD_LANDING_DICE.reduce((score, die) => {
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
    for (let index = die - 1; index >= 0 && colorAt(state, path[index]) === color; index -= 1) {
      run += 1;
    }
    for (
      let index = die + 1;
      index < path.length && colorAt(state, path[index]) === color;
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

function blockingPrimeScore(state, color) {
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
      ? 520
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

function opponentMoveBlockScore(state, color) {
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

function blockingPrimeRun(state, color) {
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

function strongestBlockingPrime(state, color) {
  const opponent = opponentOf(color);
  const path = pathFor(opponent);
  let best = null;
  let runStart = -1;
  let runLength = 0;

  const consider = () => {
    if (runStart < 0 || runLength < 4) return;
    const trapped = path.slice(0, runStart).reduce((total, point) => (
      total + countAt(state, point, opponent)
    ), 0);
    if (!trapped) return;
    const candidate = {
      start: runStart,
      length: runLength,
      trapped,
      points: path.slice(runStart, runStart + runLength),
    };
    const value = Math.min(6, runLength) ** 2 * Math.min(5, trapped);
    const bestValue = best
      ? Math.min(6, best.length) ** 2 * Math.min(5, best.trapped)
      : -1;
    if (value > bestValue) best = candidate;
  };

  path.forEach((point, index) => {
    if (colorAt(state, point) === color) {
      if (!runLength) runStart = index;
      runLength += 1;
      return;
    }
    consider();
    runStart = -1;
    runLength = 0;
  });
  consider();
  return best;
}

function blockingPrimeTiming(state, color) {
  const prime = strongestBlockingPrime(state, color);
  if (!prime) return null;
  const opponent = opponentOf(color);
  const opponentPath = pathFor(opponent);
  const anchors = new Set(prime.points.map(Number));
  let ownTiming = 0;
  let ownMovers = 0;
  let reserves = 0;
  let opponentTiming = 0;

  Object.entries(state.points || {}).forEach(([rawPoint, stack]) => {
    const point = Number(rawPoint);
    const count = Math.max(0, Number(stack?.count) || 0);
    if (!count) return;
    if (stack.color === color) {
      const anchor = anchors.has(point) ? 1 : 0;
      const movable = Math.max(0, count - anchor);
      const position = pathPos(color, point);
      if (anchor) reserves += movable;
      if (position >= 0) {
        ownMovers += movable;
        // Only pips that can be consumed while every blocking point remains
        // occupied count as timing.  Capping distant checkers prevents a head
        // tower from looking like unlimited safe waiting time.
        ownTiming += movable * Math.min(18, Math.max(0, 24 - position));
      }
      return;
    }
    if (stack.color !== opponent) return;
    const position = pathPos(opponent, point);
    if (position < 0) return;
    const waitingDistance = position < prime.start
      ? Math.max(0, prime.start - position - 1)
      : Math.max(0, 24 - position);
    opponentTiming += count * Math.min(18, waitingDistance);
  });

  return {
    ...prime,
    ownTiming,
    ownMovers,
    opponentTiming,
    reserves,
    margin: ownTiming - opponentTiming,
  };
}

// A prime is useful only while the blocking side has enough harmless moves to
// wait out the trapped side.  This 0..1 score deliberately separates the
// strength of a blockade from its durability, which the old attack heuristic
// treated as the same thing.
function primeSustainability(state, color) {
  const timing = blockingPrimeTiming(state, color);
  if (!timing) return 1;
  const scale = 42 + Math.min(6, timing.length) * 7 + Math.min(5, timing.trapped) * 4;
  const timingScore = Math.max(0, Math.min(1, 0.5 + timing.margin / scale));
  const reserveScore = Math.max(0, Math.min(
    1,
    (timing.reserves * 1.6 + timing.ownTiming / 24)
      / Math.max(4, Math.min(6, timing.length) * 1.5),
  ));
  return Math.max(0, Math.min(1, timingScore * 0.68 + reserveScore * 0.32));
}

// Risk grows when a powerful prime has no spare checkers and the opponent has
// more waiting time.  It is intentionally zero when there is no active
// four-point blockade, so normal racing positions are unaffected.
function primeCrunchRisk(state, color) {
  const timing = blockingPrimeTiming(state, color);
  if (!timing) return 0;
  const runStrength = Math.max(0.25, Math.min(1, (Math.min(6, timing.length) - 3) / 3));
  const trappedPressure = Math.min(2.2, 0.65 + Math.sqrt(timing.trapped) * 0.42);
  const timingDeficit = Math.max(0, -timing.margin) / 30;
  const reserveDeficit = timing.margin < 0
    ? Math.max(0, 2 - timing.reserves) * 0.3
    : 0;
  return runStrength * trappedPressure * (timingDeficit + reserveDeficit);
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
  koksRescue: 3000000,
};

function mergeWeights(weights = {}) {
  return { ...DEFAULT_LONG_BOT_WEIGHTS, ...(weights || {}) };
}

function evaluateState(state, color, weights = DEFAULT_LONG_BOT_WEIGHTS) {
  const opponent = opponentOf(color);
  if (state?.winner) {
    const resultMultiplier = state.resultType === 'koks'
      ? 3
      : state.resultType === 'mars'
        ? 2
        : 1;
    return (state.winner === color ? 1 : -1) * resultMultiplier * 1000000000000;
  }
  const ownPips = pipsFor(state, color);
  const opponentPips = pipsFor(state, opponent);
  const ownOff = offCount(state, color);
  const opponentOff = offCount(state, opponent);
  const pressure = phasePressure(state, color);
  const entryPressure = lateEntryPressure(state, color);
  const ownTrapRisk = opponentTrapRisk(state, color);
  const ownFenceClosureRisk = fenceClosureRisk(state, color);
  const opponentTrapReward = cappedTrapReward(opponentTrapRisk(state, opponent));
  const ownKoksPressure = koksRescuePressure(state, color);
  const ownPrimeCrunchRisk = primeCrunchRisk(state, color);
  const opponentPrimeCrunchRisk = primeCrunchRisk(state, opponent);

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
    - routeTowerRisk(state, color) * weights.distribution * 12
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
    + escapeGatewayRisk(state, opponent) * weights.escapeGatewayRisk * 0.12
    - ownPrimeCrunchRisk * weights.trapRisk * 64
    + opponentPrimeCrunchRisk * weights.trapRisk * 10
    - startZoneCount(state, color) * weights.koksRescue * ownKoksPressure;
}

function sequenceStats(before, after, color, sequence = []) {
  const offGain = offCount(after, color) - offCount(before, color);
  const homeGain = homeBoardCount(after, color) - homeBoardCount(before, color);
  const pipGain = pipsFor(before, color) - pipsFor(after, color);
  const riskDelta = stuckRisk(before, color) - stuckRisk(after, color);
  const distributionDelta = distributionPenalty(before, color) - distributionPenalty(after, color);
  const routeTowerDelta = routeTowerRisk(before, color) - routeTowerRisk(after, color);
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
  const prospectiveFenceBreak = prospectiveFenceInterruptionBreak(before, after, color);
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
  const startZoneBefore = startZoneCount(before, color);
  const startZoneAfter = startZoneCount(after, color);
  const startZoneReduction = Math.max(0, startZoneBefore - startZoneAfter);
  const resultSafetyBefore = offCount(before, color) > 0 ? 2 : startZoneBefore === 0 ? 1 : 0;
  const resultSafetyAfter = offCount(after, color) > 0 ? 2 : startZoneAfter === 0 ? 1 : 0;
  const maxRouteTowerAfter = Object.entries(after.points || {}).reduce((maximum, [point, stack]) => (
    stack.color === color && Number(point) !== Number(headPoint(color))
      ? Math.max(maximum, Number(stack.count) || 0)
      : maximum
  ), 0);
  const primeSustainabilityBefore = primeSustainability(before, color);
  const primeSustainabilityAfter = primeSustainability(after, color);
  const primeCrunchRiskBefore = primeCrunchRisk(before, color);
  const primeCrunchRiskAfter = primeCrunchRisk(after, color);
  const routeSignature = sequence
    .map(move => {
      const from = Math.max(0, pathPos(color, Number(move.from)));
      const to = move.bearOff || move.to === 0
        ? 24
        : Math.max(0, pathPos(color, Number(move.to)));
      return `${Math.floor(from / 3)}>${Math.floor(to / 3)}`;
    })
    .sort()
    .join('+');

  return {
    offGain,
    homeGain,
    pipGain,
    riskDelta,
    distributionDelta,
    routeTowerDelta,
    routeTowerAfter: routeTowerRisk(after, color),
    opponentFenceRunBefore: opponentFenceRun(before, color),
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
    prospectiveFenceInterruptionBreak: prospectiveFenceBreak,
    opponentTrapGain,
    headLandingBreak,
    outsideDevelopmentMoves,
    entryContinuationMoves,
    opponentHeadFreedomDelta,
    opponentHeadBarrierDelta,
    escapeGatewayDelta,
    bearOffMoves,
    homeShuffleMoves,
    routeSignature,
    maxRouteTowerAfter,
    primeSustainabilityBefore,
    primeSustainabilityAfter,
    primeSustainabilityDelta: primeSustainabilityAfter - primeSustainabilityBefore,
    primeCrunchRiskBefore,
    primeCrunchRiskAfter,
    primeCrunchRiskDelta: primeCrunchRiskBefore - primeCrunchRiskAfter,
    startZoneBefore,
    startZoneAfter,
    startZoneReduction,
    resultSafetyBefore,
    resultSafetyAfter,
    resultSafetyGain: Math.max(0, resultSafetyAfter - resultSafetyBefore),
  };
}

function scoreSequence(before, after, color, sequence = [], weights = DEFAULT_LONG_BOT_WEIGHTS) {
  const stats = sequenceStats(before, after, color, sequence);
  const pressure = phasePressure(before, color);
  const entryPressure = lateEntryPressure(before, color);
  const completionPressure = routeCompletionPressure(before, color);
  const development = developmentPressure(before, color);
  const outside = outsideHomeCount(before, color);
  const headRemaining = headCheckers(before, color);
  const rescuePressure = koksRescuePressure(before, color);
  const matureEntryPhase = headRemaining === 0 && outside <= 9;
  const earlyEntryScale = headRemaining >= 5 && outside >= 9
    ? 0.18
    : outside >= 7 && !matureEntryPhase
      ? 0.48
      : 1;
  let score = evaluateState(after, color, weights) - evaluateState(before, color, weights);

  score += tempoValue(before, after, color) * weights.tempo * pressure;
  score += stats.blockadeGain * weights.blockade * 0.9;
  score += stats.riskDelta * weights.stuckRisk * 1.35;
  score += stats.distributionDelta * weights.distribution * 0.7;
  score += stats.offGain * weights.borneOff * 2.3;
  score += Math.max(0, stats.headGain) * weights.headRelease * (homeReady(before, color) ? 0.12 : 1.15);
  score += stats.footholdGain * weights.foothold * 1.2;
  score += stats.homeEntryMoves * weights.homeEntry * 4.2 * entryPressure * earlyEntryScale;
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
  if (rescuePressure > 0) {
    score += stats.startZoneReduction * weights.koksRescue * rescuePressure * 1.25;
    score += stats.resultSafetyGain * weights.koksRescue * rescuePressure * 3;
    if (stats.startZoneReduction <= 0) {
      score -= stats.startZoneAfter * weights.koksRescue * rescuePressure * 0.35;
    }
  }
  if (stats.homeEntryMoves > 0 && headRemaining >= 5 && outside >= 8 && stats.headGain <= 0) {
    score -= stats.homeEntryMoves * (9000000 + headRemaining * 900000);
  }
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


const MAX_REPLY_SEQUENCES = 8;
const MAX_DOUBLE_REPLY_SEQUENCES = 4;
const MAX_TACTICAL_CANDIDATES = 4;
const MAX_DEEP_CANDIDATES = 2;
const MAX_RECOVERY_SEQUENCES = 2;
const MAX_CONTINUATION_CANDIDATES = 2;
const MAX_CONTINUATION_SEQUENCES = 2;
const MAX_EXPERIENCE_PENALTY = 140000000;
const MAX_EXPERIENCE_REWARD = 30000000;
const EXPERIENCE_RISK_THRESHOLD = 1.1;
const CANONICAL_DICE_WEIGHT = 36;
const DICE_TAIL_WEIGHT = 6;

function createAnalysisBudget(limit) {
  const normalizedLimit = Math.max(1, Math.floor(Number(limit) || 1));
  let used = 0;
  return {
    limit: normalizedLimit,
    consume(units = 1) {
      const normalizedUnits = Math.max(1, Math.floor(Number(units) || 1));
      if (used + normalizedUnits > normalizedLimit) return false;
      used += normalizedUnits;
      return true;
    },
    get used() {
      return used;
    },
    get remaining() {
      return Math.max(0, normalizedLimit - used);
    },
  };
}

function hasAnalysisBudget(budget, units = 1) {
  return !budget || Number(budget.remaining) >= Math.max(1, Number(units) || 1);
}

function consumeAnalysisNode(budget, units = 1) {
  return !budget || budget.consume(units);
}

// Unordered pairs preserve all 36 ordered throws: non-doubles have two orders.
const CANONICAL_DICE_OUTCOMES = Object.freeze(
  Array.from({ length: 6 }, (_, highOffset) => 6 - highOffset)
    .flatMap(high => Array.from({ length: high }, (_, lowOffset) => high - lowOffset)
      .map(low => Object.freeze({
        dice: Object.freeze([high, low]),
        weight: high === low ? 1 : 2,
      }))),
);

function hasCompleteDiceDistribution(rolls, weight) {
  return rolls === CANONICAL_DICE_OUTCOMES.length
    && weight === CANONICAL_DICE_WEIGHT;
}

function weightedLowerTailMean(outcomes, targetWeight = DICE_TAIL_WEIGHT) {
  const ordered = (Array.isArray(outcomes) ? outcomes : [])
    .filter(item => Number.isFinite(Number(item?.value)) && Number(item?.weight) > 0)
    .sort((left, right) => Number(left.value) - Number(right.value));
  let remaining = Math.max(1, Number(targetWeight) || 1);
  let used = 0;
  let total = 0;
  for (const item of ordered) {
    if (remaining <= 0) break;
    const weight = Math.min(remaining, Number(item.weight));
    total += Number(item.value) * weight;
    used += weight;
    remaining -= weight;
  }
  return used ? total / used : 0;
}

function analyzeOpponentReplies(
  adapter,
  color,
  candidates,
  weights,
  budget,
  options = {},
) {
  const expandDoubles = Boolean(options.expandDoubles);
  const beforeDeepCandidate = typeof options.beforeDeepCandidate === 'function'
    ? options.beforeDeepCandidate
    : null;
  const beforeDeepSelection = typeof options.beforeDeepSelection === 'function'
    ? options.beforeDeepSelection
    : null;
  const tacticalCandidates = uniquePositionCandidates(
    candidates,
    MAX_TACTICAL_CANDIDATES,
  );
  if (!tacticalCandidates.length || !hasAnalysisBudget(budget)) return candidates;

  const opponent = opponentOf(color);
  const accumulators = tacticalCandidates.map(candidate => ({
    candidate,
    expandedReplyCoverage: primeCrunchRisk(candidate.after, color) >= 0.45,
    expectedImpact: 0,
    weight: 0,
    worstImpact: 0,
    rolls: 0,
    blockedWeight: 0,
    replySequenceWeight: 0,
    opponentPipGain: 0,
    opponentHeadRelease: 0,
    opponentOutsideReduction: 0,
    frontiers: [],
  }));

  for (const roll of CANONICAL_DICE_OUTCOMES) {
    if (!hasAnalysisBudget(budget)) break;
    let completedRoll = true;
    const rollResults = [];

    for (const accumulator of accumulators) {
      if (!consumeAnalysisNode(budget)) {
        completedRoll = false;
        break;
      }
      const replyState = prepareReplyState(
        accumulator.candidate.after,
        opponent,
        roll.dice,
        expandDoubles,
      );
      const expandedDouble = expandDoubles
        && roll.dice.length === 2
        && roll.dice[0] === roll.dice[1];
      const legalReplies = adapter.legalSequences(replyState, opponent, {
        limit: accumulator.expandedReplyCoverage
          ? (expandedDouble ? 24 : 0)
          : (expandDoubles ? 18 : 0),
      });
      const replySequences = sampledSequenceResults(
        adapter,
        replyState,
        opponent,
        legalReplies,
        accumulator.expandedReplyCoverage
          ? (expandedDouble ? MAX_DOUBLE_REPLY_SEQUENCES : MAX_REPLY_SEQUENCES)
          : 2,
        { preferLeading: !accumulator.expandedReplyCoverage || expandedDouble },
      );
      const beforeValue = evaluateState(replyState, color, weights);
      let worstValue = beforeValue;
      let worstState = replyState;

      for (const { sequence: reply, after: replyAfter } of replySequences) {
        const opponentGain = scoreSequence(replyState, replyAfter, opponent, reply, weights);
        const ownValue = evaluateState(replyAfter, color, weights);
        const replyValue = ownValue - Math.max(0, opponentGain) * 0.08;
        if (replyValue < worstValue) {
          worstValue = replyValue;
          worstState = replyAfter;
        }
      }
      if (!completedRoll) break;
      rollResults.push({
        impact: worstValue - beforeValue,
        state: worstState,
        blocked: replySequences.length === 0,
        replySequences: legalReplies.length,
        opponentPipGain: Math.max(
          0,
          pipsFor(replyState, opponent) - pipsFor(worstState, opponent),
        ),
        opponentHeadRelease: Math.max(
          0,
          headCheckers(replyState, opponent) - headCheckers(worstState, opponent),
        ),
        opponentOutsideReduction: Math.max(
          0,
          outsideHomeCount(replyState, opponent) - outsideHomeCount(worstState, opponent),
        ),
      });
    }

    if (!completedRoll) break;
    rollResults.forEach((result, index) => {
      const accumulator = accumulators[index];
      const impact = result.impact;
      accumulator.expectedImpact += impact * roll.weight;
      accumulator.weight += roll.weight;
      accumulator.worstImpact = Math.min(accumulator.worstImpact, impact);
      accumulator.rolls += 1;
      if (result.blocked) accumulator.blockedWeight += roll.weight;
      accumulator.replySequenceWeight += result.replySequences * roll.weight;
      accumulator.opponentPipGain += result.opponentPipGain * roll.weight;
      accumulator.opponentHeadRelease += result.opponentHeadRelease * roll.weight;
      accumulator.opponentOutsideReduction += result.opponentOutsideReduction * roll.weight;
      accumulator.frontiers.push({
        impact,
        state: result.state,
        diceKey: roll.dice.join(':'),
        weight: roll.weight,
      });
      accumulator.frontiers.sort((left, right) => left.impact - right.impact);
      accumulator.frontiers = accumulator.frontiers.slice(0, 2);
    });
  }

  accumulators.forEach((accumulator) => {
    if (!hasCompleteDiceDistribution(accumulator.rolls, accumulator.weight)) return;
    const expectedImpact = accumulator.expectedImpact / accumulator.weight;
    const tacticalAdjustment = expectedImpact * 0.42
      + accumulator.worstImpact * 0.14 * threatPressure(accumulator.candidate.after, color);
    accumulator.candidate.score += tacticalAdjustment;
    accumulator.candidate.tactical = {
      expectedImpact,
      worstImpact: accumulator.worstImpact,
      rolls: accumulator.rolls,
      distributionWeight: accumulator.weight,
      distributionComplete: true,
      adjustment: tacticalAdjustment,
      plies: 2,
      blockedProbability: accumulator.blockedWeight / accumulator.weight,
      expectedReplySequences: accumulator.replySequenceWeight / accumulator.weight,
      expectedOpponentPipGain: accumulator.opponentPipGain / accumulator.weight,
      expectedOpponentHeadRelease: accumulator.opponentHeadRelease / accumulator.weight,
      expectedOpponentOutsideReduction: accumulator.opponentOutsideReduction / accumulator.weight,
      doublesExpanded: expandDoubles,
      replyCoverageExpanded: accumulator.expandedReplyCoverage,
    };
  });

  if (beforeDeepCandidate) {
    accumulators.forEach((accumulator) => {
      if (accumulator.candidate.tactical) beforeDeepCandidate(accumulator.candidate);
    });
  }

  let deepAccumulators = accumulators;
  if (beforeDeepSelection) {
    const byCandidate = new Map(accumulators.map(accumulator => [
      accumulator.candidate,
      accumulator,
    ]));
    const prioritizedCandidates = beforeDeepSelection(accumulators
      .filter(accumulator => accumulator.candidate.tactical)
      .map(accumulator => accumulator.candidate));
    if (Array.isArray(prioritizedCandidates)) {
      const prioritized = prioritizedCandidates
        .map(candidate => byCandidate.get(candidate))
        .filter(Boolean);
      const included = new Set(prioritized);
      deepAccumulators = [
        ...prioritized,
        ...accumulators.filter(accumulator => !included.has(accumulator)),
      ];
    }
  }

  analyzeRecoveryReplies(adapter, color, deepAccumulators, weights, budget, expandDoubles);
  completeProvisionalLeaderAnalysis(
    adapter,
    color,
    deepAccumulators,
    weights,
    budget,
    expandDoubles,
  );
  propagateEquivalentPositionAnalysis(candidates, accumulators);

  return candidates.sort((left, right) => right.score - left.score);
}

function propagateEquivalentPositionAnalysis(candidates, accumulators) {
  const analyzedByPosition = new Map();
  const reservationsByPosition = new Map();
  const reservationKeys = [
    'structuralIntegrityTacticalReservation',
    'homeEntryTacticalReservation',
    'routeContinuityTacticalReservation',
    'fenceEscapeTacticalReservation',
    'contestedHeadExitTacticalReservation',
    'primeSustainabilityTacticalReservation',
  ];
  candidates.forEach((candidate) => {
    const key = positionKey(candidate.after);
    const flags = reservationsByPosition.get(key) || {};
    reservationKeys.forEach((reservationKey) => {
      if (Number(candidate.features?.[reservationKey] || 0) > 0) flags[reservationKey] = 1;
    });
    reservationsByPosition.set(key, flags);
  });
  accumulators.forEach(({ candidate }) => {
    if (candidate.tactical) {
      analyzedByPosition.set(positionKey(candidate.after), candidate);
    }
  });

  candidates.forEach((candidate) => {
    Object.assign(candidate.features, reservationsByPosition.get(positionKey(candidate.after)) || {});
    if (candidate.tactical) return;
    const analyzed = analyzedByPosition.get(positionKey(candidate.after));
    if (!analyzed?.tactical) return;
    const adjustment = Number(analyzed.tactical.adjustment || 0)
      + Number(analyzed.tactical.deepAdjustment || 0)
      + Number(analyzed.tactical.continuationAdjustment || 0);
    candidate.score += adjustment;
    candidate.tactical = {
      ...analyzed.tactical,
      equivalentPosition: true,
    };
  });
}

function uniquePositionCandidates(candidates, limit) {
  const selected = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = positionKey(candidate.after);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}

function positionKey(state) {
  const points = Object.entries(state.points || {})
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([point, stack]) => `${point}:${stack.color}:${stack.count}`)
    .join('|');
  return `${points}|${Number(state.off?.white) || 0}:${Number(state.off?.dark) || 0}`;
}

function analyzeRecoveryReplies(adapter, color, accumulators, weights, budget, expandDoubles) {
  const rankedCandidates = accumulators
    .filter(accumulator => (
      accumulator.candidate.tactical
      && Number(accumulator.candidate.tactical.plies || 0) < 3
      && accumulator.frontiers.length
    ))
    .sort((left, right) => right.candidate.score - left.candidate.score);
  const deepCandidates = selectDeepCandidates(rankedCandidates);

  for (const accumulator of deepCandidates) {
    if (!hasAnalysisBudget(budget)) break;
    const frontier = accumulator.frontiers[0];
    let expectedRecovery = 0;
    let recoveryWeight = 0;
    let worstRecovery = Infinity;
    let recoveryRolls = 0;
    const recoveryFrontiers = [];

    for (const roll of CANONICAL_DICE_OUTCOMES) {
      if (!consumeAnalysisNode(budget)) break;
      const recoveryState = prepareReplyState(
        frontier.state,
        color,
        roll.dice,
        expandDoubles,
      );
      const legalRecoverySequences = adapter.legalSequences(recoveryState, color, {
        limit: expandDoubles ? 4 : 0,
      });
      const recoverySequences = sampledSequenceResults(
        adapter,
        recoveryState,
        color,
        legalRecoverySequences,
        MAX_RECOVERY_SEQUENCES,
      );
      let bestRecovery = recoverySequences.length ? -Infinity : 0;
      let bestRecoveryState = recoveryState;
      for (const { sequence, after: recoveryAfter } of recoverySequences) {
        const sequenceValue = scoreSequence(
          recoveryState,
          recoveryAfter,
          color,
          sequence,
          weights,
        );
        const residualFenceRisk = fenceClosureRisk(recoveryAfter, color)
          + opponentTrapRisk(recoveryAfter, color);
        const recoveryValue = sequenceValue - residualFenceRisk * weights.trapRisk * 0.16;
        if (recoveryValue > bestRecovery) {
          bestRecovery = recoveryValue;
          bestRecoveryState = recoveryAfter;
        }
      }
      if (!Number.isFinite(bestRecovery)) bestRecovery = 0;
      expectedRecovery += bestRecovery * roll.weight;
      recoveryWeight += roll.weight;
      worstRecovery = Math.min(worstRecovery, bestRecovery);
      recoveryRolls += 1;
      recoveryFrontiers.push({
        value: bestRecovery,
        state: bestRecoveryState,
        weight: roll.weight,
        diceKey: roll.dice.join(':'),
      });
    }

    if (!hasCompleteDiceDistribution(recoveryRolls, recoveryWeight)) continue;
    const recoveryExpected = expectedRecovery / recoveryWeight;
    const recoveryTailRisk = weightedLowerTailMean(recoveryFrontiers);
    const deepAdjustment = recoveryExpected * 0.18
      + Math.min(0, recoveryTailRisk) * 0.08;
    accumulator.candidate.score += deepAdjustment;
    Object.assign(accumulator.candidate.tactical, {
      recoveryExpected,
      recoveryWorst: Number.isFinite(worstRecovery) ? worstRecovery : 0,
      recoveryTailRisk,
      recoveryTailWeight: DICE_TAIL_WEIGHT,
      recoveryRolls,
      recoveryWeight,
      recoveryDistributionComplete: true,
      // Dice-complete recovery is conditional on ONE worst-immediate primary
      // scenario, not a complete nested primary x recovery dice tree. Different
      // candidates can select different scenarios; impacts are estimates, not
      // an independent cross-candidate safety proof.
      recoveryModelKind: 'conditional-single-primary-v1',
      recoveryConditional: true,
      recoveryPrimaryDiceKey: frontier.diceKey,
      recoveryPrimaryDiceWeight: frontier.weight,
      recoveryPrimaryFrontierCount: 1,
      recoveryTotalPrimaryFrontierCount: CANONICAL_DICE_OUTCOMES.length,
      recoveryPrimaryFrontierWeight: frontier.weight,
      recoveryTotalPrimaryFrontierWeight: CANONICAL_DICE_WEIGHT,
      deepAdjustment,
      plies: 3,
    });
    // Keep the real dice mass of every distinct recovery board. The bounded
    // continuation model samples only representative/worst boards; proxy
    // quadrature weights used for ranking must not be reported as coverage.
    accumulator.recoveryFrontierCoverage = new Map();
    recoveryFrontiers.forEach((frontier) => {
      const key = positionKey(frontier.state);
      const current = accumulator.recoveryFrontierCoverage.get(key);
      accumulator.recoveryFrontierCoverage.set(key, {
        weight: Number(current?.weight || 0) + Number(frontier.weight || 0),
      });
    });
    accumulator.recoveryFrontiers = recoveryFrontiers
      .sort((left, right) => left.value - right.value)
      .slice(0, 2);
    accumulator.continuationFrontier = recoveryFrontiers.reduce((closest, item) => (
      !closest
      || Math.abs(item.value - recoveryExpected) < Math.abs(closest.value - recoveryExpected)
        ? item
        : closest
    ), null);
  }

  analyzeContinuationReplies(
    adapter,
    color,
    deepCandidates,
    weights,
    budget,
    expandDoubles,
  );
}

function selectDeepCandidates(rankedCandidates) {
  const selected = [];
  const included = new Set();
  const append = (accumulator) => {
    if (!accumulator || included.has(accumulator)) return;
    included.add(accumulator);
    selected.push(accumulator);
  };
  [...rankedCandidates]
    .filter(accumulator => hasTacticalReservation(accumulator.candidate))
    .sort((left, right) => (
      tacticalReservationPriority(left.candidate)
        - tacticalReservationPriority(right.candidate)
      || Number(right.candidate.score) - Number(left.candidate.score)
    ))
    .forEach(append);
  const scoreLeaders = rankedCandidates.slice(0, MAX_DEEP_CANDIDATES);
  const safest = [...rankedCandidates].sort((left, right) => (
    Number(right.candidate.tactical?.worstImpact || 0)
      - Number(left.candidate.tactical?.worstImpact || 0)
  ))[0];
  const leaderWorst = Math.max(...scoreLeaders.map(accumulator => (
    Number(accumulator.candidate.tactical?.worstImpact || 0)
  )));
  if (
    safest
    && Number(safest.candidate.tactical?.worstImpact || 0) >= leaderWorst + 30000000
  ) {
    append(safest);
  }
  scoreLeaders.forEach(append);
  return selected.slice(0, MAX_TACTICAL_CANDIDATES);
}

function tacticalReservationPriority(candidate) {
  const features = candidate?.features || {};
  if (Number(features.structuralIntegrityTacticalReservation || 0) > 0) return 0;
  if (Number(features.homeEntryTacticalReservation || 0) > 0) return 1;
  if (Number(features.primeSustainabilityTacticalReservation || 0) > 0) return 1.5;
  if (Number(features.routeContinuityTacticalReservation || 0) > 0) return 2;
  if (Number(features.fenceEscapeTacticalReservation || 0) > 0) return 3;
  if (Number(features.contestedHeadExitTacticalReservation || 0) > 0) return 4;
  return 100;
}

function hasTacticalReservation(candidate) {
  const features = candidate?.features || {};
  return Number(features.structuralIntegrityTacticalReservation || 0) > 0
    || Number(features.homeEntryTacticalReservation || 0) > 0
    || Number(features.routeContinuityTacticalReservation || 0) > 0
    || Number(features.fenceEscapeTacticalReservation || 0) > 0
    || Number(features.contestedHeadExitTacticalReservation || 0) > 0
    || Number(features.primeSustainabilityTacticalReservation || 0) > 0;
}

function completeProvisionalLeaderAnalysis(
  adapter,
  color,
  accumulators,
  weights,
  budget,
  expandDoubles,
) {
  // Deep adjustments can demote the initial top-two and expose a candidate
  // with only primary analysis. Follow that provisional leader until the move
  // which can actually win the ranking has the same bounded four-ply model.
  for (let pass = 0; pass < accumulators.length; pass += 1) {
    const leader = accumulators
      .filter(accumulator => accumulator.candidate.tactical)
      .sort((left, right) => right.candidate.score - left.candidate.score)[0];
    if (!leader || Number(leader.candidate.tactical.plies || 0) >= 4) return;

    const usedBefore = Number(budget?.used) || 0;
    if (Number(leader.candidate.tactical.plies || 0) >= 3) {
      analyzeContinuationReplies(
        adapter,
        color,
        [leader],
        weights,
        budget,
        expandDoubles,
      );
    } else {
      analyzeRecoveryReplies(
        adapter,
        color,
        [leader],
        weights,
        budget,
        expandDoubles,
      );
    }
    if ((Number(budget?.used) || 0) === usedBefore) return;
  }
}

function analyzeContinuationReplies(
  adapter,
  color,
  deepCandidates,
  weights,
  budget,
  expandDoubles,
) {
  const opponent = opponentOf(color);
  const continuationCandidates = selectContinuationCandidates(deepCandidates);

  for (const accumulator of continuationCandidates) {
    if (!hasAnalysisBudget(budget)) break;
    const representativeFrontier = accumulator.continuationFrontier;
    const worstFrontier = accumulator.recoveryFrontiers?.[0];
    if (!representativeFrontier || !worstFrontier) continue;
    const worstRecoveryWeight = Math.max(
      1,
      Math.min(CANONICAL_DICE_WEIGHT, Number(worstFrontier.weight) || 1),
    );
    const continuationFrontiers = uniqueContinuationFrontiers([
      {
        ...representativeFrontier,
        kind: 'representative',
        proxyWeight: CANONICAL_DICE_WEIGHT - worstRecoveryWeight,
      },
      { ...worstFrontier, kind: 'worst', proxyWeight: worstRecoveryWeight },
    ]);
    const frontierWeight = continuationFrontiers.reduce((sum, frontier) => (
      sum + Number(accumulator.recoveryFrontierCoverage?.get(positionKey(frontier.state))?.weight || 0)
    ), 0);
    const totalFrontierCount = Number(accumulator.recoveryFrontierCoverage?.size) || 0;
    const approximate = frontierWeight !== CANONICAL_DICE_WEIGHT
      || continuationFrontiers.length !== totalFrontierCount;
    let expectedImpact = 0;
    let impactWeight = 0;
    let worstImpact = 0;
    let rolls = 0;
    const impactOutcomes = [];
    let coverageComplete = true;

    for (const roll of CANONICAL_DICE_OUTCOMES) {
      const frontierImpacts = [];
      for (const frontier of continuationFrontiers) {
        if (!consumeAnalysisNode(budget)) {
          coverageComplete = false;
          break;
        }
        const replyState = prepareReplyState(
          frontier.state,
          opponent,
          roll.dice,
          expandDoubles,
        );
        const beforeValue = evaluateState(replyState, color, weights);
        const legalReplies = adapter.legalSequences(replyState, opponent, {
          limit: expandDoubles ? 4 : 0,
        });
        const replies = sampledSequenceResults(
          adapter,
          replyState,
          opponent,
          legalReplies,
          MAX_CONTINUATION_SEQUENCES,
        );
        let worstValue = beforeValue;
        for (const { sequence: reply, after: replyAfter } of replies) {
          const opponentGain = scoreSequence(replyState, replyAfter, opponent, reply, weights);
          const ownValue = evaluateState(replyAfter, color, weights);
          worstValue = Math.min(worstValue, ownValue - Math.max(0, opponentGain) * 0.1);
        }
        const impact = worstValue - beforeValue;
        frontierImpacts.push(impact);
        worstImpact = Math.min(worstImpact, impact);
      }
      if (!coverageComplete || frontierImpacts.length !== continuationFrontiers.length) break;
      const frontierProxyWeight = continuationFrontiers.reduce((sum, frontier) => (
        sum + Number(frontier.proxyWeight || 0)
      ), 0);
      const impact = frontierImpacts.reduce((sum, value, index) => (
        sum + value * Number(continuationFrontiers[index].proxyWeight || 0)
      ), 0) / frontierProxyWeight;
      expectedImpact += impact * roll.weight;
      impactWeight += roll.weight;
      rolls += 1;
      impactOutcomes.push({ value: impact, weight: roll.weight });
    }

    if (!coverageComplete || !hasCompleteDiceDistribution(rolls, impactWeight)) continue;
    const continuationExpected = expectedImpact / impactWeight;
    const continuationTailRisk = weightedLowerTailMean(impactOutcomes);
    const continuationAdjustment = continuationExpected * 0.24
      + continuationTailRisk * 0.1 * threatPressure(representativeFrontier.state, color);
    accumulator.candidate.score += continuationAdjustment;
    Object.assign(accumulator.candidate.tactical, {
      continuationExpected,
      continuationWorst: worstImpact,
      continuationTailRisk,
      continuationTailWeight: DICE_TAIL_WEIGHT,
      continuationRolls: rolls,
      continuationWeight: impactWeight,
      continuationDistributionComplete: true,
      continuationModelComplete: true,
      continuationModelKind: 'representative-worst-proxy-v1',
      continuationApproximate: approximate,
      continuationCoverageComplete: !approximate,
      continuationFrontierCount: continuationFrontiers.length,
      continuationFrontierWeight: frontierWeight,
      continuationTotalFrontierCount: totalFrontierCount,
      continuationTotalFrontierWeight: CANONICAL_DICE_WEIGHT,
      continuationProxyWeight: continuationFrontiers.reduce((sum, frontier) => (
        sum + Number(frontier.proxyWeight || 0)
      ), 0),
      continuationWorstRecoveryFrontierWeight: worstRecoveryWeight,
      // Record the original role provenance before board deduplication. If
      // representative and worst collapse to one board, their proxy weights
      // still sum to 36; neither proxy weight is actual sampled dice mass.
      continuationRepresentativeDiceKey: representativeFrontier.diceKey,
      continuationRepresentativeDiceWeight: representativeFrontier.weight,
      continuationRepresentativeProxyWeight: CANONICAL_DICE_WEIGHT - worstRecoveryWeight,
      continuationWorstRecoveryDiceKey: worstFrontier.diceKey,
      continuationWorstRecoveryDiceWeight: worstFrontier.weight,
      continuationWorstRecoveryProxyWeight: worstRecoveryWeight,
      continuationRepresentativeFrontierIncluded: continuationFrontiers.some(
        frontier => frontier.kind === 'representative' || frontier.kind === 'representative+worst',
      ),
      continuationWorstFrontierIncluded: continuationFrontiers.some(
        frontier => frontier.kind === 'worst' || frontier.kind === 'representative+worst',
      ),
      continuationAdjustment,
      plies: 4,
    });
  }
}

function uniqueContinuationFrontiers(frontiers) {
  const byPosition = new Map();
  for (const frontier of frontiers) {
    if (!frontier?.state) continue;
    const key = positionKey(frontier.state);
    const current = byPosition.get(key);
    if (!current) {
      byPosition.set(key, frontier);
      continue;
    }
    current.proxyWeight = Number(current.proxyWeight || 0)
      + Number(frontier.proxyWeight || 0);
    if (current.kind !== frontier.kind) current.kind = 'representative+worst';
  }
  return [...byPosition.values()];
}

function selectContinuationCandidates(deepCandidates) {
  const selected = selectDeepCandidates(deepCandidates
    .filter(accumulator => (
      accumulator.recoveryFrontiers?.length
      && Number(accumulator.candidate.tactical?.plies || 0) < 4
    ))
    .sort((left, right) => right.candidate.score - left.candidate.score));
  const reserved = selected.filter(accumulator => (
    hasTacticalReservation(accumulator.candidate)
  ));
  const ordinary = selected.filter(accumulator => (
    !hasTacticalReservation(accumulator.candidate)
  ));
  // Tactical reservations are explicit promises that a structurally important
  // move will receive the same four-ply evidence as the score leaders. Apply
  // the ordinary continuation cap only after every reserved board is kept.
  return [
    ...reserved,
    ...ordinary.slice(0, MAX_CONTINUATION_CANDIDATES),
  ];
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
  const startZone = Number(features.startZoneBefore) || 0;
  const trap = opponentTrapRisk(state, color);
  const pipDelta = pipsFor(state, color) - pipsFor(state, opponent);
  const homeShuffleMoves = Math.max(0, Number(features.homeShuffleMoves) || 0);
  const hasAvoidableHomeShuffle = Object.prototype.hasOwnProperty.call(
    features || {},
    'avoidableHomeShuffleMoves',
  );
  const avoidableHomeShuffleMoves = hasAvoidableHomeShuffle
    ? Math.max(0, Number(features.avoidableHomeShuffleMoves) || 0)
    : 0;
  const homeShuffleAction = avoidableHomeShuffleMoves > 0
    ? 'home:shuffle'
    : homeShuffleMoves > 0
      ? hasAvoidableHomeShuffle ? 'home:forced' : 'home:unknown'
      : 'home:steady';
  const prospectiveFenceAction = Number(features.prospectiveFenceInterruptionBreak || 0) > 0
    ? 'prospective-fence:break'
    : signedFlag('prospective-fence', features.prospectiveFenceExtensionDelta);
  const prospectiveFenceBehavior = Number(
    features.avoidableProspectiveFenceAnchorMiss || 0,
  ) > 0
    ? 'prospective-fence:avoidable-anchor-miss'
    : Number(features.avoidableProspectiveFenceInterruptionBreak || 0) > 0
      ? 'prospective-fence:avoidable-break'
      : Number(features.prospectiveFenceInterruptionBreak || 0) > 0
        ? 'prospective-fence:necessary-break'
        : signedFlag('prospective-fence', features.prospectiveFenceExtensionDelta);
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
    bucket('sz', startZone, [0, 1, 3, 6]),
    bucket('tr', trap, [0, 40, 180, 600]),
    bucket('pd', pipDelta, [-36, -8, 9, 37]),
  ].join('|');

  const legacyActionKey = [
    signedFlag('head', features.headGain),
    signedFlag('entry', features.outsideReduction),
    signedFlag('trap', features.trapDelta),
    prospectiveFenceAction,
    signedFlag('freedom', features.opponentHeadFreedomDelta),
    signedFlag('distribution', features.distributionDelta),
    Number(features.headLandingBreak || 0) > 0 ? 'support:break' : 'support:keep',
    homeShuffleAction,
    Number(features.bearOffMoves || 0) > 0 ? 'off:yes' : 'off:no',
  ].join('|');
  const familyActionKey = `${legacyActionKey}|${signedFlag('tower', features.routeTowerDelta)}`;
  const hasAdvancedStrategy = Number.isFinite(Number(features.primeScoreGain));
  const strategicActionKey = hasAdvancedStrategy
    ? [
      familyActionKey,
      signedFlag('prime', features.primeScoreGain),
      signedFlag('block', features.opponentMoveBlockGain),
      `prime-run:${Math.max(0, Number(features.primeRunAfter) || 0)}`,
    ].join('|')
    : familyActionKey;
  const rescueAction = Number(features.missedKoksRescue || 0) > 0
    ? 'koks:miss'
    : Number(features.startZoneReduction || 0) > 0
      ? 'koks:gain'
      : 'koks:flat';
  const actionKey = `${strategicActionKey}|${rescueAction}|route:${features.routeSignature || 'none'}`;
  // These compact keys preserve the strategic intent that must transfer across
  // different dice and route signatures. The exact/family keys still provide
  // precision, while these keys let repeated home-shuffle and fence mistakes
  // teach the next materially similar position.
  const behaviorActionKeys = [
    [
      signedFlag('entry', features.outsideReduction),
      signedFlag('progress', features.outsidePipGain),
      homeShuffleAction,
      signedFlag('tower', features.routeTowerDelta),
      signedFlag('prime', features.primeScoreGain),
      `prime-run:${Math.max(0, Number(features.primeRunAfter) || 0)}`,
      Number(features.bearOffMoves || 0) > 0 ? 'off:yes' : 'off:no',
    ].join('|'),
    [
      signedFlag('trap', features.trapDelta),
      signedFlag('fence', features.fenceClosureDelta),
      signedFlag('gateway', features.escapeGatewayDelta),
      signedFlag('block', features.opponentMoveBlockGain),
      signedFlag('latent', features.latentFenceExposureDelta),
    ].join('|'),
    // Keep the established v33 aliases at indexes 0..2.  The server-side
    // aggregate and frozen sessions already treat index 2 as prospective-fence
    // evidence, so new compatible aliases must only be appended.
    prospectiveFenceBehavior,
    [
      signedFlag('prime-timing', features.primeSustainabilityDelta),
      signedFlag('self-crunch', features.primeCrunchRiskDelta),
      `prime-run:${Math.max(0, Number(features.primeRunAfter) || 0)}`,
    ].join('|'),
  ];

  const urgency = 1
    + opponentOff * 0.12
    + (homeReady(state, opponent) ? 0.65 : 0)
    + (phase === 'koks-rescue' ? 0.8 : 0);
  let mistakeSeverity = 0;
  mistakeSeverity += Math.min(3, Math.max(0, Number(features.headLandingBreak) || 0)) * 0.9;
  mistakeSeverity += Math.max(0, -(Number(features.opponentHeadFreedomDelta) || 0)) * 0.14;
  mistakeSeverity += Math.max(0, -(Number(features.fenceClosureDelta) || 0)) * 0.18;
  mistakeSeverity += Math.min(
    4,
    Math.max(0, Number(features.avoidableProspectiveFenceInterruptionBreak) || 0) / 24,
  );
  mistakeSeverity += Math.min(
    4,
    Math.max(0, Number(features.avoidableProspectiveFenceAnchorMiss) || 0) / 12,
  );
  mistakeSeverity += Math.min(3.2, Math.max(0, -(Number(features.routeTowerDelta) || 0)) / 180);
  mistakeSeverity += Math.min(3.4, Math.max(0, -(Number(features.primeScoreGain) || 0)) / 900);
  mistakeSeverity += Math.min(2.8, Math.max(0, -(Number(features.opponentMoveBlockGain) || 0)) / 80);
  mistakeSeverity += Math.min(
    4,
    Math.max(0, -(Number(features.latentFenceExposureDelta) || 0)),
  );
  mistakeSeverity += Math.min(
    4.5,
    Math.max(0, -(Number(features.primeCrunchRiskDelta) || 0)) * 1.7,
  );
  if (
    Number(features.primeRunAfter || 0) >= 4
    && Number(features.primeSustainabilityAfter || 0) < 0.32
  ) {
    mistakeSeverity += (0.32 - Number(features.primeSustainabilityAfter || 0)) * 5;
  }
  if (
    Number(features.primeRunBefore || 0) >= 4
    && Number(features.primeRunAfter || 0) < Number(features.primeRunBefore || 0)
  ) {
    mistakeSeverity += 1.4
      + (Number(features.primeRunBefore) - Number(features.primeRunAfter)) * 0.55;
  }
  if (Number(features.trapBefore || 0) > 0 && Number(features.trapDelta || 0) <= 0) {
    mistakeSeverity += Math.min(2.4, Number(features.trapBefore) / 180);
  }
  const outsideAfterMove = Math.max(0, outside - Number(features.outsideReduction || 0));
  const completedEntryWithAvoidableShuffle = phase === 'late-entry'
    && outsideAfterMove === 0
    && avoidableHomeShuffleMoves > 0;
  if (
    avoidableHomeShuffleMoves > 0
    && (outsideAfterMove > 0 || completedEntryWithAvoidableShuffle)
  ) {
    const baseShuffleSeverity = Number(features.outsideReduction || 0) > 0 ? 0.75 : 1.15;
    // Entering the final checker does not excuse spending the other die on a
    // safely avoidable home shuffle. In 8RMS that hid a legal bear-off from
    // outcome credit and let a win reinforce the objectively weaker move.
    mistakeSeverity += baseShuffleSeverity
      + (completedEntryWithAvoidableShuffle ? 0.55 : Math.min(1.2, outsideAfterMove / 8));
  }
  if (ownHead > 0 && Number(features.headGain || 0) <= 0 && (ownHead <= 2 || opponentOff > 0)) {
    mistakeSeverity += 1.4;
  }
  if (phase === 'koks-rescue' && Number(features.missedKoksRescue || 0) > 0) {
    mistakeSeverity += Math.min(
      4,
      Number(features.missedKoksRescue) * (1.2 + opponentOff * 0.12),
    );
  }
  if (tactical && Number(tactical.worstImpact) < -4000000) {
    mistakeSeverity += Math.min(2.2, Math.abs(Number(tactical.worstImpact)) / 16000000);
  }

  const structuralRisk = Math.max(
    Math.max(0, -(Number(features.routeTowerDelta) || 0)) / 90,
    Number(features.maxRouteTowerAfter || 0) >= 6
      ? (Number(features.maxRouteTowerAfter) - 5) * 0.85
      : 0,
    Number(features.trapBefore || 0) >= 600 && Number(features.trapDelta || 0) <= 0
      ? Math.min(4, Number(features.trapBefore) / 900)
      : 0,
    Number(features.escapeGatewayDelta || 0) < 0 && Number(features.trapBefore || 0) >= 180
      ? Math.min(3, Math.abs(Number(features.escapeGatewayDelta)) / 3)
      : 0,
    Math.min(6, Math.max(0, -(Number(features.latentFenceExposureDelta) || 0))),
    Math.min(
      6,
      Math.max(0, Number(features.avoidableProspectiveFenceInterruptionBreak) || 0) / 18,
    ),
    Math.min(
      6,
      Math.max(0, Number(features.avoidableProspectiveFenceAnchorMiss) || 0) / 12,
    ),
    Math.min(6, Math.max(0, -(Number(features.primeCrunchRiskDelta) || 0)) * 1.8),
    Number(features.primeRunAfter || 0) >= 4
      ? Math.max(0, 0.35 - Number(features.primeSustainabilityAfter || 0)) * 8
      : 0,
    avoidableHomeShuffleMoves > 0
      && (outsideAfterMove > 0 || completedEntryWithAvoidableShuffle)
      ? 1.1 + Math.min(2.2, Math.max(1, outsideAfterMove) / 5)
      : 0,
    Number(features.primeRunBefore || 0) >= 4
      && Number(features.primeRunAfter || 0) < Number(features.primeRunBefore || 0)
      ? 2 + Number(features.primeRunBefore) - Number(features.primeRunAfter)
      : 0,
  );
  const tacticalRisk = tactical
    ? Math.min(6, Math.abs(Math.min(0, Number(tactical.worstImpact) || 0)) / 12000000)
    : 0;
  const riskSignal = Math.min(10, Math.max(mistakeSeverity * urgency, structuralRisk, tacticalRisk));

  return {
    contextKey,
    actionKey,
    strategicActionKey,
    familyActionKey,
    legacyActionKey,
    behaviorActionKeys,
    mistakeSeverity: Math.min(8, mistakeSeverity * urgency),
    riskSignal,
    phase,
  };
}

function normalizeExperiencePatterns(patterns = []) {
  const contributions = new Map();
  const normalized = new Map();
  (Array.isArray(patterns) ? patterns : []).forEach((pattern) => {
    const contextKey = String(pattern?.contextKey || pattern?.context_key || '');
    const actionKey = String(pattern?.actionKey || pattern?.action_key || '');
    if (!contextKey || !actionKey) return;
    const key = `${contextKey}::${actionKey}`;
    const contribution = {
      contextKey,
      actionKey,
      // Server causal evidence was generated for one exact descriptor. Unlike
      // legacy observations it has no validated cross-context/action credit.
      exactOnly: pattern?.creditVersion === 9
        && pattern?.evidenceSchema === 'long-server-causal-pattern-v1',
      samples: Math.max(0, Number(pattern.samples) || 0),
      losses: Math.max(0, Number(pattern.losses) || 0),
      wins: Math.max(0, Number(pattern.wins) || 0),
      lossWeight: Math.max(
        0,
        Number(pattern.lossWeight ?? pattern.loss_weight ?? pattern.losses) || 0,
      ),
      severeLosses: Math.max(
        0,
        Number(pattern.severeLosses ?? pattern.severe_losses) || 0,
      ),
      signalWeight: Math.max(
        0,
        Number(pattern.signalWeight ?? pattern.signal_weight) || 0,
      ),
      winWeight: Math.max(
        0,
        Number(pattern.winWeight ?? pattern.win_weight) || 0,
      ),
    };
    // Exact duplicates are correlated snapshots, not independent games. Keep
    // the strongest one instead of multiplying its evidence by array order.
    // Source precedence is resolved by the engine before normalization.
    const current = contributions.get(key);
    const evidenceRank = item => [
      item.samples,
      item.losses + item.wins,
      item.lossWeight + item.winWeight,
      item.signalWeight,
      item.severeLosses,
    ];
    const candidateRank = evidenceRank(contribution);
    const currentRank = evidenceRank(current || {});
    const firstDifference = candidateRank.findIndex(
      (value, index) => value !== currentRank[index],
    );
    const isStronger = !current
      || (firstDifference >= 0 && candidateRank[firstDifference] > currentRank[firstDifference]);
    if (isStronger) contributions.set(key, contribution);
  });

  contributions.forEach((contribution, key) => {
    const { contextKey, actionKey } = contribution;
    mergePattern(normalized, key, contribution, contextKey, actionKey);
    if (contribution.exactOnly) return;

    const phase = contextKey.split('|')[0] || 'route';
    const strategic = strategicContextKey(contextKey);
    mergePattern(normalized, `strategy:${strategic}::${actionKey}`, contribution, strategic, actionKey);
    mergePattern(normalized, `phase:${phase}::${actionKey}`, contribution, phase, actionKey);
    mergePattern(normalized, `*::${actionKey}`, contribution, '*', actionKey);
  });
  return normalized;
}

function experienceAdjustment(descriptor, experience) {
  if (!descriptor || !(experience instanceof Map)) return 0;
  const phase = descriptor.phase || String(descriptor.contextKey || '').split('|')[0] || 'route';
  const strategic = strategicContextKey(descriptor.contextKey);
  const behaviorActionKeys = Array.isArray(descriptor.behaviorActionKeys)
    ? descriptor.behaviorActionKeys.filter(Boolean)
    : [];
  const hasStrategicAction = descriptor.strategicActionKey
    && descriptor.strategicActionKey !== descriptor.familyActionKey;
  const actionKeys = (hasStrategicAction
    ? [
      descriptor.actionKey,
      descriptor.strategicActionKey,
      descriptor.familyActionKey,
      ...behaviorActionKeys,
      descriptor.legacyActionKey,
    ]
    : [
      descriptor.actionKey,
      descriptor.familyActionKey,
      ...behaviorActionKeys,
      descriptor.legacyActionKey,
    ]
  ).filter(Boolean);

  const contextLevels = [
    { key: descriptor.contextKey, minimum: 3, weight: 1 },
    { key: `strategy:${strategic}`, minimum: 5, weight: 0.78 },
    { key: `phase:${phase}`, minimum: 8, weight: 0.52 },
    { key: '*', minimum: 16, weight: 0.28 },
  ];
  const actionWeights = hasStrategicAction
    ? [1, 0.86, 0.68, ...(behaviorActionKeys.map(() => 0.58)), 0.5]
    : [1, 0.76, ...(behaviorActionKeys.map(() => 0.62)), 0.56];
  const matches = [];
  for (const level of contextLevels) {
    for (let index = 0; index < actionKeys.length; index += 1) {
      const actionKey = actionKeys[index];
      const pattern = experience.get(`${level.key}::${actionKey}`);
      if (!pattern) continue;
      // Merely omitting generalized map entries is insufficient: a different
      // action can still carry this key as a family/behavior/legacy alias.
      if (pattern.exactOnly === true && (
        level.key !== descriptor.contextKey || actionKey !== descriptor.actionKey
      )) continue;
      const severeEvidence = pattern.severeLosses >= 2 && pattern.lossWeight >= 4;
      const winningEvidence = pattern.wins >= 3 && pattern.winWeight >= 3;
      if (pattern.samples < level.minimum && !severeEvidence && !winningEvidence) continue;
      matches.push({
        pattern,
        weight: level.weight * (actionWeights[index] || 0.4),
      });
    }
  }
  if (!matches.length) return 0;

  // Exact, strategic, family, behavior and legacy keys describe the same
  // decision, so never add their adjustments as if they were independent
  // games. Evaluate each representation on its own, then arbitrate between
  // the resulting signals. A risky move must not be rewarded merely because
  // a neutral exact alias happened to be checked before a repeatedly harmful
  // transferable behavior alias.
  const adjustments = matches.map(match => adjustmentForExperienceMatch(descriptor, match));
  const descriptorRisk = Math.max(
    Number(descriptor.riskSignal) || 0,
    Number(descriptor.mistakeSeverity) || 0,
  );
  if (descriptorRisk >= EXPERIENCE_RISK_THRESHOLD) {
    const penalties = adjustments.filter(adjustment => adjustment < 0);
    if (penalties.length) return Math.min(...penalties);
  }

  // The iteration order is intentionally exact-to-general. When the signals
  // are compatible (or no safety penalty exists), retain the most-specific
  // qualifying evidence instead of letting a broad alias overpower it.
  return adjustments[0];
}

function adjustmentForExperienceMatch(descriptor, match) {
  const { pattern, weight } = match;
  const matchConfidence = Math.min(0.92, pattern.samples / (pattern.samples + 7));
  const evidenceWeight = weight * matchConfidence;
  if (!evidenceWeight) return 0;
  // Frequency and severity are different signals. Treating severity-weighted
  // lossWeight as a loss count used to penalize actions that won most games.
  const lossRate = Math.min(0.98, (pattern.losses + 0.5) / (pattern.samples + 1.5));
  const lossSeverity = pattern.losses > 0
    ? Math.max(1, pattern.lossWeight / pattern.losses)
    : 1;
  const severeRate = pattern.severeLosses / Math.max(1, pattern.samples);
  const learnedSeverity = Math.min(5, pattern.signalWeight / Math.max(1, pattern.losses));
  const weightedSamples = pattern.samples * weight;
  const winRate = pattern.wins / Math.max(1, pattern.samples);
  const winQuality = pattern.winWeight / Math.max(1, pattern.wins);
  const confidence = Math.min(0.9, weightedSamples / (weightedSamples + 9));
  const relevance = 1.35 + Math.min(3.2, Math.max(
    Number(descriptor.riskSignal) || 0,
    Number(descriptor.mistakeSeverity) || 0,
  ));
  if (lossRate >= 0.42) {
    const penalty = (
      18000000
      * confidence
      * (lossRate - 0.28)
      * (1 + severeRate * 1.5)
      * (1 + Math.max(0, lossSeverity - 1) * 0.24)
      * (1 + learnedSeverity * 0.2)
      * relevance
    );
    return -Math.min(MAX_EXPERIENCE_PENALTY, penalty);
  }
  if (weightedSamples >= 5 && lossRate <= 0.24 && severeRate <= 0.08 && winRate >= 0.55) {
    const reward = 9000000
      * confidence
      * (0.35 + winRate)
      * Math.min(1.8, relevance)
      * Math.min(1.5, 0.7 + winQuality * 0.3);
    return Math.min(MAX_EXPERIENCE_REWARD, reward);
  }
  return 0;
}

function mergePattern(target, key, pattern, contextKey, actionKey) {
  const current = target.get(key) || {
    contextKey,
    actionKey,
    samples: 0,
    losses: 0,
    wins: 0,
    lossWeight: 0,
    severeLosses: 0,
    signalWeight: 0,
    winWeight: 0,
  };
  current.samples += pattern.samples;
  current.losses += pattern.losses;
  current.wins += pattern.wins;
  current.lossWeight += pattern.lossWeight;
  current.severeLosses += pattern.severeLosses;
  current.signalWeight += pattern.signalWeight;
  current.winWeight += pattern.winWeight;
  if (pattern.exactOnly === true) current.exactOnly = true;
  target.set(key, current);
}

function strategicContextKey(contextKey) {
  const parts = String(contextKey || '').split('|').filter(Boolean);
  const phase = parts[0] || 'route';
  const dimensions = ['o', 'po', 'tr']
    .map(prefix => parts.find(part => part.startsWith(prefix)))
    .filter(Boolean);
  return [phase, ...dimensions].join('|');
}

function prepareReplyState(state, color, dice, expandDoubles = false) {
  const resolvedDice = expandDoubles && dice.length === 2 && dice[0] === dice[1]
    ? [dice[0], dice[0], dice[0], dice[0]]
    : [...dice];
  return {
    ...state,
    turn: color,
    phase: 'move',
    dice: resolvedDice,
    rolled: [...resolvedDice],
    turnMoves: [],
    headPlayedThisTurn: {
      ...(state.headPlayedThisTurn || {}),
      [color]: false,
    },
  };
}

function sampledSequenceResults(adapter, state, color, sequences, limit, options = {}) {
  const legal = (Array.isArray(sequences) ? sequences : []).filter(sequence => sequence?.length);
  if (!legal.length) return [];
  const normalizedLimit = Math.max(1, Number(limit) || 1);
  const preferredIndexes = [];
  const queuedIndexes = new Set();
  const queue = (index) => {
    if (index < 0 || index >= legal.length || queuedIndexes.has(index)) return;
    queuedIndexes.add(index);
    preferredIndexes.push(index);
  };
  if (options.preferLeading) {
    for (let index = 0; index < normalizedLimit; index += 1) queue(index);
  } else {
    const bestBearOffIndex = legal.reduce((bestIndex, sequence, index) => {
      const offMoves = sequence.filter(move => move.bearOff || move.to === 0).length;
      const bestOffMoves = legal[bestIndex]
        .filter(move => move.bearOff || move.to === 0).length;
      return offMoves > bestOffMoves ? index : bestIndex;
    }, 0);
    if (legal[bestBearOffIndex].some(move => move.bearOff || move.to === 0)) {
      queue(bestBearOffIndex);
    }
    for (let index = 0; index < normalizedLimit; index += 1) {
      queue(Math.round(index * (legal.length - 1) / Math.max(1, normalizedLimit - 1)));
    }
  }
  // Uniform probes retain the old sampling bias. The ordered fallback only
  // fills holes when those probes are equivalent move orders.
  for (let index = 0; index < legal.length; index += 1) queue(index);

  const sampled = [];
  const seenPositions = new Set();
  for (const index of preferredIndexes) {
    if (sampled.length >= normalizedLimit) break;
    const sequence = legal[index];
    const after = adapter.applySequence(state, sequence, color);
    const key = positionKey(after);
    if (seenPositions.has(key)) continue;
    seenPositions.add(key);
    sampled.push({ sequence, after });
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
const DEFAULT_ANALYSIS_NODE_BUDGET = 1150;
const LATENT_REAR_ESCAPE_SCORE_TOLERANCE = 420000000;
const IMMINENT_HEAD_FENCE_SCORE_TOLERANCE = 8000000;
const CONTESTED_HEAD_EXIT_SCORE_TOLERANCE = 60000000;

function createLongBotEngine(adapter, options = {}) {
  const defaultWeights = mergeWeights(options.weights);
  const defaultMaxCandidates = Number(options.maxCandidates) || DEFAULT_MAX_CANDIDATES;
  const defaultAnalysisNodeBudget = normalizeAnalysisNodeBudget(
    options.analysisNodeBudget,
    DEFAULT_ANALYSIS_NODE_BUDGET,
  );
  const experienceSources = new Map();
  let selectedExperiencePatterns = [];
  let experience = new Map();

  function rank(state, color = state.turn, runtimeOptions = {}) {
    if (!color) return [];
    const weights = mergeWeights({ ...defaultWeights, ...(runtimeOptions.weights || {}) });
    const maxCandidates = Number(runtimeOptions.maxCandidates) || defaultMaxCandidates;
    const analysisNodeBudget = normalizeAnalysisNodeBudget(
      runtimeOptions.analysisNodeBudget,
      defaultAnalysisNodeBudget,
    );
    const budget = createAnalysisBudget(analysisNodeBudget);
    const strategyProfile = String(runtimeOptions.strategyProfile || 'v19').toLowerCase();
    const advancedStrategy = strategyProfile !== 'v19';
    const useExperience = advancedStrategy
      || !Object.prototype.hasOwnProperty.call(runtimeOptions, 'strategyProfile');
    const sequences = adapter.legalSequences(state, color).filter(sequence => sequence?.length);
    if (!sequences.length) return [];

    const candidates = prefilterSequences(adapter, state, color, sequences, maxCandidates);
    const ranked = [];
    const advancedBeforeMetrics = advancedStrategy
      ? advancedStateMetrics(state, color)
      : null;
    for (const sequence of candidates) {
      if (!budget.consume()) break;
      const after = adapter.applySequence(state, sequence, color);
      const features = sequenceStats(state, after, color, sequence);
      if (advancedStrategy) {
        Object.assign(features, advancedSequenceStats(
          advancedBeforeMetrics,
          after,
          color,
        ));
      }
      ranked.push({
        sequence,
        after,
        score: scoreSequence(state, after, color, sequence, weights),
        features,
      });
    }

    const choiceCount = uniqueCandidatePositions(ranked).length;
    ranked.forEach((candidate) => {
      candidate.features.choiceCount = choiceCount;
    });

    const maxKoksRescue = Math.max(...ranked.map(
      candidate => Number(candidate.features.startZoneReduction) || 0,
    ));
    ranked.forEach((candidate) => {
      candidate.features.koksRescueOpportunity = maxKoksRescue;
      candidate.features.missedKoksRescue = Math.max(
        0,
        maxKoksRescue - (Number(candidate.features.startZoneReduction) || 0),
      );
      candidate.baseScore = candidate.score;
      candidate.score += strategicSafetyAdjustment(state, color, candidate.features);
      if (advancedStrategy) {
        candidate.features.advancedStrategyAdjustment = advancedStrategyAdjustment(
          state,
          color,
          candidate.features,
        );
        candidate.score += candidate.features.advancedStrategyAdjustment;
      }
      candidate.features.strategyProfile = strategyProfile;
    });
    annotateAvoidableHomeShuffles(ranked, state, color);
    ranked.forEach((candidate) => {
      candidate.experience = experienceDescriptor(state, color, candidate.features);
      // Learned outcomes must not decide which moves receive tactical analysis.
      // Keep the descriptor for telemetry, then apply experience only after the
      // cold strategy and reply search establish a safety baseline.
      candidate.experienceAdjustment = 0;
    });

    let strategicallyRanked = prioritizeForcedRacePlay(state, color, ranked)
      .sort((left, right) => right.score - left.score);
    const opponentOffBeforeMove = offCount(state, opponentOf(color));
    if (
      opponentOffBeforeMove >= 3
      && offCount(state, color) === 0
      && startZoneCount(state, color) > 0
    ) {
      const bestResultSafety = Math.max(...strategicallyRanked.map(
        candidate => Number(candidate.features.resultSafetyAfter) || 0,
      ));
      const safest = strategicallyRanked.filter(
        candidate => Number(candidate.features.resultSafetyAfter) === bestResultSafety,
      );
      const maxStartExit = Math.max(...safest.map(
        candidate => Number(candidate.features.startZoneReduction) || 0,
      ));
      if (maxStartExit > 0) {
        strategicallyRanked = safest.filter(
          candidate => Number(candidate.features.startZoneReduction) === maxStartExit,
        );
      }
    }
    strategicallyRanked = reserveStructuralIntegrityForTacticalAnalysis(
      state,
      color,
      strategicallyRanked,
    );
    strategicallyRanked = reserveHomeEntryForTacticalAnalysis(
      state,
      color,
      strategicallyRanked,
    );
    strategicallyRanked = reserveRouteContinuityForTacticalAnalysis(
      state,
      color,
      strategicallyRanked,
    );
    strategicallyRanked = reserveDevelopingFenceEscapeForTacticalAnalysis(
      state,
      color,
      strategicallyRanked,
    );
    strategicallyRanked = reservePrimeSustainabilityForTacticalAnalysis(
      state,
      color,
      strategicallyRanked,
    );
    const outside = outsideHomeCount(state, color);
    const trapPressure = opponentTrapRisk(state, color);
    const maxEntry = Math.max(...strategicallyRanked.map(
      candidate => Number(candidate.features.outsideReduction) || 0,
    ));
    const fenceRun = Math.max(...strategicallyRanked.map(
      candidate => Number(candidate.features.opponentFenceRunBefore) || 0,
    ));
    const nonSevereTowerCandidates = fenceRun >= 5
      ? strategicallyRanked.filter(candidate => Number(candidate.features.maxRouteTowerAfter) < 7)
      : [];
    const hasSevereTowerCandidate = strategicallyRanked.some(
      candidate => Number(candidate.features.maxRouteTowerAfter) >= 7,
    );
    let strategicallyEligible = hasSevereTowerCandidate && nonSevereTowerCandidates.length
      ? nonSevereTowerCandidates
      : trapPressure > 850 && outside <= 8 && maxEntry > 0 && fenceRun < 4
        ? strategicallyRanked.filter(
          candidate => Number(candidate.features.outsideReduction) === maxEntry,
        )
        : strategicallyRanked;
    const headRemaining = headCheckers(state, color);
    const maxHeadRelease = Math.max(...strategicallyEligible.map(
      candidate => Number(candidate.features.headGain) || 0,
    ));
    const opponentOff = offCount(state, opponentOf(color));
    const headReleaseIsCritical = maxHeadRelease > 0 && (
      headRemaining <= 2
      || headRemaining >= 7
      || trapPressure >= 600
      || fenceRun >= 4
      || opponentOff > 0
    );
    if (headReleaseIsCritical) {
      strategicallyEligible = strategicallyEligible.filter(
        candidate => Number(candidate.features.headGain || 0) === maxHeadRelease
          || Number(candidate.features.structuralIntegrityTacticalReservation || 0) > 0,
      );
    }
    if (fenceRun >= 5) {
      const gateways = criticalFenceGatewayPoints(state, color);
      if (gateways.length) {
        const preserving = strategicallyEligible.filter(candidate => gateways.every(
          point => colorAt(candidate.after, point) === color,
        ));
        if (preserving.length) strategicallyEligible = preserving;
      }
      const maxSafeEntry = Math.max(...strategicallyEligible.map(
        candidate => Number(candidate.features.outsideReduction) || 0,
      ));
      if (maxSafeEntry > 0) {
        strategicallyEligible = strategicallyEligible.filter(
          candidate => Number(candidate.features.outsideReduction) === maxSafeEntry,
        );
      }
    }
    // Tactical work is intentionally delayed until every structural policy has
    // selected its shortlist. Otherwise the budget can be spent on candidates
    // which are later discarded, leaving the actual move without dice analysis.
    const tacticalPool = tacticalCoveragePool(strategicallyEligible, strategicallyRanked);
    const advancedTacticallyAdjusted = new Set();
    const applyAdvancedTacticalAdjustment = (candidate) => {
      if (!advancedStrategy || advancedTacticallyAdjusted.has(candidate)) return;
      const adjustment = advancedTacticalAdjustment(state, color, candidate);
      candidate.features.advancedTacticalAdjustment = adjustment;
      candidate.score += adjustment;
      advancedTacticallyAdjusted.add(candidate);
    };
    const tacticallyRanked = analyzeOpponentReplies(
      adapter,
      color,
      tacticalPool,
      weights,
      budget,
      {
        expandDoubles: advancedStrategy,
        beforeDeepCandidate: advancedStrategy
          ? applyAdvancedTacticalAdjustment
          : null,
        beforeDeepSelection: advancedStrategy
          ? (primaryCandidates) => {
            let reprioritized = [...primaryCandidates]
              .sort((left, right) => right.score - left.score);
            reprioritized = reserveStructuralIntegrityForTacticalAnalysis(
              state,
              color,
              reprioritized,
            );
            reprioritized = reserveHomeEntryForTacticalAnalysis(
              state,
              color,
              reprioritized,
            );
            reprioritized = reserveRouteContinuityForTacticalAnalysis(
              state,
              color,
              reprioritized,
            );
            reprioritized = reserveDevelopingFenceEscapeForTacticalAnalysis(
              state,
              color,
              reprioritized,
            );
            return reservePrimeSustainabilityForTacticalAnalysis(
              state,
              color,
              reprioritized,
            );
          }
          : null,
      },
    );
    if (advancedStrategy) {
      tacticallyRanked.forEach(applyAdvancedTacticalAdjustment);
      tacticallyRanked.sort((left, right) => right.score - left.score);
    }
    const deeplyAnalyzedCandidates = strategicallyEligible.filter(
      candidate => Number(candidate.tactical?.plies || 0) >= 4,
    );
    const analyzedCandidates = strategicallyEligible.filter(candidate => candidate.tactical);
    // Never promote an unchecked move merely because analyzed candidates
    // received realistic reply penalties. Prefer the adaptive four-ply beam;
    // fall back to complete primary analysis only when the deep budget ran out.
    let finalCandidates = deeplyAnalyzedCandidates.length
      ? deeplyAnalyzedCandidates
      : analyzedCandidates.length
        ? analyzedCandidates
      : strategicallyEligible;
    finalCandidates = prioritizeSevereReplySafety(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
    finalCandidates = prioritizeTacticallyDominantHomeProgress(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
    finalCandidates = prioritizeContestedOpponentHeadExit(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
    finalCandidates = prioritizeImminentHeadFenceAnchor(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
    finalCandidates = prioritizeDevelopingFenceEscape(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
    const sortedCandidates = prioritizeLatentTrapDistribution(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
    const developedCandidates = prioritizePreHomeDevelopment(
      state,
      color,
      prioritizeSafeEarlyDevelopment(state, color, sortedCandidates),
    );
    const distributedCandidates = prioritizeRouteDistribution(
      state,
      color,
      developedCandidates,
    );
    let coldRanked = prioritizeCriticalClearedHeadLaggardEscape(
      state,
      color,
      prioritizeSevereReplySafety(
        state,
        color,
        prioritizeRouteContinuity(
          state,
          color,
          prioritizeTransitionBearOff(
            state,
            color,
            prioritizeAvailableHomeEntry(state, color, distributedCandidates),
          ),
        ),
      ),
    );
    coldRanked = prioritizeProspectiveFenceInterruption(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeProspectiveFenceAnchorSafety(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeProbabilisticFenceDenial(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeVerifiedDeepSafety(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeTacticallyEquivalentStructure(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeAvailableHomeEntry(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeAvoidableHomeShuffle(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeStructuralIntegrity(
      state,
      color,
      coldRanked,
    );
    annotateAvoidableProspectiveFenceInterruptions(state, color, coldRanked);
    annotateAvoidableProspectiveFenceAnchorMisses(state, color, coldRanked);
    const coldSelected = coldRanked[0];
    coldRanked.forEach((candidate) => {
      candidate.experience = experienceDescriptor(
        state,
        color,
        candidate.features,
        candidate.tactical,
      );
      candidate.experienceAdjustment = useExperience
        ? policyAwareExperienceAdjustment(
          candidate.experience,
          experience,
          candidate.score,
        )
        : 0;
      candidate.score += candidate.experienceAdjustment;
    });
    const finalRanked = prioritizeExperienceWithinSafetyEnvelope(
      coldRanked,
      coldSelected,
    );
    finalRanked.forEach((candidate) => {
      candidate.features.analysisNodesUsed = budget.used;
      candidate.features.analysisNodeBudget = budget.limit;
    });
    return finalRanked;
  }

  function plan(state, color = state.turn, runtimeOptions = {}) {
    const ranked = rank(state, color, runtimeOptions);
    return (ranked[0]?.sequence || []).map(move => ({ from: move.from, die: move.die }));
  }

  function describeSequence(state, sequence, color = state.turn, runtimeOptions = {}) {
    if (!state || !color || !Array.isArray(sequence) || !sequence.length) return null;
    const after = adapter.applySequence(state, sequence, color);
    const features = sequenceStats(state, after, color, sequence);
    const strategyProfile = String(runtimeOptions.strategyProfile || 'v20').toLowerCase();
    if (strategyProfile !== 'v19') {
      Object.assign(features, advancedSequenceStats(
        advancedStateMetrics(state, color),
        after,
        color,
      ));
    }
    return {
      features,
      experience: experienceDescriptor(state, color, features),
    };
  }

  return {
    plan,
    rank,
    describeSequence,
    evaluateState(state, color, weights = defaultWeights) {
      return evaluateState(state, color, mergeWeights(weights));
    },
    scoreSequence(state, sequence, color = state.turn, weights = defaultWeights) {
      const after = adapter.applySequence(state, sequence, color);
      return scoreSequence(state, after, color, sequence, mergeWeights(weights));
    },
    setExperience(patterns = [], source = 'runtime') {
      experienceSources.set(String(source || 'runtime'), Array.isArray(patterns) ? patterns : []);
      selectedExperiencePatterns = selectExperiencePatterns(experienceSources);
      experience = normalizeExperiencePatterns(selectedExperiencePatterns);
      return experience.size;
    },
    experienceSize() {
      return experience.size;
    },
    experienceSnapshotEntries() {
      return Array.from(experience.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, pattern]) => [
          key,
          Number(pattern.samples) || 0,
          Number(pattern.losses) || 0,
          Number(pattern.wins) || 0,
          Number(pattern.lossWeight) || 0,
          Number(pattern.severeLosses) || 0,
          Number(pattern.signalWeight) || 0,
          Number(pattern.winWeight) || 0,
        ]);
    },
    experienceSnapshotPatterns() {
      return selectedExperiencePatterns.map(pattern => ({ ...pattern }));
    },
  };
}

function selectExperiencePatterns(sources) {
  const selected = new Map();
  sources.forEach((patterns, rawSource) => {
    const source = String(rawSource || 'runtime');
    const priority = experienceSourcePriority(source);
    (Array.isArray(patterns) ? patterns : []).forEach((pattern) => {
      const contextKey = String(pattern?.contextKey || pattern?.context_key || '');
      const actionKey = String(pattern?.actionKey || pattern?.action_key || '');
      if (!contextKey || !actionKey) return;
      const key = `${contextKey}::${actionKey}`;
      const current = selected.get(key);
      if (
        shouldReplaceExperiencePattern(current, { pattern, priority, source })
      ) {
        selected.set(key, { priority, source, patterns: [pattern] });
        return;
      }
      if (source === current.source) current.patterns.push(pattern);
    });
  });
  return Array.from(selected.values()).flatMap(entry => entry.patterns);
}

function shouldReplaceExperiencePattern(current, candidate) {
  if (!current) return true;
  const serverAndLocal = new Set([current.source, candidate.source]);
  if (
    serverAndLocal.size === 2
    && serverAndLocal.has('local')
    && (serverAndLocal.has('server') || serverAndLocal.has('server-cache'))
  ) {
    const currentTimestamp = Math.max(
      0,
      ...current.patterns.map(experiencePatternTimestamp),
    );
    const candidateTimestamp = experiencePatternTimestamp(candidate.pattern);
    if (currentTimestamp !== candidateTimestamp && (currentTimestamp || candidateTimestamp)) {
      return candidateTimestamp > currentTimestamp;
    }
  }
  return candidate.priority > current.priority
    || (candidate.priority === current.priority && candidate.source < current.source);
}

function experiencePatternTimestamp(pattern) {
  const timestamp = Date.parse(String(pattern?.updatedAt || pattern?.updated_at || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function experienceSourcePriority(source) {
  if (source === 'frozen-session') return 50;
  if (source === 'server') return 40;
  if (source === 'server-cache') return 30;
  if (source === 'local') return 20;
  return 10;
}

function tacticalCoveragePool(eligible, ranked) {
  const pool = [];
  const included = new Set();
  eligible.forEach((candidate) => {
    if (!candidate || included.has(candidate)) return;
    included.add(candidate);
    pool.push(candidate);
  });
  // A policy singleton may still receive a reference candidate, but references
  // must never displace eligible moves from the tactical/deep beam.
  ranked.forEach((candidate) => {
    if (pool.length >= 2 || !candidate || included.has(candidate)) return;
    included.add(candidate);
    pool.push(candidate);
  });
  return pool;
}

function normalizeAnalysisNodeBudget(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(number));
}

// A four-point lock is not a safe-race move merely because its checkers move
// forward. Conversely, keeping it must not suppress a verified static escape
// from our own rear exposure or a timing crunch. This grants score eligibility
// only; the ordinary bounded reply/deep safety checks still decide the move.
function isFourPrimeSelfEscape(features) {
  const required = [
    'primeRunBefore', 'primeRunAfter', 'outsidePipGain', 'homeShuffleMoves',
    'trapDelta', 'fenceClosureDelta', 'escapeGatewayDelta',
    'latentFenceExposureBefore', 'latentFenceExposureDelta',
    'prospectiveFenceExtensionBefore', 'prospectiveFenceExtensionDelta',
    'headLandingBreak', 'routeTowerDelta', 'startZoneReduction',
    'resultSafetyBefore', 'resultSafetyAfter', 'primeSustainabilityBefore',
    'primeSustainabilityDelta', 'primeCrunchRiskBefore', 'primeCrunchRiskDelta',
    'laggardDebtDelta',
  ];
  if (!features || !required.every(key => Number.isFinite(features[key]))) return false;
  if (
    features.primeRunBefore !== 4
    || !Number.isInteger(features.primeRunAfter)
    || features.primeRunAfter < 2
    || features.primeRunAfter > 4
    || features.outsidePipGain <= 0
    || features.homeShuffleMoves !== 0
    || features.trapDelta < 0
    || features.fenceClosureDelta < 0
    || features.escapeGatewayDelta < 0
    || features.latentFenceExposureDelta < 0
    || features.prospectiveFenceExtensionDelta < 0
    || features.headLandingBreak !== 0
    || features.routeTowerDelta < 0
    || features.resultSafetyAfter < features.resultSafetyBefore
  ) return false;

  const clearsExposedRear = features.primeRunAfter >= 3
    && features.latentFenceExposureBefore >= 24
    && features.latentFenceExposureDelta > 0
    && features.startZoneReduction > 0
    && features.resultSafetyAfter > features.resultSafetyBefore;
  // These timing thresholds are shared with prime-sustainability coverage,
  // rather than treating every lost blocker as an excuse to abandon a lock.
  const relievesSelfCrunch = features.primeSustainabilityBefore < 0.38
    && features.primeCrunchRiskBefore >= 0.45
    && features.primeSustainabilityDelta >= 0.06
    && features.primeCrunchRiskDelta >= 0.2
    && features.prospectiveFenceExtensionBefore >= 40
    && features.prospectiveFenceExtensionDelta >= 40
    && features.laggardDebtDelta > 0;
  return clearsExposedRear || relievesSelfCrunch;
}

function advancedStrategyAdjustment(state, color, features) {
  const opponent = opponentOf(color);
  const raceDebt = pipsFor(state, color) - pipsFor(state, opponent);
  const opponentHead = headCheckers(state, opponent);
  const ownHead = headCheckers(state, color);
  const attackPressure = Math.min(3.4, 1
    + Math.max(-0.2, Math.min(1.2, raceDebt / 70))
    + Math.max(0, opponentHead - 3) / 8
    + Math.max(0, ownHead - 5) / 14);
  const primeGain = Number(features.primeScoreGain) || 0;
  const blockGain = Number(features.opponentMoveBlockGain) || 0;
  const primeRunBefore = Number(features.primeRunBefore) || 0;
  const primeRunAfter = Number(features.primeRunAfter) || 0;
  const effectivePrimeRunBefore = Math.min(6, primeRunBefore);
  const effectivePrimeRunAfter = Math.min(6, primeRunAfter);
  const runPowerGain = Math.pow(effectivePrimeRunAfter, 4)
    - Math.pow(effectivePrimeRunBefore, 4);
  const trapBefore = Math.max(0, Number(features.trapBefore) || 0);
  const opponentFenceRun = Math.max(0, Number(features.opponentFenceRunBefore) || 0);
  const maxRouteTowerAfter = Math.max(0, Number(features.maxRouteTowerAfter) || 0);
  const routeTowerDelta = Number(features.routeTowerDelta) || 0;
  const laggardDebtDelta = Math.max(0, Number(features.laggardDebtDelta) || 0);
  const outside = outsideHomeCount(state, color);
  const outsidePipGain = Math.max(0, Number(features.outsidePipGain) || 0);
  const homeShuffleMoves = Math.max(0, Number(features.homeShuffleMoves) || 0);
  const primeScoreBefore = Math.max(0, Number(features.primeScoreBefore) || 0);
  const primeScoreAfter = Math.max(0, Number(features.primeScoreAfter) || 0);
  const lateRouteRace = ownHead === 0
    && opponentHead === 0
    && outside > 0
    && outside <= 6
    && (
      effectivePrimeRunBefore >= 4
      || (
        effectivePrimeRunBefore === 3
        && trapBefore === 0
        && opponentFenceRun >= 2
      )
    );
  const activeLockBreak = effectivePrimeRunBefore >= 4
    && primeScoreBefore > 0
    && (
      effectivePrimeRunAfter < effectivePrimeRunBefore
      || primeScoreAfter < primeScoreBefore
      || blockGain < 0
    )
    && !(effectivePrimeRunBefore === 4 && isFourPrimeSelfEscape(features));
  const safeLateRouteAdvance = lateRouteRace
    && outsidePipGain > 0
    && !activeLockBreak;
  const clearedHeadLaggardEscape = (ownHead === 0
    && opponentHead === 0
    && effectivePrimeRunBefore >= 5
    && trapBefore >= 240
    && laggardDebtDelta >= 120)
    || safeLateRouteAdvance;
  const primePreservationScale = clearedHeadLaggardEscape ? 0.04 : 1;
  const safetyCompatible = trapBefore < 240 || (
    Number(features.trapDelta || 0) >= 0
    && Number(features.fenceClosureDelta || 0) >= 0
    && Number(features.escapeGatewayDelta || 0) >= 0
  );
  const establishedPrime = primeRunAfter >= 4 || primeRunBefore >= 4;
  const primeSustainabilityAfter = Math.max(
    0,
    Math.min(1, Number(features.primeSustainabilityAfter) || 0),
  );
  const primeCrunchRiskAfter = Math.max(0, Number(features.primeCrunchRiskAfter) || 0);
  const sustainabilityScale = primeRunAfter >= 4
    ? 0.16 + primeSustainabilityAfter * 0.84
    : 1;
  const constructivePressure = attackPressure
    * (establishedPrime ? 1 : 0.18)
    * (safetyCompatible ? 1 : 0.12)
    * sustainabilityScale;
  const preservationPressure = attackPressure
    * Math.max(0.55, 1 / (1 + trapBefore / 1800));
  let score = 0;

  score += primeGain * (primeGain >= 0
    ? 42000 * constructivePressure
    : 90000 * preservationPressure * primePreservationScale);
  score += blockGain * (blockGain >= 0
    ? 360000 * constructivePressure
    : 620000 * preservationPressure * primePreservationScale);
  score += runPowerGain * 260000
    * (runPowerGain >= 0
      ? constructivePressure
      : preservationPressure * primePreservationScale);
  if (
    effectivePrimeRunBefore >= 4
    && effectivePrimeRunAfter < effectivePrimeRunBefore
  ) {
    score -= (effectivePrimeRunBefore - effectivePrimeRunAfter)
      * (24000000 + opponentHead * 2600000)
      * preservationPressure
      * primePreservationScale;
  }
  if (
    safetyCompatible
    && effectivePrimeRunBefore < 6
    && effectivePrimeRunAfter >= 6
    && Number(features.primeScoreAfter || 0) > 0
  ) {
    score += 180000000 * constructivePressure;
  } else if (
    effectivePrimeRunAfter === 5
    && effectivePrimeRunAfter > effectivePrimeRunBefore
  ) {
    score += 52000000 * constructivePressure;
  }
  if (
    opponentHead >= 5
    && Number(features.homeEntryMoves || 0) > 0
    && (
      effectivePrimeRunAfter < 4
      || (primeGain <= 0 && blockGain <= 0)
    )
  ) {
    score -= Number(features.homeEntryMoves)
      * (9000000 + opponentHead * 1800000);
  }
  if (
    maxRouteTowerAfter >= 6
    && routeTowerDelta < 0
    && primeGain <= 0
  ) {
    score -= Math.pow(maxRouteTowerAfter - 5, 2) * 18000000;
  }
  if (
    maxRouteTowerAfter >= 5
    && routeTowerDelta < 0
    && ownHead > 0
    && opponentFenceRun >= 2
    && primeGain <= 0
  ) {
    const latentTrapPressure = 18000000
      + ownHead * 2000000
      + opponentFenceRun * 10000000
      + Math.min(20000000, trapBefore * 12000);
    score -= Math.pow(maxRouteTowerAfter - 4, 2) * latentTrapPressure;
  }
  if (lateRouteRace && !activeLockBreak) {
    score += outsidePipGain * 4000000;
    score -= homeShuffleMoves * 8000000;
  }
  if (establishedPrime) {
    score += Number(features.primeSustainabilityDelta || 0) * 28000000;
    score += Number(features.primeCrunchRiskDelta || 0) * 18000000;
    score -= primeCrunchRiskAfter * 12000000;
  }
  return score;
}

function advancedStateMetrics(state, color) {
  return {
    primeScore: blockingPrimeScore(state, color),
    primeRun: blockingPrimeRun(state, color),
    opponentMoveBlock: opponentMoveBlockScore(state, color),
    latentFenceExposure: latentFenceExposure(state, color),
    prospectiveFenceExtension: prospectiveFenceExtensionRisk(state, color),
    primeSustainability: primeSustainability(state, color),
    primeCrunchRisk: primeCrunchRisk(state, color),
  };
}

function advancedSequenceStats(beforeMetrics, after, color) {
  const primeScoreAfter = blockingPrimeScore(after, color);
  const opponentMoveBlockAfter = opponentMoveBlockScore(after, color);
  const latentFenceExposureAfter = latentFenceExposure(after, color);
  const prospectiveFenceExtensionAfter = prospectiveFenceExtensionRisk(after, color);
  const primeSustainabilityAfter = primeSustainability(after, color);
  const primeCrunchRiskAfter = primeCrunchRisk(after, color);
  return {
    primeScoreBefore: beforeMetrics.primeScore,
    primeScoreAfter,
    primeScoreGain: primeScoreAfter - beforeMetrics.primeScore,
    primeRunBefore: beforeMetrics.primeRun,
    primeRunAfter: blockingPrimeRun(after, color),
    opponentMoveBlockBefore: beforeMetrics.opponentMoveBlock,
    opponentMoveBlockAfter,
    opponentMoveBlockGain: opponentMoveBlockAfter - beforeMetrics.opponentMoveBlock,
    latentFenceExposureBefore: beforeMetrics.latentFenceExposure,
    latentFenceExposureAfter,
    latentFenceExposureDelta: beforeMetrics.latentFenceExposure - latentFenceExposureAfter,
    prospectiveFenceExtensionBefore: beforeMetrics.prospectiveFenceExtension,
    prospectiveFenceExtensionAfter,
    prospectiveFenceExtensionDelta: beforeMetrics.prospectiveFenceExtension
      - prospectiveFenceExtensionAfter,
    primeSustainabilityBefore: beforeMetrics.primeSustainability,
    primeSustainabilityAfter,
    primeSustainabilityDelta: primeSustainabilityAfter - beforeMetrics.primeSustainability,
    primeCrunchRiskBefore: beforeMetrics.primeCrunchRisk,
    primeCrunchRiskAfter,
    primeCrunchRiskDelta: beforeMetrics.primeCrunchRisk - primeCrunchRiskAfter,
  };
}

function advancedTacticalAdjustment(state, color, candidate) {
  const tactical = candidate.tactical;
  if (!tactical) return 0;
  const opponent = opponentOf(color);
  const opponentHead = headCheckers(state, opponent);
  const opponentOutside = outsideHomeCount(state, opponent);
  const raceDebt = pipsFor(state, color) - pipsFor(state, opponent);
  const pressure = Math.min(3, 1
    + Math.max(0, raceDebt) / 90
    + Math.max(0, opponentHead - 3) / 10);
  const primeRunAfter = Math.max(0, Number(candidate.features?.primeRunAfter) || 0);
  const primeSustainabilityAfter = Math.max(
    0,
    Math.min(1, Number(candidate.features?.primeSustainabilityAfter) || 0),
  );
  const primeCrunchRiskAfter = Math.max(
    0,
    Number(candidate.features?.primeCrunchRiskAfter) || 0,
  );
  const blockingValueScale = primeRunAfter >= 4
    ? 0.14 + primeSustainabilityAfter * 0.86
    : 1;
  let score = 0;
  score += (Number(tactical.blockedProbability) || 0)
    * 95000000
    * pressure
    * blockingValueScale;
  score -= (Number(tactical.expectedOpponentPipGain) || 0) * 520000 * pressure;
  score -= (Number(tactical.expectedOpponentHeadRelease) || 0)
    * (16000000 + opponentHead * 2400000)
    * pressure;
  score -= (Number(tactical.expectedOpponentOutsideReduction) || 0)
    * (7000000 + Math.max(0, 8 - opponentOutside) * 1800000);
  score -= Math.log1p(Number(tactical.expectedReplySequences) || 0) * 1800000 * pressure;
  if (primeRunAfter >= 4) score -= primeCrunchRiskAfter * 22000000 * pressure;
  return score;
}

function prioritizeSevereReplySafety(state, color, ranked) {
  const selected = ranked[0];
  if (!selected?.tactical || ranked.length < 2 || homeReady(state, color)) return ranked;
  const selectedDescriptor = experienceDescriptor(
    state,
    color,
    selected.features,
    selected.tactical,
  );

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && candidate.tactical
    && Number(candidate.features.headGain || 0) >= Number(selected.features.headGain || 0)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0)
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && Number(experienceDescriptor(
      state,
      color,
      candidate.features,
      candidate.tactical,
    ).riskSignal || 0) <= Number(selectedDescriptor.riskSignal || 0) - 2
    && Number(experienceDescriptor(
      state,
      color,
      candidate.features,
      candidate.tactical,
    ).mistakeSeverity || 0) <= Number(selectedDescriptor.mistakeSeverity || 0) - 1.5
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) - 5000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) + 30000000
    && (
      Number(candidate.tactical.continuationWorst || 0)
        >= Number(selected.tactical.continuationWorst || 0) - 15000000
      || (
        Math.min(
          Number(candidate.tactical.worstImpact || 0),
          Number(candidate.tactical.recoveryWorst || 0),
          Number(candidate.tactical.continuationWorst || 0),
        ) >= Math.min(
          Number(selected.tactical.worstImpact || 0),
          Number(selected.tactical.recoveryWorst || 0),
          Number(selected.tactical.continuationWorst || 0),
        ) + 30000000
        && Number(candidate.tactical.continuationTailRisk || 0)
          >= Number(selected.tactical.continuationTailRisk || 0) - 30000000
      )
    )
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.tactical.worstImpact || 0) - Number(left.tactical.worstImpact || 0)
    || Number(right.tactical.expectedImpact || 0) - Number(left.tactical.expectedImpact || 0)
    || Number(experienceDescriptor(
      state,
      color,
      left.features,
      left.tactical,
    ).riskSignal || 0) - Number(experienceDescriptor(
      state,
      color,
      right.features,
      right.tactical,
    ).riskSignal || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'severeReplySafetyAdjustment');
}

function prioritizeCriticalClearedHeadLaggardEscape(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected?.tactical
    || homeReady(state, color)
    || headCheckers(state, color) > 0
    || headCheckers(state, opponentOf(color)) > 0
    || Number(selected.features.trapBefore || 0) < 240
    || Number(selected.features.primeRunBefore || 0) < 5
  ) {
    return ranked;
  }

  const selectedDebt = Number(selected.features.laggardDebtDelta || 0);
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && candidate.tactical
    && Number(candidate.tactical.plies || 0) >= 4
    && Number(candidate.features.laggardDebtDelta || 0) >= Math.max(120, selectedDebt + 120)
    && Number(candidate.features.startZoneReduction || 0)
      > Number(selected.features.startZoneReduction || 0)
    && Number(candidate.features.outsidePipGain || 0)
      > Number(selected.features.outsidePipGain || 0)
    && Number(candidate.features.homeEntryMoves || 0)
      <= Number(selected.features.homeEntryMoves || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && Number(candidate.features.primeRunAfter || 0) >= 3
    && scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 12000000
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) - 2000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) + 8000000
    && Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.continuationTailRisk || 0)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.features.laggardDebtDelta || 0)
      - Number(left.features.laggardDebtDelta || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
    || Number(right.tactical.worstImpact || 0)
      - Number(left.tactical.worstImpact || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(
    ranked,
    alternatives[0],
    'criticalLaggardEscapeAdjustment',
  );
}

function prioritizeTacticallyDominantHomeProgress(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected?.tactical
    || homeReady(state, color)
    || headCheckers(state, color) > 0
    || Number(selected.features.homeShuffleMoves || 0) <= 0
  ) {
    return ranked;
  }

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && candidate.tactical
    && Number(candidate.features.outsideReduction || 0)
      > Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0)
    // Entering a checker can reduce the generic gateway metric even when all
    // analyzed reply branches improve, so tactical dominance is the gate here.
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0)
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0)
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0)
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0)
    && Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.continuationTailRisk || 0)
    && Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.continuationWorst || 0)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.features.outsideReduction || 0)
      - Number(left.features.outsideReduction || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
    || Number(right.tactical.continuationWorst || 0)
      - Number(left.tactical.continuationWorst || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'tacticalHomeProgressAdjustment');
}

function prioritizeTransitionBearOff(state, color, ranked) {
  if (homeReady(state, color) || outsideHomeCount(state, color) !== 1) return ranked;
  const maxEntry = Math.max(...ranked.map(
    candidate => Number(candidate.features.outsideReduction) || 0,
  ));
  if (maxEntry <= 0) return ranked;
  const entering = ranked.filter(
    candidate => Number(candidate.features.outsideReduction || 0) === maxEntry,
  );
  const maxOff = Math.max(...entering.map(candidate => Number(candidate.features.offGain) || 0));
  if (maxOff <= 0) return ranked;
  const finishing = entering.filter(candidate => (
    Number(candidate.features.offGain || 0) === maxOff
    && Number(candidate.features.homeShuffleMoves || 0) === 0
    && isSafeTransitionBearOffAlternative(state, color, candidate, ranked[0])
  ));
  if (!finishing.length) return ranked;
  finishing.sort((left, right) => Number(right.score) - Number(left.score));
  return promoteCandidate(ranked, finishing[0], 'transitionBearOffAdjustment');
}

function isSafeTransitionBearOffAlternative(state, color, candidate, selected) {
  if (candidate === selected) return true;
  if (!candidate?.tactical || !selected?.tactical) return false;
  const uncontested = isUncontestedLateRaceState(state, color, selected.features);
  const structuralTolerance = uncontested ? 0 : 2;
  const gatewayTolerance = uncontested ? 0 : 3;
  const preservesStructure = Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0) - structuralTolerance
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0) - structuralTolerance
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0) - gatewayTolerance
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0) - structuralTolerance
    && Number(candidate.features.prospectiveFenceExtensionDelta || 0)
      >= Number(selected.features.prospectiveFenceExtensionDelta || 0)
    && (
      !uncontested
      || Number(candidate.features.prospectiveFenceInterruptionBreak || 0)
        <= Number(selected.features.prospectiveFenceInterruptionBreak || 0)
    )
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.primeScoreAfter || 0)
      >= Number(selected.features.primeScoreAfter || 0)
    && Number(candidate.features.opponentMoveBlockAfter || 0)
      >= Number(selected.features.opponentMoveBlockAfter || 0)
    && Number(candidate.features.routeTowerAfter || 0)
      <= Number(selected.features.routeTowerAfter || 0)
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0);
  if (!preservesStructure) return false;

  const continuationIsComparable = uncontested
    || Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.continuationWorst || 0) - 8000000;
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 8000000
    && Number(candidate.experienceAdjustment || 0)
      >= Number(selected.experienceAdjustment || 0) - 500000
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) - 8000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) - 15000000
    && continuationIsComparable;
}

function criticalFenceGatewayPoints(state, color) {
  const path = pathFor(color);
  const opponent = opponentOf(color);
  const gateways = new Set();
  for (let start = 1; start <= path.length - 6; start += 1) {
    if (!path.slice(0, start).some(point => colorAt(state, point) === color)) continue;
    const window = path.slice(start, start + 6);
    const ownPoints = window.filter(point => colorAt(state, point) === color);
    const opponentPoints = window.filter(point => colorAt(state, point) === opponent);
    if (ownPoints.length === 1 && opponentPoints.length === 5) gateways.add(ownPoints[0]);
  }
  return [...gateways];
}

function prioritizeAvailableHomeEntry(state, color, ranked) {
  const selected = ranked[0];
  if (!hasHomeEntryPriorityContext(state, color, selected)) return ranked;

  const selectedEntry = Number(selected.features.outsideReduction) || 0;
  const entering = ranked.filter(candidate => (
    Number(candidate.features.outsideReduction) > selectedEntry
    && isSafeHomeEntryAlternative(state, color, candidate, selected)
  ));
  if (!entering.length) return ranked;

  // With a clear head and no severe trap, shuffling inside the home board only
  // delays home readiness when the same roll can bring another checker home.
  const maxEntry = Math.max(...entering.map(
    candidate => Number(candidate.features.outsideReduction) || 0,
  ));
  const promoted = entering.filter(
    candidate => Number(candidate.features.outsideReduction) === maxEntry,
  );
  const promotedSet = new Set(promoted);
  promoted.forEach((candidate) => {
    const adjustment = Math.max(0, Number(selected.score) - Number(candidate.score) + 1);
    candidate.features.homeEntryPriorityAdjustment = adjustment;
    candidate.features.policyPromotionAdjustment = (
      Number(candidate.features.policyPromotionAdjustment || 0) + adjustment
    );
    candidate.score += adjustment;
  });
  return [...promoted, ...ranked.filter(candidate => !promotedSet.has(candidate))];
}

function prioritizeRouteContinuity(state, color, ranked) {
  const selected = ranked[0];
  if (!hasRouteContinuityPriorityContext(state, color, selected)) return ranked;

  const selectedEntry = Number(selected.features.outsideReduction) || 0;
  const selectedProgress = Number(selected.features.outsidePipGain) || 0;
  const selectedDebt = Number(selected.features.laggardDebtDelta) || 0;
  const continuing = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.outsideReduction || 0) >= selectedEntry
    && Number(candidate.features.outsidePipGain || 0) > selectedProgress
    && (
      Number(candidate.features.laggardDebtDelta || 0) >= selectedDebt
      || Number(candidate.features.startZoneReduction || 0)
        > Number(selected.features.startZoneReduction || 0)
    )
    && isSafeRouteContinuityAlternative(candidate, selected)
  ));
  if (!continuing.length) return ranked;

  continuing.sort((left, right) => (
    Number(right.features.outsideReduction || 0) - Number(left.features.outsideReduction || 0)
    || Number(right.features.outsidePipGain || 0) - Number(left.features.outsidePipGain || 0)
    || Number(right.features.laggardDebtDelta || 0) - Number(left.features.laggardDebtDelta || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, continuing[0], 'routeContinuityAdjustment');
}

function prioritizeSafeEarlyDevelopment(state, color, ranked) {
  const selected = ranked[0];
  const headRemaining = headCheckers(state, color);
  if (
    !selected
    || homeReady(state, color)
    || headRemaining < 4
    || opponentTrapRisk(state, color) >= 120
    || Number(selected.features.homeEntryMoves || 0) <= 0
  ) {
    return ranked;
  }

  const selectedHeadGain = Number(selected.features.headGain) || 0;
  const selectedProgress = Number(selected.features.outsidePipGain) || 0;
  const selectedEntry = Number(selected.features.homeEntryMoves) || 0;
  const selectedTower = Number(selected.features.maxRouteTowerAfter) || 0;
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.headGain || 0) >= selectedHeadGain
    && Number(candidate.features.homeEntryMoves || 0) < selectedEntry
    && Number(candidate.features.outsidePipGain || 0) >= selectedProgress
    && Number(candidate.features.maxRouteTowerAfter || 0) < selectedTower
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && isSaferEarlyAlternative(candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(left.features.homeEntryMoves || 0) - Number(right.features.homeEntryMoves || 0)
    || Number(left.features.maxRouteTowerAfter || 0) - Number(right.features.maxRouteTowerAfter || 0)
    || Number(right.tactical.worstImpact) - Number(left.tactical.worstImpact)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'earlyDevelopmentAdjustment');
}

function isSaferEarlyAlternative(candidate, selected) {
  if (!candidate.tactical || !selected.tactical) return false;
  const completeTacticalDominance = Number(candidate.tactical.plies || 0) >= 4
    && Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0)
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0)
    && Number(candidate.tactical.recoveryTailRisk || 0)
      + Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.recoveryTailRisk || 0)
        + Number(selected.tactical.continuationTailRisk || 0)
    && Number(candidate.tactical.recoveryWorst || 0)
      + Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.recoveryWorst || 0)
        + Number(selected.tactical.continuationWorst || 0);
  return (
    scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 25000000
    || completeTacticalDominance
  )
    && Number(candidate.experienceAdjustment || 0) >= (
      Number(selected.experienceAdjustment || 0) - 500000
    )
    && Number(candidate.features.trapDelta || 0) >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0) >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0) >= Number(selected.features.escapeGatewayDelta || 0)
    && Number(candidate.tactical.expectedImpact) >= Number(selected.tactical.expectedImpact)
    && Number(candidate.tactical.worstImpact) >= Number(selected.tactical.worstImpact);
}

function prioritizePreHomeDevelopment(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected
    || homeReady(state, color)
    || headCheckers(state, color) <= 0
    || opponentTrapRisk(state, color) >= 120
    || Number(selected.features.homeShuffleMoves || 0) <= 0
  ) {
    return ranked;
  }

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.headGain || 0) >= Number(selected.features.headGain || 0)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.outsidePipGain || 0)
      > Number(selected.features.outsidePipGain || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && isComparablePreHomeAlternative(candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(left.features.homeShuffleMoves || 0) - Number(right.features.homeShuffleMoves || 0)
    || Number(right.features.outsidePipGain || 0) - Number(left.features.outsidePipGain || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'preHomeDevelopmentAdjustment');
}

function isComparablePreHomeAlternative(candidate, selected) {
  if (!candidate.tactical || !selected.tactical) return false;
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 12000000
    && Number(candidate.experienceAdjustment || 0) >= (
      Number(selected.experienceAdjustment || 0) - 500000
    )
    && Number(candidate.features.trapDelta || 0) >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0) >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0) >= (
      Number(selected.features.escapeGatewayDelta || 0) - 3
    )
    && Number(candidate.tactical.expectedImpact) >= (
      Number(selected.tactical.expectedImpact) - 3000000
    )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - 7000000
    );
}

function prioritizeRouteDistribution(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected
    || homeReady(state, color)
    || headCheckers(state, color) > 0
    || outsideHomeCount(state, color) > 9
    || opponentTrapRisk(state, color) >= 120
  ) {
    return ranked;
  }

  const selectedTower = Number(selected.features.maxRouteTowerAfter) || 0;
  if (selectedTower < 6) return ranked;
  const selectedEntry = Number(selected.features.outsideReduction) || 0;
  const selectedProgress = Number(selected.features.outsidePipGain) || 0;
  const alternatives = ranked.filter(candidate => {
    if (candidate === selected) return false;
    const candidateEntry = Number(candidate.features.outsideReduction) || 0;
    const candidateProgress = Number(candidate.features.outsidePipGain) || 0;
    const keepsRouteTempo = selectedTower >= 7
      ? candidateEntry >= selectedEntry - 1 && candidateProgress >= selectedProgress
      : candidateEntry >= selectedEntry && candidateProgress >= selectedProgress;
    return keepsRouteTempo
      && Number(candidate.features.maxRouteTowerAfter || 0) < selectedTower
      && isSafeRouteAlternative(candidate, selected, 4000000, 750000, 250000);
  });
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(left.features.maxRouteTowerAfter || 0) - Number(right.features.maxRouteTowerAfter || 0)
    || Number(right.features.outsideReduction || 0) - Number(left.features.outsideReduction || 0)
    || Number(right.features.outsidePipGain || 0) - Number(left.features.outsidePipGain || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'routeDistributionAdjustment');
}

function prioritizeLatentTrapDistribution(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected
    || homeReady(state, color)
    || headCheckers(state, color) < 4
    || Number(selected.features.opponentFenceRunBefore || 0) < 3
    || Number(selected.features.trapBefore || 0) < 120
    || Number(selected.features.maxRouteTowerAfter || 0) < 5
    || Number(selected.features.primeScoreGain || 0) > 0
    || Number(selected.features.opponentMoveBlockGain || 0) > 0
  ) {
    return ranked;
  }

  const selectedTower = Number(selected.features.maxRouteTowerAfter) || 0;
  const selectedDistribution = Number(selected.features.distributionDelta) || 0;
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && candidate.tactical
    && selected.tactical
    && scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 240000000
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) - 30000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) - 65000000
    && Number(candidate.features.maxRouteTowerAfter || 0) < selectedTower
    && Number(candidate.features.distributionDelta || 0) > selectedDistribution
    && Number(candidate.features.headGain || 0) >= Number(selected.features.headGain || 0)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.outsidePipGain || 0)
      >= Number(selected.features.outsidePipGain || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.outsideDevelopmentMoves || 0)
      >= Number(selected.features.outsideDevelopmentMoves || 0)
    && Number(candidate.features.headLandingBreak || 0)
      <= Number(selected.features.headLandingBreak || 0) + 24
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0) - 10
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0) - 40
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(left.features.maxRouteTowerAfter || 0)
      - Number(right.features.maxRouteTowerAfter || 0)
    || Number(right.features.distributionDelta || 0)
      - Number(left.features.distributionDelta || 0)
    || Number(right.tactical?.worstImpact || 0)
      - Number(left.tactical?.worstImpact || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'latentTrapDistributionAdjustment');
}

function isSafeRouteAlternative(
  candidate,
  selected,
  scoreTolerance,
  expectedReplyTolerance,
  worstReplyTolerance,
) {
  if (!candidate.tactical || !selected.tactical) return false;
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - scoreTolerance
    && Number(candidate.experienceAdjustment || 0) >= (
      Number(selected.experienceAdjustment || 0) - 500000
    )
    && Number(candidate.features.trapDelta || 0) >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0) >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0) >= Number(selected.features.escapeGatewayDelta || 0)
    && Number(candidate.tactical.expectedImpact) >= (
      Number(selected.tactical.expectedImpact) - expectedReplyTolerance
    )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - worstReplyTolerance
    );
}

function promoteCandidate(ranked, promoted, adjustmentKey) {
  const selected = ranked[0];
  const adjustment = Math.max(0, Number(selected.score) - Number(promoted.score) + 1);
  promoted.features[adjustmentKey] = adjustment;
  promoted.features.policyPromotionAdjustment = (
    Number(promoted.features.policyPromotionAdjustment || 0) + adjustment
  );
  promoted.score += adjustment;
  return [promoted, ...ranked.filter(candidate => candidate !== promoted)];
}

function isSafeHomeEntryAlternative(state, color, candidate, selected) {
  if (
    !isPlausibleHomeEntryAlternative(state, color, candidate, selected)
    || !candidate.tactical
    || !selected.tactical
  ) {
    return false;
  }
  const replyTolerance = (
    isForcedLateHomeEntryContext(state, color, selected)
    || isDirectLateHomeEntryReplacement(state, color, candidate, selected)
  )
    ? 8000000
    : 250000;
  const replyEnvelope = Number(candidate.tactical.expectedImpact) >= (
    Number(selected.tactical.expectedImpact) - replyTolerance
  )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - replyTolerance
    );
  if (!replyEnvelope) return false;

  const needsLateRaceProof = isUncontestedPreHomeStaging(state, color, selected)
    || isUncontestedLateRaceState(state, color, selected.features);
  if (!needsLateRaceProof) return true;
  if (!hasBoundedFourPlyTactical(candidate) || !hasBoundedFourPlyTactical(selected)) {
    return false;
  }

  // Entering a checker may make the immediate recovery estimate slightly
  // worse, but a clear-race override must remain corroborated by every deep
  // distribution.
  return Number(candidate.tactical.recoveryExpected || 0)
      >= Number(selected.tactical.recoveryExpected || 0) - 10000000
    && Number(candidate.tactical.recoveryWorst || 0)
      >= Number(selected.tactical.recoveryWorst || 0) - 8000000
    && Number(candidate.tactical.recoveryTailRisk || 0)
      >= Number(selected.tactical.recoveryTailRisk || 0) - 10000000
    && Number(candidate.tactical.continuationExpected || 0)
      >= Number(selected.tactical.continuationExpected || 0) - 2000000
    && Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.continuationWorst || 0) - 2000000
    && Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.continuationTailRisk || 0) - 2000000;
}

function structuralIntegrityDeltas(candidate, selected) {
  const features = candidate?.features || {};
  const baseline = selected?.features || {};
  return {
    latentRelief: Number(features.latentFenceExposureDelta || 0)
      - Number(baseline.latentFenceExposureDelta || 0),
    prospectiveRelief: Number(features.prospectiveFenceExtensionDelta || 0)
      - Number(baseline.prospectiveFenceExtensionDelta || 0),
    interruptionRelief: Number(baseline.prospectiveFenceInterruptionBreak || 0)
      - Number(features.prospectiveFenceInterruptionBreak || 0),
    trapRelief: Number(features.trapDelta || 0) - Number(baseline.trapDelta || 0),
    fenceRelief: Number(features.fenceClosureDelta || 0)
      - Number(baseline.fenceClosureDelta || 0),
    gatewayRelief: Number(features.escapeGatewayDelta || 0)
      - Number(baseline.escapeGatewayDelta || 0),
    primeRunRelief: Number(features.primeRunAfter || 0)
      - Number(baseline.primeRunAfter || 0),
    primeScoreRelief: Number(features.primeScoreAfter || 0)
      - Number(baseline.primeScoreAfter || 0),
    blockRelief: Number(features.opponentMoveBlockAfter || 0)
      - Number(baseline.opponentMoveBlockAfter || 0),
  };
}

function structuralIntegrityProofType(candidate, selected) {
  if (!candidate || !selected || candidate === selected) return null;
  const features = candidate.features || {};
  const baseline = selected.features || {};
  const delta = structuralIntegrityDeltas(candidate, selected);
  const latentBefore = Number(baseline.latentFenceExposureBefore || 0);
  const selectedLatentAfter = Number(baseline.latentFenceExposureAfter || 0);
  const candidateLatentAfter = Number(features.latentFenceExposureAfter || 0);
  const selectedBreak = Number(baseline.prospectiveFenceInterruptionBreak || 0);
  const candidateBreak = Number(features.prospectiveFenceInterruptionBreak || 0);
  const selectedProspectiveAfter = Number(baseline.prospectiveFenceExtensionAfter || 0);
  const prospectiveBefore = Number(baseline.prospectiveFenceExtensionBefore || 0);
  const candidateProspectiveAfter = Number(features.prospectiveFenceExtensionAfter || 0);
  const opponentFenceRun = Number(baseline.opponentFenceRunBefore || 0);
  const primeRunBefore = Number(baseline.primeRunBefore || 0);
  const selectedRunAfter = Number(baseline.primeRunAfter || 0);
  const candidateRunAfter = Number(features.primeRunAfter || 0);

  const preventsNewLatentFence = opponentFenceRun >= 4
    && latentBefore >= 24
    && selectedLatentAfter >= latentBefore + 80
    && candidateLatentAfter <= latentBefore + 5
    && delta.latentRelief >= 80
    && delta.trapRelief >= 0
    && delta.gatewayRelief >= 0
    && delta.blockRelief >= 40
    && Number(features.resultSafetyAfter || 0)
      >= Number(baseline.resultSafetyAfter || 0);
  if (preventsNewLatentFence) return 'prevents-new-latent-fence';

  const escapesLatentFence = opponentFenceRun >= 4
    && latentBefore >= 24
    && selectedLatentAfter >= 24
    && candidateLatentAfter <= Math.max(5, selectedLatentAfter * 0.35)
    && delta.latentRelief >= 20
    && delta.trapRelief >= 0
    && delta.gatewayRelief >= -2;
  if (escapesLatentFence) return 'latent-fence-escape';

  const preservesFenceInterruption = opponentFenceRun >= 4
    && selectedBreak >= 60
    && candidateBreak <= Math.max(5, selectedBreak - 60)
    && candidateProspectiveAfter <= selectedProspectiveAfter - 40
    && delta.gatewayRelief >= 0;
  if (preservesFenceInterruption) return 'fence-interruption';

  const preservesActivePrime = primeRunBefore >= 5
    && selectedRunAfter <= primeRunBefore - 2
    && candidateRunAfter >= Math.max(4, primeRunBefore - 1)
    && prospectiveBefore >= 40
    && delta.blockRelief >= 40;
  if (preservesActivePrime) return 'active-prime';
  return null;
}

function structuralIntegrityUtility(candidate, selected) {
  const delta = structuralIntegrityDeltas(candidate, selected);
  return delta.latentRelief * 10
    + delta.prospectiveRelief * 5
    + delta.interruptionRelief * 8
    + delta.trapRelief * 6
    + delta.fenceRelief * 2
    + delta.gatewayRelief * 8
    + delta.primeRunRelief * 180
    + delta.primeScoreRelief * 0.7
    + delta.blockRelief * 2;
}

function structuralIntegrityReservationBaseline(state, color, ranked) {
  const outside = outsideHomeCount(state, color);
  const trapPressure = opponentTrapRisk(state, color);
  const maxEntry = Math.max(...ranked.map(
    candidate => Number(candidate.features.outsideReduction) || 0,
  ));
  const fenceRun = Math.max(...ranked.map(
    candidate => Number(candidate.features.opponentFenceRunBefore) || 0,
  ));
  const nonSevereTowerCandidates = fenceRun >= 5
    ? ranked.filter(candidate => Number(candidate.features.maxRouteTowerAfter) < 7)
    : [];
  const hasSevereTowerCandidate = ranked.some(
    candidate => Number(candidate.features.maxRouteTowerAfter) >= 7,
  );
  let eligible = hasSevereTowerCandidate && nonSevereTowerCandidates.length
    ? nonSevereTowerCandidates
    : trapPressure > 850 && outside <= 8 && maxEntry > 0 && fenceRun < 4
      ? ranked.filter(candidate => Number(candidate.features.outsideReduction) === maxEntry)
      : ranked;

  const maxHeadRelease = Math.max(...eligible.map(
    candidate => Number(candidate.features.headGain) || 0,
  ));
  const headReleaseIsCritical = maxHeadRelease > 0 && (
    headCheckers(state, color) <= 2
    || headCheckers(state, color) >= 7
    || trapPressure >= 600
    || fenceRun >= 4
    || offCount(state, opponentOf(color)) > 0
  );
  if (headReleaseIsCritical) {
    eligible = eligible.filter(
      candidate => Number(candidate.features.headGain || 0) === maxHeadRelease,
    );
  }
  if (fenceRun >= 5) {
    const gateways = criticalFenceGatewayPoints(state, color);
    if (gateways.length) {
      const preserving = eligible.filter(candidate => gateways.every(
        point => colorAt(candidate.after, point) === color,
      ));
      if (preserving.length) eligible = preserving;
    }
    const maxSafeEntry = Math.max(...eligible.map(
      candidate => Number(candidate.features.outsideReduction) || 0,
    ));
    if (maxSafeEntry > 0) {
      eligible = eligible.filter(
        candidate => Number(candidate.features.outsideReduction) === maxSafeEntry,
      );
    }
  }
  return eligible[0] || ranked[0];
}

function isPlausibleOrdinaryLastHeadPrimeDefense(state, color, candidate, selected) {
  const headRemaining = headCheckers(state, color);
  const features = candidate?.features;
  const baseline = selected?.features;
  if (
    !features
    || !baseline
    || headRemaining < 1
    || headRemaining > 2
    || offCount(state, opponentOf(color)) > 0
    || opponentTrapRisk(state, color) >= 600
  ) {
    return false;
  }
  const nativeMetrics = [
    'trapBefore', 'opponentFenceRunBefore', 'headGain', 'primeRunBefore',
    'primeRunAfter', 'opponentMoveBlockAfter', 'resultSafetyAfter',
    'maxRouteTowerAfter', 'headLandingBreak', 'prospectiveFenceInterruptionBreak',
    'trapDelta', 'fenceClosureDelta', 'escapeGatewayDelta', 'outsideReduction',
    'homeEntryMoves', 'outsidePipGain', 'startZoneReduction', 'homeShuffleMoves',
  ];
  if (!nativeMetrics.every(key => (
    Number.isFinite(features[key]) && Number.isFinite(baseline[key])
  ))) {
    return false;
  }
  // A normal final head checker is a development priority, not proof that a
  // real five-point blockade should be discarded without analyzing a defender.
  // These limits only buy one search slot. Emergency head/trap gates and every
  // final promotion / dynamic safety envelope are deliberately unchanged.
  return Math.max(features.trapBefore, baseline.trapBefore) < 600
    && Math.max(features.opponentFenceRunBefore, baseline.opponentFenceRunBefore) < 4
    && baseline.headGain > 0
    && features.headGain === baseline.headGain - 1
    && baseline.primeRunBefore >= 5
    && baseline.primeRunAfter <= baseline.primeRunBefore - 2
    && features.primeRunAfter >= baseline.primeRunBefore
    && features.opponentMoveBlockAfter >= baseline.opponentMoveBlockAfter + 40
    && features.resultSafetyAfter >= baseline.resultSafetyAfter
    && features.maxRouteTowerAfter <= baseline.maxRouteTowerAfter
    && features.headLandingBreak <= baseline.headLandingBreak
    && features.prospectiveFenceInterruptionBreak <= baseline.prospectiveFenceInterruptionBreak
    && features.trapDelta >= baseline.trapDelta
    && features.fenceClosureDelta >= baseline.fenceClosureDelta
    && features.escapeGatewayDelta >= baseline.escapeGatewayDelta - 1
    && features.outsideReduction >= baseline.outsideReduction
    && features.homeEntryMoves >= baseline.homeEntryMoves
    && features.outsidePipGain >= baseline.outsidePipGain
    && features.startZoneReduction >= baseline.startZoneReduction
    && features.homeShuffleMoves <= baseline.homeShuffleMoves;
}

function reserveStructuralIntegrityForTacticalAnalysis(
  state,
  color,
  ranked,
  limit = MAX_TACTICAL_CANDIDATES,
) {
  // This function is called both before and during tactical selection. A
  // reservation from the first pass must not survive when the second pass has
  // a different leader or a reduced candidate set.
  ranked.forEach((candidate) => {
    if (candidate?.features) {
      delete candidate.features.structuralIntegrityTacticalReservation;
    }
  });
  const selected = structuralIntegrityReservationBaseline(state, color, ranked);
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;
  const alternatives = ranked.filter((candidate) => {
    const proofType = structuralIntegrityProofType(candidate, selected);
    return proofType
      && (
        structuralProgressIsBounded(candidate, selected, proofType)
        || (
          proofType === 'active-prime'
          && isPlausibleOrdinaryLastHeadPrimeDefense(state, color, candidate, selected)
        )
      );
  });
  if (!alternatives.length) return ranked;
  alternatives.sort((left, right) => (
    structuralIntegrityUtility(right, selected)
      - structuralIntegrityUtility(left, selected)
    || scoreWithoutExperience(right) - scoreWithoutExperience(left)
    || (
      candidatePositionKey(left) < candidatePositionKey(right) ? -1
        : candidatePositionKey(left) > candidatePositionKey(right) ? 1 : 0
    )
  ));
  alternatives[0].features.structuralIntegrityTacticalReservation = 1;
  return reorderTacticalReservations(
    ranked,
    Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES),
  );
}

function reserveHomeEntryForTacticalAnalysis(
  state,
  color,
  ranked,
  limit = MAX_TACTICAL_CANDIDATES,
) {
  const selected = ranked[0];
  const slotCount = Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES);
  if (
    !hasHomeEntryPriorityContext(state, color, selected)
  ) {
    return ranked;
  }

  const selectedEntry = Number(selected.features.outsideReduction) || 0;
  const entering = ranked.filter(candidate => (
    Number(candidate.features.outsideReduction) > selectedEntry
    && isPlausibleHomeEntryAlternative(state, color, candidate, selected)
  ));
  if (!entering.length) return ranked;

  const maxEntry = Math.max(...entering.map(
    candidate => Number(candidate.features.outsideReduction) || 0,
  ));
  const reserved = entering.find(
    candidate => Number(candidate.features.outsideReduction) === maxEntry,
  );
  reserved.features.homeEntryTacticalReservation = 1;
  const reservedIndex = ranked.indexOf(reserved);
  if (reservedIndex < slotCount) return ranked;

  const leading = ranked.slice(0, slotCount - 1);
  const leadingSet = new Set(leading);
  return [
    ...leading,
    reserved,
    ...ranked.filter(candidate => candidate !== reserved && !leadingSet.has(candidate)),
  ];
}

function reserveRouteContinuityForTacticalAnalysis(
  state,
  color,
  ranked,
  limit = MAX_TACTICAL_CANDIDATES,
) {
  const selected = ranked[0];
  const slotCount = Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES);
  if (
    !hasRouteContinuityPriorityContext(state, color, selected)
  ) {
    return ranked;
  }

  const selectedEntry = Number(selected.features.outsideReduction) || 0;
  const selectedProgress = Number(selected.features.outsidePipGain) || 0;
  const selectedDebt = Number(selected.features.laggardDebtDelta) || 0;
  const continuing = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.outsideReduction || 0) >= selectedEntry
    && Number(candidate.features.outsidePipGain || 0) > selectedProgress
    && (
      Number(candidate.features.laggardDebtDelta || 0) >= selectedDebt
      || Number(candidate.features.startZoneReduction || 0)
        > Number(selected.features.startZoneReduction || 0)
    )
    && isPlausibleRouteContinuityAlternative(candidate, selected)
  ));
  if (!continuing.length) return ranked;

  continuing.sort((left, right) => (
    Number(right.score) - Number(left.score)
    || Number(right.features.startZoneReduction || 0)
      - Number(left.features.startZoneReduction || 0)
    || Number(right.features.outsideReduction || 0)
      - Number(left.features.outsideReduction || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
  ));
  continuing[0].features.routeContinuityTacticalReservation = 1;
  // A score-best partial improvement can still contain a home shuffle. Keep
  // it as the policy reference, but also cover one distinct plausible board
  // with minimum shuffling / maximum outside progress before ordinary beam
  // slots. This reserves analysis only; neither score nor safety is changed.
  const scoreBest = continuing[0];
  const progressReference = [...continuing].sort((left, right) => (
    Number(left.features.homeShuffleMoves || 0)
      - Number(right.features.homeShuffleMoves || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
    || scoreWithoutExperience(right) - scoreWithoutExperience(left)
  ))[0];
  if (
    progressReference
    && candidatePositionKey(progressReference) !== candidatePositionKey(scoreBest)
    && (
      Number(progressReference.features.homeShuffleMoves || 0)
        < Number(scoreBest.features.homeShuffleMoves || 0)
      || Number(progressReference.features.outsidePipGain || 0)
        > Number(scoreBest.features.outsidePipGain || 0)
    )
  ) {
    progressReference.features.routeContinuityTacticalReservation = 1;
  }
  return reorderTacticalReservations(ranked, slotCount);
}

function reserveDevelopingFenceEscapeForTacticalAnalysis(
  state,
  color,
  ranked,
  limit = MAX_TACTICAL_CANDIDATES,
) {
  const selected = ranked[0];
  const slotCount = Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES);
  const fenceRun = Number(selected?.features.opponentFenceRunBefore) || 0;
  const hasLatentRearEscape = Boolean(selected) && ranked.some(candidate => (
    candidate !== selected
    && Number(candidate.features.startZoneReduction || 0)
      > Number(selected.features.startZoneReduction || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      > Number(selected.features.latentFenceExposureDelta || 0)
  ));
  const hasContestedHeadExit = Boolean(selected) && ranked.some(candidate => (
    candidate !== selected
    && isPlausibleContestedOpponentHeadExit(state, color, candidate, selected)
  ));
  if (
    !selected
    || homeReady(state, color)
    || (fenceRun < 2 && !hasLatentRearEscape && !hasContestedHeadExit)
  ) {
    return ranked;
  }

  const selectedUtility = fenceEscapeUtility(selected);
  const frontier = Array.from(new Set([
    ...safetyFenceCandidatePool(ranked, selected),
    ...ranked.filter(candidate => isPlausibleContestedOpponentHeadExit(
      state,
      color,
      candidate,
      selected,
    )),
    ...ranked.filter(candidate => isPlausibleImminentHeadFenceAnchor(
      state,
      color,
      candidate,
      selected,
    )),
  ])).filter((candidate) => {
    const contestedHeadExit = isPlausibleContestedOpponentHeadExit(
      state,
      color,
      candidate,
      selected,
    );
    return candidate !== selected
      && (contestedHeadExit || fenceEscapeUtility(candidate) > selectedUtility + 1)
      && Number(candidate.features.maxRouteTowerAfter || 0)
        <= Number(selected.features.maxRouteTowerAfter || 0) + 1
      && Number(candidate.features.homeShuffleMoves || 0)
        <= Number(selected.features.homeShuffleMoves || 0)
      && (
        contestedHeadExit
        || (
          scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 260000000
          && Number(candidate.features.primeRunAfter || 0)
            >= Number(selected.features.primeRunAfter || 0)
        )
        || isPlausibleCriticalHeadFenceEscape(state, color, candidate, selected)
        || isPlausibleLatentRearFenceEscape(candidate, selected)
      );
  });
  if (!frontier.length) return ranked;

  frontier.sort((left, right) => (
    Number(isPlausibleContestedOpponentHeadExit(state, color, right, selected))
      - Number(isPlausibleContestedOpponentHeadExit(state, color, left, selected))
    || Number(isPlausibleImminentHeadFenceAnchor(state, color, right, selected))
      - Number(isPlausibleImminentHeadFenceAnchor(state, color, left, selected))
    || Number(isPlausibleLatentRearFenceEscape(right, selected))
      - Number(isPlausibleLatentRearFenceEscape(left, selected))
    || fenceEscapeUtility(right) - fenceEscapeUtility(left)
    || Number(right.features.fenceClosureDelta || 0)
      - Number(left.features.fenceClosureDelta || 0)
    || Number(right.score) - Number(left.score)
  ));
  frontier[0].features.fenceEscapeTacticalReservation = 1;
  if (isPlausibleContestedOpponentHeadExit(state, color, frontier[0], selected)) {
    frontier[0].features.contestedHeadExitTacticalReservation = 1;
  }
  if (ranked.length <= slotCount) return ranked;
  return reorderTacticalReservations(ranked, slotCount);
}

function reservePrimeSustainabilityForTacticalAnalysis(
  state,
  color,
  ranked,
  limit = MAX_TACTICAL_CANDIDATES,
) {
  const selected = ranked[0];
  const slotCount = Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES);
  const selectedRun = Number(selected?.features?.primeRunAfter) || 0;
  const selectedRisk = Number(selected?.features?.primeCrunchRiskAfter) || 0;
  const selectedSustainability = Number(selected?.features?.primeSustainabilityAfter) || 0;
  if (
    !selected
    || homeReady(state, color)
    || selectedRun < 4
    || (selectedRisk < 0.45 && selectedSustainability >= 0.38)
  ) {
    return ranked;
  }

  const safer = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.primeCrunchRiskAfter || 0) <= selectedRisk - 0.2
    && Number(candidate.features.primeSustainabilityAfter || 0)
      >= selectedSustainability + 0.06
    // It is valid to shorten an unsustainable blockade by one point in order
    // to retain the timing needed to escape.  Larger collapses still require
    // stronger tactical proof later in the search.
    && Number(candidate.features.primeRunAfter || 0) >= Math.max(3, selectedRun - 1)
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0)
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0) - 12
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0) - 4
    && scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 180000000
  ));
  if (!safer.length) return ranked;

  safer.sort((left, right) => (
    Number(left.features.primeCrunchRiskAfter || 0)
      - Number(right.features.primeCrunchRiskAfter || 0)
    || Number(right.features.primeSustainabilityAfter || 0)
      - Number(left.features.primeSustainabilityAfter || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
    || Number(right.score) - Number(left.score)
  ));
  safer[0].features.primeSustainabilityTacticalReservation = 1;
  return reorderTacticalReservations(ranked, slotCount);
}

function reorderTacticalReservations(ranked, limit) {
  if (!ranked.length) return ranked;
  const slotCount = Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES);
  const selected = ranked[0];
  const reservations = ranked.filter(candidate => (
    candidate !== selected
    && (
      Number(candidate.features.homeEntryTacticalReservation || 0) > 0
      || Number(candidate.features.structuralIntegrityTacticalReservation || 0) > 0
      || Number(candidate.features.routeContinuityTacticalReservation || 0) > 0
      || Number(candidate.features.fenceEscapeTacticalReservation || 0) > 0
      || Number(candidate.features.primeSustainabilityTacticalReservation || 0) > 0
    )
  ));
  if (!reservations.length) return ranked;

  reservations.sort((left, right) => (
    tacticalReservationPriority(left) - tacticalReservationPriority(right)
    || Number(right.score) - Number(left.score)
  ));
  const reserved = uniqueCandidatePositions(reservations).slice(0, slotCount - 1);
  const reservedSet = new Set(reserved);
  const leading = [selected];
  const leadingPositions = new Set([
    candidatePositionKey(selected),
    ...reserved.map(candidatePositionKey),
  ]);
  for (const candidate of ranked) {
    if (candidate === selected || reservedSet.has(candidate)) continue;
    const position = candidatePositionKey(candidate);
    if (leadingPositions.has(position)) continue;
    if (leading.length >= slotCount - reserved.length) break;
    leading.push(candidate);
    leadingPositions.add(position);
  }
  const prioritized = [...leading, ...reserved];
  const prioritizedSet = new Set(prioritized);
  return [...prioritized, ...ranked.filter(candidate => !prioritizedSet.has(candidate))];
}

function tacticalReservationPriority(candidate) {
  if (Number(candidate.features.structuralIntegrityTacticalReservation || 0) > 0) return 0;
  if (Number(candidate.features.homeEntryTacticalReservation || 0) > 0) return 1;
  if (Number(candidate.features.primeSustainabilityTacticalReservation || 0) > 0) return 1.5;
  if (Number(candidate.features.routeContinuityTacticalReservation || 0) > 0) return 2;
  return 3;
}

function uniqueCandidatePositions(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = candidatePositionKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidatePositionKey(candidate) {
  if (!candidate?.after) return `candidate:${String(candidate?.id || '')}`;
  const points = Object.entries(candidate.after.points || {})
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([point, stack]) => `${point}:${stack.color}:${stack.count}`)
    .join('|');
  return `${points}|${Number(candidate.after.off?.white) || 0}:${Number(candidate.after.off?.dark) || 0}`;
}

function hasRouteContinuityPriorityContext(state, color, selected) {
  return Boolean(selected)
    && !homeReady(state, color)
    && headCheckers(state, color) === 0
    && outsideHomeCount(state, color) > 0
    && Number(selected.features.homeShuffleMoves || 0) > 0;
}

function isPlausibleRouteContinuityAlternative(candidate, selected) {
  const progressGain = Math.max(
    0,
    Number(candidate.features.outsidePipGain || 0)
      - Number(selected.features.outsidePipGain || 0),
  );
  const scoreTolerance = Math.min(96000000, 12000000 + progressGain * 12000000);
  const gatewayTolerance = Math.min(4, Math.max(1.25, progressGain * 0.4));
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - scoreTolerance
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0) - 2
    && (
      Number(candidate.features.outsideReduction || 0)
        > Number(selected.features.outsideReduction || 0)
      || Number(candidate.features.escapeGatewayDelta || 0)
        >= Number(selected.features.escapeGatewayDelta || 0) - gatewayTolerance
    )
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1;
}

function isSafeRouteContinuityAlternative(candidate, selected) {
  if (
    !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
    || !isPlausibleRouteContinuityAlternative(candidate, selected)
  ) {
    return false;
  }
  const progressGain = Math.max(
    0,
    Number(candidate.features.outsidePipGain || 0)
      - Number(selected.features.outsidePipGain || 0),
  );
  return Number(candidate.tactical.expectedImpact) >= (
    Number(selected.tactical.expectedImpact) - (1000000 + progressGain * 1000000)
  )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - (2000000 + progressGain * 4000000)
    )
    // Outside progress is not proof that a real blocker may be released.
    // Require corroboration from the same bounded recovery/continuation model
    // instead of promoting on immediate replies while ignoring a deep tail.
    && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 2000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 15000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 5000000)
    && tacticalMetricWithin(candidate, selected, 'continuationExpected', 2000000)
    && tacticalMetricWithin(candidate, selected, 'continuationWorst', 15000000)
    && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 5000000);
}

function hasHomeEntryPriorityContext(state, color, selected) {
  return Boolean(selected)
    && !homeReady(state, color)
    && headCheckers(state, color) === 0
    && outsideHomeCount(state, color) <= 10
    && opponentTrapRisk(state, color) < 120
    && (
      Number(selected.features.homeShuffleMoves || 0) > 0
      || isUncontestedPreHomeStaging(state, color, selected)
      || (
        Number(selected.features.outsideReduction || 0) === 0
        && isUncontestedLateRaceState(state, color, selected.features)
      )
    );
}

function isUncontestedLateRaceState(state, color, features = {}) {
  const outside = outsideHomeCount(state, color);
  // The deep continuation score is allowed to yield to race progress only when
  // the advanced profile has proved that no present or one-roll fence exists.
  // Missing v19 metrics must fail closed instead of looking like numeric zero.
  const advancedMetricsAvailable = [
    'latentFenceExposureBefore',
    'prospectiveFenceExtensionBefore',
    'primeScoreBefore',
    'opponentMoveBlockBefore',
  ].every(key => Object.prototype.hasOwnProperty.call(features, key));
  return outside > 0
    && outside <= 10
    && advancedMetricsAvailable
    && headCheckers(state, color) === 0
    && headCheckers(state, opponentOf(color)) === 0
    && opponentTrapRisk(state, color) === 0
    && escapeGatewayRisk(state, color) <= 24
    && Number(features.trapBefore || 0) === 0
    && Number(features.fenceClosureBefore || 0) === 0
    && Number(features.opponentFenceRunBefore || 0) < 3
    && Number(features.latentFenceExposureBefore || 0) === 0
    && Number(features.prospectiveFenceExtensionBefore || 0) === 0;
}

function isUncontestedPreHomeStaging(state, color, selected) {
  return Boolean(selected)
    && outsideHomeCount(state, color) <= 6
    && Number(selected.features.homeShuffleMoves || 0) === 0
    && Number(selected.features.outsideDevelopmentMoves || 0) > 0
    && isUncontestedLateRaceState(state, color, selected.features);
}

function isPlausibleHomeEntryAlternative(state, color, candidate, selected) {
  const stagedReplacement = isUncontestedPreHomeStaging(state, color, selected);
  const uncontestedRace = isUncontestedLateRaceState(state, color, selected.features);
  const forcedLateEntry = isForcedLateHomeEntryContext(state, color, selected);
  const directReplacement = isDirectLateHomeEntryReplacement(
    state,
    color,
    candidate,
    selected,
  );
  const totalScoreTolerance = directReplacement
    ? 8000000
    : uncontestedRace
      ? 24000000
      : 2000000;
  const trapFloor = directReplacement
    ? Number(selected.features.trapDelta || 0) - 8
    : forcedLateEntry
      ? Number(selected.features.trapDelta || 0)
      : 0;
  const fenceFloor = directReplacement
    ? Number(selected.features.fenceClosureDelta || 0) - 2
    : forcedLateEntry
      ? Number(selected.features.fenceClosureDelta || 0)
      : 0;
  const gatewayFloor = directReplacement
    ? Number(selected.features.escapeGatewayDelta || 0) - 3
    : forcedLateEntry
      ? Number(selected.features.escapeGatewayDelta || 0)
      : 0;
  // A clear race used to bypass this block whenever it was not classified as
  // "staging". Apply the same structural proof to both late-race paths.
  const stagingStructureIsPreserved = !(stagedReplacement || uncontestedRace) || (
    Number(candidate.features.homeShuffleMoves || 0) === 0
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0)
    && Number(candidate.features.prospectiveFenceExtensionDelta || 0)
      >= Number(selected.features.prospectiveFenceExtensionDelta || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.primeScoreAfter || 0)
      >= Number(selected.features.primeScoreAfter || 0)
    && Number(candidate.features.opponentMoveBlockAfter || 0)
      >= Number(selected.features.opponentMoveBlockAfter || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + (uncontestedRace ? 1 : 0)
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0)
  );
  return stagingStructureIsPreserved
    && Number(candidate.features.trapDelta || 0) >= trapFloor
    && Number(candidate.features.fenceClosureDelta || 0) >= fenceFloor
    && Number(candidate.features.escapeGatewayDelta || 0) >= gatewayFloor
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Math.min(6, Number(selected.features.maxRouteTowerAfter || 0) + 1)
    && scoreWithoutExperience(candidate)
      >= scoreWithoutExperience(selected) - totalScoreTolerance;
}

function isDirectLateHomeEntryReplacement(state, color, candidate, selected) {
  const outside = outsideHomeCount(state, color);
  return Boolean(candidate && selected)
    && headCheckers(state, color) === 0
    && outside > 0
    && outside <= 10
    && opponentTrapRisk(state, color) < 120
    && Number(selected.features.homeShuffleMoves || 0) > 0
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.outsideReduction || 0)
      > Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.outsidePipGain || 0)
      > Number(selected.features.outsidePipGain || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0) - 2;
}

function isForcedLateHomeEntryContext(state, color, selected) {
  return Boolean(selected)
    && headCheckers(state, color) === 0
    && outsideHomeCount(state, color) <= 6
    && opponentTrapRisk(state, color) < 120
    && Number(selected.features.homeShuffleMoves || 0) > 0;
}

function boundedExperienceAdjustment(rawAdjustment, immediateScore) {
  const raw = Number(rawAdjustment) || 0;
  const budget = Math.min(
    18000000,
    // Experience is applied only after the cold tactical policy and remains
    // inside its safety envelope.  Let repeated or severe evidence correct a
    // close heuristic margin instead of capping it at an ineffectual six per
    // cent of the already noisy composite score.
    Math.max(6000000, Math.abs(Number(immediateScore) || 0) * 0.28),
  );
  return Math.max(-budget, Math.min(Math.min(6000000, budget), raw));
}

function policyAwareExperienceAdjustment(descriptor, experience, immediateScore) {
  const adjustment = boundedExperienceAdjustment(
    experienceAdjustment(descriptor, experience),
    immediateScore,
  );
  const harmSignal = Math.max(
    Number(descriptor?.mistakeSeverity) || 0,
    Number(descriptor?.riskSignal) || 0,
  );
  return adjustment > 0 && harmSignal >= 1.1 ? 0 : adjustment;
}

function prefilterSequences(adapter, state, color, sequences, maxCandidates) {
  const ready = homeReady(state, color);
  const entryPressure = lateEntryPressure(state, color);
  const trapPressure = opponentTrapRisk(state, color);
  const development = developmentPressure(state, color);
  const rescuePressure = koksRescuePressure(state, color);
  const latentFenceBefore = latentFenceExposure(state, color);
  const prospectiveFenceBefore = prospectiveFenceExtensionRisk(state, color);
  const needsStructuralEscapeCandidate = !ready && (
    latentFenceBefore >= 24
    || prospectiveFenceBefore >= 60
    || (
      blockingPrimeRun(state, color) >= 5
      && blockingPrimeScore(state, color) >= 500
    )
  );

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
      const startZoneExits = startZoneExitMoveCount(sequence, color);
      let structuralSafety = null;
      if (needsStructuralEscapeCandidate) {
        const after = adapter.applySequence(state, sequence, color);
        const latentFenceAfter = latentFenceExposure(after, color);
        const prospectiveFenceAfter = prospectiveFenceExtensionRisk(after, color);
        const trapAfter = opponentTrapRisk(after, color);
        const primeRunAfter = blockingPrimeRun(after, color);
        const primeScoreAfter = blockingPrimeScore(after, color);
        const opponentMoveBlockAfter = opponentMoveBlockScore(after, color);
        structuralSafety = {
          after,
          latentFenceAfter,
          prospectiveFenceAfter,
          trapAfter,
          primeRunAfter,
          primeScoreAfter,
          opponentMoveBlockAfter,
          utility: (latentFenceBefore - latentFenceAfter) * 9
            + (prospectiveFenceBefore - prospectiveFenceAfter) * 7
            + (trapPressure - trapAfter) * 5
            + primeRunAfter * 90
            + primeScoreAfter * 0.12
            + opponentMoveBlockAfter * 0.8,
        };
      }
      return {
        sequence,
        offMoves,
        homeEntries,
        outsideMoves,
        headMoves,
        homeShuffle: insideHomeMoves,
        startZoneExits,
        structuralSafety,
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
          + startZoneExits * 3000000 * rescuePressure
          + roughPips * 120
          + offCount(state, color) * 10
          - pipsFor(state, color) * 0.01,
      };
    })
    .sort((a, b) => b.priority - a.priority);

  const selected = [];
  const seenPositions = new Set();
  const add = (item) => {
    if (!item || selected.length >= maxCandidates) return;
    // A legal turn can be emitted in many commuting move orders, especially
    // for doubles. They are one choice once the turn is complete and must not
    // consume separate shortlist slots ahead of genuinely different boards.
    const after = item.structuralSafety?.after
      || adapter.applySequence(state, item.sequence, color);
    const key = candidatePositionKey({ after });
    if (seenPositions.has(key)) return;
    seenPositions.add(key);
    selected.push(item.sequence);
  };
  const bestBy = (predicate, compare) => scored.filter(predicate).sort(compare)[0];

  add(bestBy(item => item.structuralSafety, (a, b) => (
    b.structuralSafety.utility - a.structuralSafety.utility
    || a.structuralSafety.latentFenceAfter - b.structuralSafety.latentFenceAfter
    || a.structuralSafety.prospectiveFenceAfter - b.structuralSafety.prospectiveFenceAfter
    || a.structuralSafety.trapAfter - b.structuralSafety.trapAfter
    || b.priority - a.priority
  )));
  add(bestBy(item => item.headMoves > 0, (a, b) => b.priority - a.priority));
  add(bestBy(item => item.startZoneExits > 0, (a, b) => (
    b.startZoneExits - a.startZoneExits || b.priority - a.priority
  )));
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
    const fenceRun = Number(features.opponentFenceRunBefore || 0);
    if (trapPressure > 850 && fenceRun >= 4) {
      candidate.score += Number(features.trapDelta || 0) * 2200000;
      candidate.score += Number(features.escapeGatewayDelta || 0) * 2800000;
      // Laggard progress is already priced by scoreSequence.  The emergency
      // race bonus must not pay for the same progress again when the move
      // dismantles the prime or the only escape gateway protecting it.
      if (routeProgressPreservesDefense(state, color, features)) {
        candidate.score += Math.max(0, Number(features.laggardDebtDelta) || 0) * 340000;
      }
      candidate.score += Number(features.outsideDevelopmentMoves || 0) * 12000000;
      candidate.score -= Number(features.homeEntryMoves || 0) * 18000000;
    } else if (trapPressure > 850 && outside <= 8 && maxEntry > 0) {
      const entry = Number(features.outsideReduction || 0);
      const trapScale = Math.min(72000000, trapPressure * 52000);
      candidate.score += entry * (18000000 + trapScale);
      if (entry < maxEntry) {
        candidate.score -= (maxEntry - entry) * (16000000 + trapScale * 0.82);
      }
      candidate.score -= Number(features.homeShuffleMoves || 0)
        * (12000000 + trapScale * 0.72);
    } else if (trapPressure > 850 && outside > 8) {
      candidate.score += Number(features.trapDelta || 0) * 1800000;
      candidate.score += Number(features.escapeGatewayDelta || 0) * 2400000;
      candidate.score += Number(features.outsideDevelopmentMoves || 0) * 9000000;
      candidate.score += Number(features.distributionDelta || 0) * 180000;
      candidate.score -= Number(features.homeEntryMoves || 0) * 42000000;
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

function routeProgressPreservesDefense(state, color, features = {}) {
  const primeRunBefore = Number(features.primeRunBefore) || 0;
  const primeRunAfter = Number(features.primeRunAfter) || 0;
  const trapBefore = Number(features.trapBefore) || 0;
  // Ordinary route play still needs to trade temporary structure for tempo.
  // The duplicate progress bonus becomes dangerous only under a developed
  // trap, which is exactly where LZE8-Z538 dismantled its own four-prime.
  if (trapBefore < 600) return true;
  const criticalClearedHeadEscape = headCheckers(state, color) === 0
    && headCheckers(state, opponentOf(color)) === 0
    && primeRunBefore >= 5
    && Number(features.laggardDebtDelta || 0) >= 120
    && Number(features.startZoneReduction || 0) > 0;
  if (criticalClearedHeadEscape) return true;
  return !(primeRunBefore >= 3 && primeRunAfter < primeRunBefore)
    && Number(features.primeScoreGain || 0) >= 0
    && Number(features.opponentMoveBlockGain || 0) >= 0
    && Number(features.fenceClosureDelta || 0) >= 0
    && Number(features.escapeGatewayDelta || 0) >= 0;
}

function prioritizeDevelopingFenceEscape(state, color, ranked) {
  if (!ranked.length || homeReady(state, color)) return ranked;
  const selected = ranked[0];
  const fenceRun = Math.max(...ranked.map(
    candidate => Number(candidate.features.opponentFenceRunBefore) || 0,
  ));
  const closureBefore = Math.max(...ranked.map(
    candidate => Number(candidate.features.fenceClosureBefore) || 0,
  ));
  const selectedUtility = fenceEscapeUtility(selected);
  const frontier = safetyFenceCandidatePool(ranked, selected);
  const maxEscapeUtility = Math.max(...frontier.map(fenceEscapeUtility));
  const latentRearEscape = frontier.some(candidate => isLatentRearFenceEscape(
    candidate,
    selected,
  ));
  const developingFenceIsCritical = (fenceRun >= 2 || latentRearEscape)
    && (
      closureBefore >= 12
      || Number(selected.features.fenceClosureDelta || 0) < 0
      || latentRearEscape
    )
    && maxEscapeUtility > selectedUtility + 1;
  if (!developingFenceIsCritical) return ranked;

  const escapeFloor = selectedUtility + Math.max(1, (maxEscapeUtility - selectedUtility) * 0.72);
  const escaping = frontier.filter(candidate => (
    candidate !== selected
    && !isDeepFenceSafetyRegression(candidate, selected)
    && (
      (
        fenceEscapeUtility(candidate) >= escapeFloor
        && (
          isComparableFenceEscape(candidate, selected)
          || isCriticalHeadFenceEscape(state, color, candidate, selected)
        )
      )
      || isLatentRearFenceEscape(candidate, selected)
    )
  ));
  if (!escaping.length) return ranked;

  escaping.sort((left, right) => (
    Number(isLatentRearFenceEscape(right, selected))
      - Number(isLatentRearFenceEscape(left, selected))
    || fenceEscapeUtility(right) - fenceEscapeUtility(left)
    || Number(right.features.fenceClosureDelta || 0)
      - Number(left.features.fenceClosureDelta || 0)
    || Number(right.score) - Number(left.score)
  ));
  if (isExperienceOverruledFenceEscape(escaping[0], selected)) {
    escaping[0].features.experienceSafetyOverride = 1;
  }
  return promoteCandidate(
    ranked,
    escaping[0],
    'developingFenceEscapeAdjustment',
  );
}

function prioritizeContestedOpponentHeadExit(state, color, ranked) {
  const selected = ranked[0];
  if (!selected) return ranked;

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isAnalyzedContestedOpponentHeadExit(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.tactical.worstImpact || 0)
      - Number(left.tactical.worstImpact || 0)
    || Number(right.tactical.continuationWorst || 0)
      - Number(left.tactical.continuationWorst || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'contestedOpponentHeadExitAdjustment',
  );
  promoted[0].features.contestedOpponentHeadExit = 1;
  return promoted;
}

function prioritizeImminentHeadFenceAnchor(state, color, ranked) {
  const selected = ranked[0];
  if (!selected) return ranked;

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isAnalyzedImminentHeadFenceAnchor(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.features.latentFenceExposureDelta || 0)
      - Number(left.features.latentFenceExposureDelta || 0)
    || Number(right.tactical.continuationWorst || 0)
      - Number(left.tactical.continuationWorst || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'imminentHeadFenceEscapeAdjustment',
  );
  promoted[0].features.imminentHeadFenceEscape = 1;
  return promoted;
}

function prioritizeProspectiveFenceInterruption(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isAnalyzedProspectiveFenceInterruption(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.tactical.continuationWorst || 0)
      - Number(left.tactical.continuationWorst || 0)
    || Number(right.tactical.continuationTailRisk || 0)
      - Number(left.tactical.continuationTailRisk || 0)
    || Number(right.features.prospectiveFenceExtensionDelta || 0)
      - Number(left.features.prospectiveFenceExtensionDelta || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'prospectiveFenceInterruptionAdjustment',
  );
  promoted[0].features.prospectiveFenceInterruptionPreserved = 1;
  return promoted;
}

function prioritizeProspectiveFenceAnchorSafety(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isAnalyzedProspectiveFenceAnchorSafety(candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.tactical.continuationWorst || 0)
      - Number(left.tactical.continuationWorst || 0)
    || Number(right.tactical.continuationTailRisk || 0)
      - Number(left.tactical.continuationTailRisk || 0)
    || Number(right.tactical.continuationExpected || 0)
      - Number(left.tactical.continuationExpected || 0)
    || Number(left.features.prospectiveFenceExtensionAfter || 0)
      - Number(right.features.prospectiveFenceExtensionAfter || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'prospectiveFenceAnchorSafetyAdjustment',
  );
  promoted[0].features.prospectiveFenceAnchorPreserved = 1;
  return promoted;
}

function prioritizeProbabilisticFenceDenial(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isAnalyzedProbabilisticFenceDenial(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    probabilisticFenceDenialGain(right, selected)
      - probabilisticFenceDenialGain(left, selected)
    || Number(right.tactical.continuationExpected || 0)
      - Number(left.tactical.continuationExpected || 0)
    || Number(right.tactical.recoveryWorst || 0)
      - Number(left.tactical.recoveryWorst || 0)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'probabilisticFenceDenialAdjustment',
  );
  promoted[0].features.probabilisticFenceDenial = 1;
  return promoted;
}

function probabilisticFenceDenialGain(candidate, selected) {
  return Number(selected.features.prospectiveFenceExtensionAfter || 0)
    - Number(candidate.features.prospectiveFenceExtensionAfter || 0);
}

function preservesVacatedRouteAnchor(state, color, candidate, selected) {
  return Object.entries(state.points || {}).some(([point, stack]) => (
    stack?.color === color
    && Number(stack.count || 0) > 0
    && colorAt(candidate.after, Number(point)) === color
    && colorAt(selected.after, Number(point)) !== color
  ));
}

function isAnalyzedProbabilisticFenceDenial(state, color, candidate, selected) {
  const candidateFeatures = candidate?.features || {};
  const selectedFeatures = selected?.features || {};
  const candidateTactical = candidate?.tactical || {};
  const selectedTactical = selected?.tactical || {};
  const scoreTolerance = Math.min(
    120000000,
    45000000 + Math.max(0, Number(selectedFeatures.trapBefore || 0)) * 80000,
  );
  if (
    !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
    || Number(selectedFeatures.opponentFenceRunBefore || 0) < 3
    || Number(selectedFeatures.trapBefore || 0) < 600
    || probabilisticFenceDenialGain(candidate, selected) < 60
    || !preservesVacatedRouteAnchor(state, color, candidate, selected)
    || scoreWithoutExperience(candidate) < scoreWithoutExperience(selected) - scoreTolerance
  ) {
    return false;
  }

  const progressIsPreserved = Number(candidateFeatures.headGain || 0)
      >= Number(selectedFeatures.headGain || 0)
    && Number(candidateFeatures.outsideReduction || 0)
      >= Number(selectedFeatures.outsideReduction || 0)
    && Number(candidateFeatures.outsidePipGain || 0)
      >= Number(selectedFeatures.outsidePipGain || 0)
    && Number(candidateFeatures.startZoneReduction || 0)
      >= Number(selectedFeatures.startZoneReduction || 0)
    && Number(candidateFeatures.resultSafetyAfter || 0)
      >= Number(selectedFeatures.resultSafetyAfter || 0)
    && Number(candidateFeatures.missedKoksRescue || 0)
      <= Number(selectedFeatures.missedKoksRescue || 0)
    && Number(candidateFeatures.homeShuffleMoves || 0)
      <= Number(selectedFeatures.homeShuffleMoves || 0)
    && Number(candidateFeatures.maxRouteTowerAfter || 0)
      <= Number(selectedFeatures.maxRouteTowerAfter || 0)
    && Number(candidateFeatures.primeRunAfter || 0)
      >= Number(selectedFeatures.primeRunAfter || 0);
  if (!progressIsPreserved) return false;

  return Number(candidateTactical.expectedImpact || 0)
      >= Number(selectedTactical.expectedImpact || 0)
    && Number(candidateTactical.worstImpact || 0)
      >= Number(selectedTactical.worstImpact || 0) - 2000000
    && Number(candidateTactical.recoveryExpected || 0)
      >= Number(selectedTactical.recoveryExpected || 0) - 5000000
    && Number(candidateTactical.recoveryWorst || 0)
      >= Number(selectedTactical.recoveryWorst || 0) - 10000000
    && Number(candidateTactical.recoveryTailRisk || 0)
      >= Number(selectedTactical.recoveryTailRisk || 0) - 5000000
    && Number(candidateTactical.continuationExpected || 0)
      >= Number(selectedTactical.continuationExpected || 0) + 40000000
    && Number(candidateTactical.continuationWorst || 0)
      >= Number(selectedTactical.continuationWorst || 0) - 2000000
    && Number(candidateTactical.continuationTailRisk || 0)
      >= Number(selectedTactical.continuationTailRisk || 0) - 2000000;
}

function prioritizeVerifiedDeepSafety(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || ranked.length < 2) return ranked;
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isVerifiedDeepSafetyAlternative(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    verifiedDeepSafetyGain(right, selected) - verifiedDeepSafetyGain(left, selected)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'verifiedDeepSafetyAdjustment',
  );
  promoted[0].features.verifiedDeepSafety = 1;
  return promoted;
}

function tacticalMetricWithin(candidate, selected, key, tolerance, requiredGain = 0) {
  return Number(candidate.tactical?.[key] || 0) >= (
    Number(selected.tactical?.[key] || 0) + requiredGain - tolerance
  );
}

function structuralProgressIsBounded(candidate, selected, proofType) {
  const features = candidate.features || {};
  const baseline = selected.features || {};
  const common = Number(features.resultSafetyAfter || 0)
      >= Number(baseline.resultSafetyAfter || 0)
    && Number(features.maxRouteTowerAfter || 0)
      <= Number(baseline.maxRouteTowerAfter || 0) + 1;
  if (!common) return false;

  if (proofType === 'latent-fence-escape') {
    return Number(features.headGain || 0) >= Number(baseline.headGain || 0)
      && Number(features.outsideReduction || 0)
        >= Number(baseline.outsideReduction || 0) - 1
      && Number(features.outsidePipGain || 0)
        >= Number(baseline.outsidePipGain || 0)
      && Number(features.startZoneReduction || 0)
        >= Number(baseline.startZoneReduction || 0)
      && Number(features.homeShuffleMoves || 0)
        <= Number(baseline.homeShuffleMoves || 0);
  }
  if (proofType === 'active-prime') {
    return Number(features.headGain || 0) >= Number(baseline.headGain || 0)
      && Number(features.outsideReduction || 0)
        > Number(baseline.outsideReduction || 0)
      && Number(features.homeEntryMoves || 0)
        > Number(baseline.homeEntryMoves || 0)
      && Number(features.homeShuffleMoves || 0)
        <= Number(baseline.homeShuffleMoves || 0);
  }
  if (proofType === 'prevents-new-latent-fence') {
    return Number(features.outsideReduction || 0)
        >= Number(baseline.outsideReduction || 0)
      && Number(features.homeEntryMoves || 0)
        >= Number(baseline.homeEntryMoves || 0)
      && Number(features.outsidePipGain || 0)
        >= Number(baseline.outsidePipGain || 0)
      && Number(features.homeShuffleMoves || 0)
        <= Number(baseline.homeShuffleMoves || 0);
  }
  return Number(features.headGain || 0) >= Number(baseline.headGain || 0)
    && Number(features.outsideReduction || 0)
      >= Number(baseline.outsideReduction || 0)
    && Number(features.outsidePipGain || 0)
      >= Number(baseline.outsidePipGain || 0)
    && Number(features.startZoneReduction || 0)
      >= Number(baseline.startZoneReduction || 0)
    && Number(features.homeShuffleMoves || 0)
      <= Number(baseline.homeShuffleMoves || 0);
}

function hasStructuralIntegrityEnvelope(candidate, selected, proofType) {
  if (
    !proofType
    || !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
    || !structuralProgressIsBounded(candidate, selected, proofType)
  ) {
    return false;
  }

  const scoreGap = scoreWithoutExperience(selected) - scoreWithoutExperience(candidate);
  if (proofType === 'prevents-new-latent-fence') {
    return scoreGap <= 180000000
      && tacticalMetricWithin(candidate, selected, 'expectedImpact', 0)
      && tacticalMetricWithin(candidate, selected, 'worstImpact', 0)
      && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 10000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 10000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 10000000)
      && tacticalMetricWithin(candidate, selected, 'continuationExpected', 5000000)
      && tacticalMetricWithin(candidate, selected, 'continuationWorst', 5000000)
      && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 5000000);
  }
  if (proofType === 'latent-fence-escape') {
    return scoreGap <= 12000000
      && tacticalMetricWithin(candidate, selected, 'expectedImpact', 2000000)
      && tacticalMetricWithin(candidate, selected, 'worstImpact', 2000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 0, 5000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 12000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 2000000)
      && tacticalMetricWithin(candidate, selected, 'continuationExpected', 9000000)
      && tacticalMetricWithin(candidate, selected, 'continuationWorst', 2000000)
      && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 2000000);
  }
  if (proofType === 'active-prime') {
    const delta = structuralIntegrityDeltas(candidate, selected);
    // Only the single worst continuation sample may consume the larger
    // structural allowance. Expected and lower-tail continuation stay within
    // their tight envelopes below, so a large prime cannot hide broad damage.
    const continuationWorstTolerance = Math.min(
      120000000,
      Math.max(12000000, delta.blockRelief * 700000),
    );
    return scoreGap <= 180000000
      && tacticalMetricWithin(candidate, selected, 'expectedImpact', 5000000)
      && tacticalMetricWithin(candidate, selected, 'worstImpact', 10000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 0, 10000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 15000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 5000000)
      && tacticalMetricWithin(candidate, selected, 'continuationExpected', 5000000)
      && tacticalMetricWithin(
        candidate,
        selected,
        'continuationWorst',
        continuationWorstTolerance,
      )
      && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 12000000);
  }
  return scoreGap <= 40000000
    && tacticalMetricWithin(candidate, selected, 'expectedImpact', 5000000)
    && tacticalMetricWithin(candidate, selected, 'worstImpact', 8000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 10000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 15000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 15000000)
    && tacticalMetricWithin(candidate, selected, 'continuationExpected', 8000000)
    && tacticalMetricWithin(candidate, selected, 'continuationWorst', 12000000)
    && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 12000000);
}

function prioritizeStructuralIntegrity(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;
  const alternatives = ranked.filter(candidate => {
    if (candidate === selected) return false;
    const proofType = structuralIntegrityProofType(candidate, selected);
    return hasStructuralIntegrityEnvelope(candidate, selected, proofType);
  });
  if (!alternatives.length) return ranked;
  alternatives.sort((left, right) => (
    structuralIntegrityUtility(right, selected)
      - structuralIntegrityUtility(left, selected)
    || Number(right.tactical.worstImpact || 0)
      - Number(left.tactical.worstImpact || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'structuralIntegrityAdjustment',
  );
  promoted[0].features.structuralIntegrityOverride = 1;
  promoted[0].features.structuralIntegrityProofType = structuralIntegrityProofType(
    promoted[0],
    selected,
  );
  return promoted;
}

function tacticallyEquivalentStructureGain(candidate, selected) {
  const delta = structuralIntegrityDeltas(candidate, selected);
  return delta.primeRunRelief * 45
    + delta.primeScoreRelief * 0.7
    + delta.blockRelief * 1.5
    + delta.gatewayRelief * 5
    + delta.fenceRelief * 2
    + delta.latentRelief * 3
    + delta.trapRelief * 3
    + delta.interruptionRelief * 0.5
    + delta.prospectiveRelief * 0.35;
}

function isTacticallyEquivalentBlockRescue(candidate, selected) {
  const delta = structuralIntegrityDeltas(candidate, selected);
  return delta.blockRelief >= 100
    && delta.gatewayRelief >= 0
    && Number(candidate.features.prospectiveFenceInterruptionBreak || 0)
      <= Number(selected.features.prospectiveFenceInterruptionBreak || 0) + 5;
}

function hasTacticallyEquivalentBlockRescueEnvelope(candidate, selected) {
  if (
    !isTacticallyEquivalentBlockRescue(candidate, selected)
    || !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
  ) {
    return false;
  }
  const delta = structuralIntegrityDeltas(candidate, selected);
  const recoveryWorstTolerance = Math.min(
    45000000,
    Math.max(0, delta.blockRelief) * 400000,
  );
  // A verified block gain can offset one rare worst-frontier branch, but the
  // cap is proportional to the gain and never relaxes expected/tail evidence.
  const continuationWorstTolerance = Math.min(
    90000000,
    Math.max(10000000, delta.blockRelief * 800000),
  );
  return tacticalMetricWithin(candidate, selected, 'expectedImpact', 3000000)
    && tacticalMetricWithin(candidate, selected, 'worstImpact', 3000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 5000000)
    && tacticalMetricWithin(
      candidate,
      selected,
      'recoveryWorst',
      recoveryWorstTolerance,
    )
    && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 10000000)
    && tacticalMetricWithin(candidate, selected, 'continuationExpected', 5000000)
    && tacticalMetricWithin(
      candidate,
      selected,
      'continuationWorst',
      continuationWorstTolerance,
    )
    && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 10000000);
}

function hasTacticallyEquivalentStructuralProof(candidate, selected) {
  const blockRescue = hasTacticallyEquivalentBlockRescueEnvelope(candidate, selected);
  const primeRetention = hasTacticallyEquivalentPrimeRetentionEnvelope(candidate, selected);
  return blockRescue || primeRetention;
}

function hasTacticallyEquivalentPrimeRetentionEnvelope(candidate, selected) {
  const delta = structuralIntegrityDeltas(candidate, selected);
  return delta.primeScoreRelief >= 100
    && hasBoundedFourPlyTactical(candidate)
    && hasBoundedFourPlyTactical(selected)
    && tacticalMetricWithin(candidate, selected, 'expectedImpact', 3000000)
    && tacticalMetricWithin(candidate, selected, 'worstImpact', 3000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 0, 8000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 0, 20000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 10000000)
    && tacticalMetricWithin(candidate, selected, 'continuationExpected', 5000000)
    && tacticalMetricWithin(candidate, selected, 'continuationWorst', 10000000)
    && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 10000000);
}

function prioritizeTacticallyEquivalentStructure(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && hasBoundedFourPlyTactical(candidate)
    && hasBoundedFourPlyTactical(selected)
    && hasTacticallyEquivalentStructuralProof(candidate, selected)
    && scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - (
      isTacticallyEquivalentBlockRescue(candidate, selected) ? 24000000 : 22000000
    )
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0)
    && Number(candidate.features.headGain || 0)
      >= Number(selected.features.headGain || 0)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.outsidePipGain || 0)
      >= Number(selected.features.outsidePipGain || 0)
    && Number(candidate.features.startZoneReduction || 0)
      >= Number(selected.features.startZoneReduction || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) - 3000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) - 3000000
  ));
  if (!alternatives.length) return ranked;
  alternatives.sort((left, right) => (
    tacticallyEquivalentStructureGain(right, selected)
      - tacticallyEquivalentStructureGain(left, selected)
    || Number(right.tactical.recoveryExpected || 0)
      - Number(left.tactical.recoveryExpected || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'tacticalStructureAdjustment',
  );
  promoted[0].features.tacticalStructureOverride = 1;
  return promoted;
}

function isBoundedLateHomeEntryAlternative(state, color, candidate, selected) {
  const features = candidate?.features || {};
  const baseline = selected?.features || {};
  const advancedMetricsAvailable = [
    'trapBefore',
    'fenceClosureBefore',
    'latentFenceExposureBefore',
    'prospectiveFenceExtensionBefore',
    'opponentFenceRunBefore',
  ].every(key => Object.prototype.hasOwnProperty.call(baseline, key));
  if (
    !advancedMetricsAvailable
    || outsideHomeCount(state, color) < 1
    || outsideHomeCount(state, color) > 4
    || headCheckers(state, color) !== 0
    || headCheckers(state, opponentOf(color)) !== 0
    || opponentTrapRisk(state, color) > 24
    || escapeGatewayRisk(state, color) > 12
    || Number(baseline.trapBefore || 0) > 24
    || Number(baseline.fenceClosureBefore || 0) > 0
    || Number(baseline.opponentFenceRunBefore || 0) > 3
    // This is a bounded late-route policy, not a declaration that contact has
    // ended. Mild latent pressure is allowed only when every structural metric
    // below is unchanged and the all-dice three-ply envelope corroborates
    // the entry.
    || Number(baseline.latentFenceExposureBefore || 0) > 120
    || Number(baseline.prospectiveFenceExtensionBefore || 0) !== 0
    || !hasCompleteThreePlyTactical(candidate)
    || !hasCompleteThreePlyTactical(selected)
  ) {
    return false;
  }

  const structureIsUnchanged = Number(features.trapDelta || 0)
      >= Number(baseline.trapDelta || 0)
    && Number(features.fenceClosureDelta || 0)
      >= Number(baseline.fenceClosureDelta || 0)
    && Number(features.escapeGatewayDelta || 0)
      >= Number(baseline.escapeGatewayDelta || 0)
    && Number(features.latentFenceExposureDelta || 0)
      >= Number(baseline.latentFenceExposureDelta || 0)
    && Number(features.prospectiveFenceExtensionDelta || 0)
      >= Number(baseline.prospectiveFenceExtensionDelta || 0)
    && Number(features.primeRunAfter || 0)
      >= Number(baseline.primeRunAfter || 0)
    && Number(features.primeScoreAfter || 0)
      >= Number(baseline.primeScoreAfter || 0)
    && Number(features.opponentMoveBlockAfter || 0)
      >= Number(baseline.opponentMoveBlockAfter || 0)
    && Number(features.maxRouteTowerAfter || 0)
      <= Number(baseline.maxRouteTowerAfter || 0)
    && Number(features.resultSafetyAfter || 0)
      >= Number(baseline.resultSafetyAfter || 0);
  if (!structureIsUnchanged) return false;

  const progressIsComparable = Number(features.outsideReduction || 0)
      >= Number(baseline.outsideReduction || 0)
    && Number(features.homeEntryMoves || 0)
      >= Number(baseline.homeEntryMoves || 0)
    && Number(features.headGain || 0) >= Number(baseline.headGain || 0)
    && Number(features.startZoneReduction || 0)
      >= Number(baseline.startZoneReduction || 0);
  if (!progressIsComparable) return false;

  // Do not use the representative continuation frontier as a hard override.
  // Primary/recovery cover every dice outcome within their bounded reply
  // beams; their three-ply envelope must reject a materially worse tail.
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 22000000
    && tacticalMetricWithin(candidate, selected, 'expectedImpact', 2000000)
    && tacticalMetricWithin(candidate, selected, 'worstImpact', 2000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 0)
    && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 12000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 8000000);
}

function prioritizeAvoidableHomeShuffle(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected
    || homeReady(state, color)
    || Number(selected.features.avoidableHomeShuffleMoves || 0) <= 0
  ) {
    return ranked;
  }
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.avoidableHomeShuffleMoves || 0)
      < Number(selected.features.avoidableHomeShuffleMoves || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && isBoundedLateHomeEntryAlternative(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;
  alternatives.sort((left, right) => (
    Number(left.features.avoidableHomeShuffleMoves || 0)
      - Number(right.features.avoidableHomeShuffleMoves || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
    || Number(right.tactical.worstImpact || 0)
      - Number(left.tactical.worstImpact || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'avoidableHomeShuffleAdjustment',
  );
  promoted[0].features.avoidableHomeShuffleOverride = 1;
  return promoted;
}

function verifiedDeepSafetyGain(candidate, selected) {
  const candidateTactical = candidate.tactical || {};
  const selectedTactical = selected.tactical || {};
  return Number(candidateTactical.recoveryExpected || 0)
      - Number(selectedTactical.recoveryExpected || 0)
    + Number(candidateTactical.recoveryWorst || 0)
      - Number(selectedTactical.recoveryWorst || 0)
    + Number(candidateTactical.continuationExpected || 0)
      - Number(selectedTactical.continuationExpected || 0)
    + Number(candidateTactical.continuationWorst || 0)
      - Number(selectedTactical.continuationWorst || 0);
}

function isVerifiedDeepSafetyAlternative(state, color, candidate, selected) {
  if (!hasBoundedFourPlyTactical(candidate) || !hasBoundedFourPlyTactical(selected)) {
    return false;
  }
  const candidateFeatures = candidate.features || {};
  const selectedFeatures = selected.features || {};
  const candidateTactical = candidate.tactical || {};
  const selectedTactical = selected.tactical || {};
  const earlyResultSafetyTolerance = offCount(state, opponentOf(color)) === 0 ? 1 : 0;
  const progressIsPreserved = Number(candidateFeatures.headGain || 0)
      >= Number(selectedFeatures.headGain || 0)
    && Number(candidateFeatures.outsideReduction || 0)
      >= Number(selectedFeatures.outsideReduction || 0)
    && Number(candidateFeatures.outsidePipGain || 0)
      >= Number(selectedFeatures.outsidePipGain || 0)
    && Number(candidateFeatures.startZoneReduction || 0)
      >= Number(selectedFeatures.startZoneReduction || 0) - earlyResultSafetyTolerance
    && Number(candidateFeatures.resultSafetyAfter || 0)
      >= Number(selectedFeatures.resultSafetyAfter || 0)
    && Number(candidateFeatures.homeShuffleMoves || 0)
      <= Number(selectedFeatures.homeShuffleMoves || 0)
    && Number(candidateFeatures.maxRouteTowerAfter || 0)
      <= Number(selectedFeatures.maxRouteTowerAfter || 0)
    && Number(candidateFeatures.primeRunAfter || 0)
      >= Number(selectedFeatures.primeRunAfter || 0) - 1;
  if (!progressIsPreserved) return false;

  const directRecoveryProof = Number(candidateTactical.recoveryExpected || 0)
      >= Number(selectedTactical.recoveryExpected || 0) + 8000000
    && Number(candidateTactical.recoveryWorst || 0)
      >= Number(selectedTactical.recoveryWorst || 0) + 75000000;
  const corroboratedContinuationProof = Number(candidateTactical.recoveryExpected || 0)
      >= Number(selectedTactical.recoveryExpected || 0) + 6000000
    && Number(candidateTactical.recoveryWorst || 0)
      >= Number(selectedTactical.recoveryWorst || 0) + 20000000
    && Number(candidateTactical.continuationExpected || 0)
      >= Number(selectedTactical.continuationExpected || 0) + 30000000
    && Number(candidateTactical.continuationWorst || 0)
      >= Number(selectedTactical.continuationWorst || 0) + 60000000
    && Number(candidateFeatures.trapDelta || 0)
      >= Number(selectedFeatures.trapDelta || 0)
    && Number(candidateFeatures.fenceClosureDelta || 0)
      >= Number(selectedFeatures.fenceClosureDelta || 0)
    && Number(candidateFeatures.escapeGatewayDelta || 0)
      >= Number(selectedFeatures.escapeGatewayDelta || 0) - 1
    && Number(candidateFeatures.latentFenceExposureDelta || 0)
      >= Number(selectedFeatures.latentFenceExposureDelta || 0);

  return Number(candidateTactical.expectedImpact || 0)
      >= Number(selectedTactical.expectedImpact || 0) - 12000000
    && Number(candidateTactical.worstImpact || 0)
      >= Number(selectedTactical.worstImpact || 0) - 12000000
    && (directRecoveryProof || corroboratedContinuationProof)
    && Number(candidateTactical.recoveryTailRisk || 0)
      >= Number(selectedTactical.recoveryTailRisk || 0) - 25000000
    && Number(candidateTactical.continuationExpected || 0)
      >= Number(selectedTactical.continuationExpected || 0) - 2000000
    && Number(candidateTactical.continuationWorst || 0)
      >= Number(selectedTactical.continuationWorst || 0) - 5000000
    && Number(candidateTactical.continuationTailRisk || 0)
      >= Number(selectedTactical.continuationTailRisk || 0) - 5000000;
}

function isAnalyzedProspectiveFenceAnchorSafety(candidate, selected) {
  const candidateFeatures = candidate?.features || {};
  const selectedFeatures = selected?.features || {};
  const candidateTactical = candidate?.tactical;
  const selectedTactical = selected?.tactical;
  if (
    !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
    || Number(candidateFeatures.prospectiveFenceExtensionAfter || 0)
      > Number(selectedFeatures.prospectiveFenceExtensionAfter || 0) - 40
    || scoreWithoutExperience(candidate) < scoreWithoutExperience(selected) - 18000000
  ) {
    return false;
  }

  const progressIsPreserved = Number(candidateFeatures.headGain || 0)
      >= Number(selectedFeatures.headGain || 0)
    && Number(candidateFeatures.outsideReduction || 0)
      >= Number(selectedFeatures.outsideReduction || 0)
    && Number(candidateFeatures.outsidePipGain || 0)
      >= Number(selectedFeatures.outsidePipGain || 0)
    && Number(candidateFeatures.startZoneReduction || 0)
      >= Number(selectedFeatures.startZoneReduction || 0)
    && Number(candidateFeatures.resultSafetyAfter || 0)
      >= Number(selectedFeatures.resultSafetyAfter || 0)
    && Number(candidateFeatures.missedKoksRescue || 0)
      <= Number(selectedFeatures.missedKoksRescue || 0)
    && Number(candidateFeatures.homeShuffleMoves || 0)
      <= Number(selectedFeatures.homeShuffleMoves || 0)
    && Number(candidateFeatures.maxRouteTowerAfter || 0)
      <= Number(selectedFeatures.maxRouteTowerAfter || 0) + 1
    && Number(candidateFeatures.primeRunAfter || 0)
      >= Number(selectedFeatures.primeRunAfter || 0)
    && Number(candidateFeatures.trapDelta || 0)
      >= Number(selectedFeatures.trapDelta || 0) - 1
    && Number(candidateFeatures.fenceClosureDelta || 0)
      >= Number(selectedFeatures.fenceClosureDelta || 0) - 1
    && Number(candidateFeatures.prospectiveFenceInterruptionBreak || 0)
      <= Number(selectedFeatures.prospectiveFenceInterruptionBreak || 0) + 5
    && Number(candidateFeatures.escapeGatewayDelta || 0)
      >= Number(selectedFeatures.escapeGatewayDelta || 0) - 2
    && Number(candidateFeatures.opponentMoveBlockGain || 0)
      >= Number(selectedFeatures.opponentMoveBlockGain || 0) - 8
    && Number(candidateFeatures.headLandingBreak || 0)
      <= Number(selectedFeatures.headLandingBreak || 0) + 12;
  if (!progressIsPreserved) return false;

  return Number(candidateTactical.expectedImpact || 0)
      >= Number(selectedTactical.expectedImpact || 0) - 3000000
    && Number(candidateTactical.worstImpact || 0)
      >= Number(selectedTactical.worstImpact || 0) - 5000000
    && Number(candidateTactical.recoveryExpected || 0)
      >= Number(selectedTactical.recoveryExpected || 0) + 10000000
    && Number(candidateTactical.recoveryWorst || 0)
      >= Number(selectedTactical.recoveryWorst || 0) + 5000000
    && Number(candidateTactical.recoveryTailRisk || 0)
      >= Number(selectedTactical.recoveryTailRisk || 0) + 5000000
    && Number(candidateTactical.continuationExpected || 0)
      >= Number(selectedTactical.continuationExpected || 0) + 50000000
    && Number(candidateTactical.continuationWorst || 0)
      >= Number(selectedTactical.continuationWorst || 0) + 75000000
    && Number(candidateTactical.continuationTailRisk || 0)
      >= Number(selectedTactical.continuationTailRisk || 0) + 50000000;
}

function isAnalyzedProspectiveFenceInterruption(state, color, candidate, selected) {
  const candidateFeatures = candidate?.features || {};
  const selectedFeatures = selected?.features || {};
  const candidateTactical = candidate?.tactical;
  const selectedTactical = selected?.tactical;
  if (
    !candidateTactical
    || !selectedTactical
    || Number(selectedFeatures.prospectiveFenceInterruptionBreak || 0) < 80
    || Number(candidateFeatures.prospectiveFenceInterruptionBreak || 0) > 5
    || Number(candidateFeatures.prospectiveFenceExtensionDelta || 0) < 0
    || Number(candidateFeatures.prospectiveFenceExtensionDelta || 0)
      < Number(selectedFeatures.prospectiveFenceExtensionDelta || 0) + 80
    || Number(candidateFeatures.prospectiveFenceExtensionAfter || 0)
      > Number(selectedFeatures.prospectiveFenceExtensionAfter || 0) - 80
    || Number(candidate.baseScore || 0) < Number(selected.baseScore || 0)
  ) {
    return false;
  }

  if (!hasBoundedFourPlyTactical(candidate) || !hasBoundedFourPlyTactical(selected)) {
    return false;
  }

  const progressIsPreserved = Number(candidateFeatures.headGain || 0)
      >= Number(selectedFeatures.headGain || 0)
    && Number(candidateFeatures.outsideReduction || 0)
      >= Number(selectedFeatures.outsideReduction || 0)
    && Number(candidateFeatures.outsidePipGain || 0)
      >= Number(selectedFeatures.outsidePipGain || 0)
    && Number(candidateFeatures.startZoneReduction || 0)
      >= Number(selectedFeatures.startZoneReduction || 0)
    && Number(candidateFeatures.resultSafetyAfter || 0)
      >= Number(selectedFeatures.resultSafetyAfter || 0)
    && Number(candidateFeatures.missedKoksRescue || 0)
      <= Number(selectedFeatures.missedKoksRescue || 0)
    && Number(candidateFeatures.homeShuffleMoves || 0)
      <= Number(selectedFeatures.homeShuffleMoves || 0)
    && Number(candidateFeatures.maxRouteTowerAfter || 0)
      <= Number(selectedFeatures.maxRouteTowerAfter || 0)
    && Number(candidateFeatures.primeRunAfter || 0)
      >= Number(selectedFeatures.primeRunAfter || 0)
    && Number(candidateFeatures.trapDelta || 0)
      >= Number(selectedFeatures.trapDelta || 0) - 1
    && Number(candidateFeatures.fenceClosureDelta || 0)
      >= Number(selectedFeatures.fenceClosureDelta || 0) - 1
    && Number(candidateFeatures.escapeGatewayDelta || 0)
      >= Number(selectedFeatures.escapeGatewayDelta || 0) - 2
    && Number(candidateFeatures.opponentMoveBlockGain || 0)
      >= Number(selectedFeatures.opponentMoveBlockGain || 0) - 2
    && Number(candidateFeatures.headLandingBreak || 0)
      <= Number(selectedFeatures.headLandingBreak || 0) + 18;
  if (!progressIsPreserved) return false;

  return Number(candidateTactical.expectedImpact || 0)
      >= Number(selectedTactical.expectedImpact || 0) - 3000000
    && Number(candidateTactical.worstImpact || 0)
      >= Number(selectedTactical.worstImpact || 0) - 5000000
    && Number(candidateTactical.recoveryExpected || 0)
      >= Number(selectedTactical.recoveryExpected || 0) - 5000000
    && Number(candidateTactical.recoveryWorst || 0)
      >= Number(selectedTactical.recoveryWorst || 0) - 25000000
    && Number(candidateTactical.recoveryTailRisk || 0)
      >= Number(selectedTactical.recoveryTailRisk || 0) - 5000000
    && Number(candidateTactical.continuationExpected || 0)
      >= Number(selectedTactical.continuationExpected || 0) + 5000000
    && Number(candidateTactical.continuationWorst || 0)
      >= Number(selectedTactical.continuationWorst || 0) - 5000000
    && Number(candidateTactical.continuationTailRisk || 0)
      >= Number(selectedTactical.continuationTailRisk || 0) + 5000000;
}

function safetyParetoFrontier(ranked) {
  return ranked.filter(candidate => !ranked.some(other => (
    other !== candidate
    && safetyDominates(other, candidate)
  )));
}

function safetyFenceCandidatePool(ranked, selected) {
  return Array.from(new Set([
    ...safetyParetoFrontier(ranked),
    ...ranked.filter(candidate => (
      candidate !== selected
      && isPlausibleLatentRearFenceEscape(candidate, selected)
    )),
  ]));
}

function safetyDominates(left, right) {
  const leftTrap = Number(left.features.trapDelta) || 0;
  const rightTrap = Number(right.features.trapDelta) || 0;
  const leftFence = Number(left.features.fenceClosureDelta) || 0;
  const rightFence = Number(right.features.fenceClosureDelta) || 0;
  const leftGateway = Number(left.features.escapeGatewayDelta) || 0;
  const rightGateway = Number(right.features.escapeGatewayDelta) || 0;
  const leftLatent = Number(left.features.latentFenceExposureDelta) || 0;
  const rightLatent = Number(right.features.latentFenceExposureDelta) || 0;
  return leftTrap >= rightTrap
    && leftFence >= rightFence
    && leftGateway >= rightGateway
    && leftLatent >= rightLatent
    && (
      leftTrap > rightTrap
      || leftFence > rightFence
      || leftGateway > rightGateway
      || leftLatent > rightLatent
    );
}

function fenceEscapeUtility(candidate) {
  return (Number(candidate.features.trapDelta) || 0) * 2
    + (Number(candidate.features.fenceClosureDelta) || 0)
    + (Number(candidate.features.escapeGatewayDelta) || 0) * 4
    + (Number(candidate.features.latentFenceExposureDelta) || 0) * 6;
}

function newlyBlockedOpponentHeadLanding(state, color, candidate, selected) {
  if (!candidate?.after || !selected?.after) return false;
  const opponent = opponentOf(color);
  const landingPoints = new Set(pathFor(opponent).slice(1, 7).map(Number));
  return candidate.sequence?.some(move => {
    const target = Number(move.to);
    return !move.bearOff
      && landingPoints.has(target)
      && colorAt(candidate.after, target) === color
      && colorAt(selected.after, target) !== color;
  });
}

function hasFiniteTacticalMetrics(candidate, keys) {
  return keys.every((key) => (
    candidate?.tactical?.[key] !== null
    && candidate?.tactical?.[key] !== undefined
    && Number.isFinite(Number(candidate.tactical[key]))
  ));
}

function isPlausibleContestedOpponentHeadExit(state, color, candidate, selected) {
  const opponent = opponentOf(color);
  return headCheckers(state, opponent) >= 4
    && newlyBlockedOpponentHeadLanding(state, color, candidate, selected)
    && Number(candidate.features.outsideReduction || 0)
      > Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.headLandingBreak || 0)
      <= Number(selected.features.headLandingBreak || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0) - 1
    && scoreWithoutExperience(candidate) >= (
      scoreWithoutExperience(selected) - CONTESTED_HEAD_EXIT_SCORE_TOLERANCE
    );
}

function isAnalyzedContestedOpponentHeadExit(state, color, candidate, selected) {
  if (
    !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
    || !isPlausibleContestedOpponentHeadExit(state, color, candidate, selected)
    || !hasFiniteTacticalMetrics(candidate, [
      'plies',
      'expectedImpact',
      'worstImpact',
      'recoveryTailRisk',
      'recoveryWorst',
      'continuationTailRisk',
      'continuationWorst',
    ])
    || !hasFiniteTacticalMetrics(selected, [
      'plies',
      'expectedImpact',
      'worstImpact',
      'recoveryTailRisk',
      'recoveryWorst',
      'continuationTailRisk',
      'continuationWorst',
    ])
  ) {
    return false;
  }
  return Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.plies || 0) >= 4
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) + 10000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) + 30000000
    && Number(candidate.tactical.recoveryTailRisk || 0)
      + Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.recoveryTailRisk || 0)
        + Number(selected.tactical.continuationTailRisk || 0) + 30000000
    && Number(candidate.tactical.recoveryWorst || 0)
      + Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.recoveryWorst || 0)
        + Number(selected.tactical.continuationWorst || 0) + 30000000
    && Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.continuationTailRisk || 0) + 10000000
    && Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.continuationWorst || 0) + 15000000;
}

function isPlausibleImminentHeadFenceAnchor(state, color, candidate, selected) {
  const headRemaining = headCheckers(state, color);
  const fenceRun = immediateHeadFenceRun(state, color);
  const head = headPoint(color);
  const anchorsBeyondFence = candidate.sequence?.some(move => (
    Number(move.from) === Number(head)
    && pathPos(color, Number(move.to)) === fenceRun + 1
  ));
  return headRemaining >= 3
    && headRemaining <= 6
    && fenceRun >= 3
    && fenceRun <= 5
    && Number(selected.features.headGain || 0) === 0
    && Number(candidate.features.headGain || 0) > 0
    && anchorsBeyondFence
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0) + 24
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.fenceClosureDelta || 0) >= -4
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0) - 4
    && Number(candidate.features.headLandingBreak || 0)
      <= Number(selected.features.headLandingBreak || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && (
      Number(candidate.features.fenceEscapeTacticalReservation || 0) > 0
      || scoreWithoutExperience(candidate) >= (
        scoreWithoutExperience(selected) - IMMINENT_HEAD_FENCE_SCORE_TOLERANCE
      )
    );
}

function isAnalyzedImminentHeadFenceAnchor(state, color, candidate, selected) {
  if (
    !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
    || !isPlausibleImminentHeadFenceAnchor(state, color, candidate, selected)
    || !hasFiniteTacticalMetrics(candidate, [
      'plies',
      'continuationTailRisk',
      'continuationWorst',
    ])
    || !hasFiniteTacticalMetrics(selected, [
      'plies',
      'continuationTailRisk',
      'continuationWorst',
    ])
  ) {
    return false;
  }
  const completeReservation = Number(candidate.features.fenceEscapeTacticalReservation || 0) > 0;
  return Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.plies || 0) >= 4
    && (
      completeReservation
      || (
        Number(candidate.tactical.continuationTailRisk || 0)
          >= Number(selected.tactical.continuationTailRisk || 0)
        && Number(candidate.tactical.continuationWorst || 0)
          >= Number(selected.tactical.continuationWorst || 0)
      )
    );
}

function isPlausibleCriticalHeadFenceEscape(state, color, candidate, selected) {
  return headCheckers(state, color) >= 4
    && Number(selected.features.opponentFenceRunBefore || 0) >= 2
    && Number(selected.features.fenceClosureDelta || 0) < 0
    && Number(candidate.features.fenceClosureDelta || 0) >= 0
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0) - 4
    && Number(candidate.features.headGain || 0)
      >= Number(selected.features.headGain || 0)
    && Number(candidate.features.headLandingBreak || 0) <= 70
    && Number(candidate.features.primeRunAfter || 0) >= 1;
}

function isCriticalHeadFenceEscape(state, color, candidate, selected) {
  if (
    !candidate.tactical
    || !selected.tactical
    || !isPlausibleCriticalHeadFenceEscape(state, color, candidate, selected)
  ) {
    return false;
  }
  return Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.expectedImpact) >= (
      Number(selected.tactical.expectedImpact) - 15000000
    )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - 15000000
    );
}

function isLatentRearFenceEscape(candidate, selected) {
  if (
    !candidate?.tactical
    || !selected?.tactical
    || !isPlausibleLatentRearFenceEscape(candidate, selected)
  ) {
    return false;
  }
  return Number(candidate.tactical.expectedImpact) >= (
      Number(selected.tactical.expectedImpact) - 10000000
    )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - 15000000
    );
}

function isPlausibleLatentRearFenceEscape(candidate, selected) {
  return Number(candidate.features.startZoneReduction || 0)
    > Number(selected.features.startZoneReduction || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      > Number(selected.features.latentFenceExposureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && preservesLatentEscapePrime(candidate, selected)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && scoreWithoutExperience(candidate) >= (
      scoreWithoutExperience(selected) - LATENT_REAR_ESCAPE_SCORE_TOLERANCE
    );
}

function preservesLatentEscapePrime(candidate, selected) {
  const candidateRun = Number(candidate.features.primeRunAfter || 0);
  const selectedRun = Number(selected.features.primeRunAfter || 0);
  if (candidateRun >= selectedRun) return true;

  const primeRunBefore = Math.max(
    Number(candidate.features.primeRunBefore || 0),
    Number(selected.features.primeRunBefore || 0),
  );
  const activeBlockingPrime = primeRunBefore >= 4
    && Number(candidate.features.primeScoreBefore || 0) > 0
    && Number(candidate.features.opponentMoveBlockBefore || 0) > 0;
  // Shortening an active four by one is eligible for rear-escape analysis only
  // when it clears the exposed start zone without worsening our static safety.
  // This is coverage, not a final override: reply and deep vetoes still apply.
  const clearsExposedFourPrimeRear = primeRunBefore === 4
    && candidateRun >= 3
    && isFourPrimeSelfEscape(candidate.features)
    && candidate.features.latentFenceExposureBefore >= 24
    && candidate.features.latentFenceExposureDelta > 0
    && candidate.features.startZoneReduction > 0
    && candidate.features.resultSafetyAfter > candidate.features.resultSafetyBefore;
  if (activeBlockingPrime && clearsExposedFourPrimeRear) return true;
  return !activeBlockingPrime && candidateRun >= Math.max(1, selectedRun - 1);
}

function scoreWithoutExperience(candidate) {
  return Number(candidate.score)
    - Number(candidate.experienceAdjustment || 0)
    - Number(candidate.features?.policyPromotionAdjustment || 0);
}

function prioritizeExperienceWithinSafetyEnvelope(ranked, coldSelected) {
  if (!coldSelected || ranked.length < 2) return ranked;
  const byLearnedScore = [...ranked].sort((left, right) => right.score - left.score);
  const learnedSelected = byLearnedScore[0];
  const safeCandidates = byLearnedScore.filter(candidate => (
    isExperienceSafeAlternative(candidate, coldSelected)
  ));
  if (!safeCandidates.includes(coldSelected)) safeCandidates.push(coldSelected);
  const safeSet = new Set(safeCandidates);
  safeCandidates.sort((left, right) => right.score - left.score);
  if (learnedSelected !== safeCandidates[0] && !safeSet.has(learnedSelected)) {
    learnedSelected.features.experienceSafetyRejected = 1;
    coldSelected.features.experienceSafetyBaseline = 1;
    coldSelected.features.experienceSafetyOverride = 1;
  }
  return [
    ...safeCandidates,
    ...byLearnedScore.filter(candidate => !safeSet.has(candidate)),
  ];
}

function isExperienceSafeAlternative(candidate, baseline) {
  if (candidate === baseline) return true;
  const features = candidate.features || {};
  const base = baseline.features || {};
  const candidateTactical = candidate.tactical || {};
  const baselineTactical = baseline.tactical || {};
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(baseline) - 18000000
    && Number(features.resultSafetyAfter || 0) >= Number(base.resultSafetyAfter || 0)
    && Number(features.missedKoksRescue || 0) <= Number(base.missedKoksRescue || 0)
    && Number(features.headGain || 0) >= Number(base.headGain || 0)
    && Number(features.startZoneReduction || 0) >= Number(base.startZoneReduction || 0)
    && Number(features.outsideReduction || 0) >= Number(base.outsideReduction || 0)
    && Number(features.outsidePipGain || 0) >= Number(base.outsidePipGain || 0)
    && Number(features.homeShuffleMoves || 0) <= Number(base.homeShuffleMoves || 0)
    && Number(features.avoidableHomeShuffleMoves || 0)
      <= Number(base.avoidableHomeShuffleMoves || 0)
    && Number(features.primeRunAfter || 0) >= Number(base.primeRunAfter || 0)
    && Number(features.primeScoreAfter || 0) >= Number(base.primeScoreAfter || 0) - 1
    && Number(features.maxRouteTowerAfter || 0) <= Number(base.maxRouteTowerAfter || 0) + 1
    && Number(features.trapDelta || 0) >= Number(base.trapDelta || 0) - 2
    && Number(features.fenceClosureDelta || 0) >= Number(base.fenceClosureDelta || 0) - 2
    && Number(features.escapeGatewayDelta || 0) >= Number(base.escapeGatewayDelta || 0) - 4
    && Number(features.latentFenceExposureDelta || 0)
      >= Number(base.latentFenceExposureDelta || 0) - 2
    && Number(features.prospectiveFenceInterruptionBreak || 0)
      <= Number(base.prospectiveFenceInterruptionBreak || 0) + 5
    && Number(features.prospectiveFenceExtensionDelta || 0)
      >= Number(base.prospectiveFenceExtensionDelta || 0) - 5
    && Number(features.opponentHeadFreedomDelta || 0)
      >= Number(base.opponentHeadFreedomDelta || 0) - 2
    && Number(features.opponentMoveBlockAfter || 0)
      >= Number(base.opponentMoveBlockAfter || 0) - 10
    && Number(features.headLandingBreak || 0) <= Number(base.headLandingBreak || 0) + 12
    && Number(candidate.experience?.riskSignal || 0)
      <= Number(baseline.experience?.riskSignal || 0) + 0.75
    && Number(candidate.experience?.mistakeSeverity || 0)
      <= Number(baseline.experience?.mistakeSeverity || 0) + 0.75
    && Number(candidateTactical.expectedImpact || 0)
      >= Number(baselineTactical.expectedImpact || 0) - 8000000
    && Number(candidateTactical.worstImpact || 0)
      >= Number(baselineTactical.worstImpact || 0) - 15000000;
}

function annotateAvoidableHomeShuffles(ranked, state = null, color = null) {
  ranked.forEach((candidate) => {
    const homeShuffleMoves = Math.max(
      0,
      Number(candidate.features.homeShuffleMoves) || 0,
    );
    if (!homeShuffleMoves) {
      candidate.features.avoidableHomeShuffleMoves = 0;
      return;
    }

    const alternatives = ranked.filter((other) => {
      const directReplacement = state && color
        ? isDirectLateHomeEntryReplacement(state, color, other, candidate)
        : false;
      return other !== candidate
      && Number(other.features.homeShuffleMoves || 0) < homeShuffleMoves
      && (directReplacement || (
        Number(other.features.outsideReduction || 0)
        >= Number(candidate.features.outsideReduction || 0)
      && Number(other.features.outsidePipGain || 0)
        >= Number(candidate.features.outsidePipGain || 0)
      && Number(other.features.trapDelta || 0)
        >= Number(candidate.features.trapDelta || 0)
      && Number(other.features.fenceClosureDelta || 0)
        >= Number(candidate.features.fenceClosureDelta || 0)
      && Number(other.features.escapeGatewayDelta || 0)
        >= Number(candidate.features.escapeGatewayDelta || 0)
      && Number(other.features.latentFenceExposureDelta || 0)
        >= Number(candidate.features.latentFenceExposureDelta || 0)
      && Number(other.features.routeTowerDelta || 0)
        >= Number(candidate.features.routeTowerDelta || 0)
      && Number(other.features.maxRouteTowerAfter || 0)
        <= Number(candidate.features.maxRouteTowerAfter || 0)
      && Number(other.features.headGain || 0)
        >= Number(candidate.features.headGain || 0)
      && Number(other.features.startZoneReduction || 0)
        >= Number(candidate.features.startZoneReduction || 0)
      && Number(other.features.primeRunAfter || 0)
        >= Number(candidate.features.primeRunAfter || 0)
      && Number(other.features.primeScoreAfter || 0)
        >= Number(candidate.features.primeScoreAfter || 0)
      && Number(other.features.opponentMoveBlockAfter || 0)
        >= Number(candidate.features.opponentMoveBlockAfter || 0)
      ));
    });
    const minimumNecessary = alternatives.length
      ? Math.min(...alternatives.map(other => Number(other.features.homeShuffleMoves) || 0))
      : homeShuffleMoves;
    candidate.features.avoidableHomeShuffleMoves = Math.max(
      0,
      homeShuffleMoves - minimumNecessary,
    );
  });
  return ranked;
}

function annotateAvoidableProspectiveFenceInterruptions(state, color, ranked) {
  ranked.forEach((candidate) => {
    const breakRisk = Math.max(
      0,
      Number(candidate.features.prospectiveFenceInterruptionBreak) || 0,
    );
    if (!breakRisk) {
      candidate.features.avoidableProspectiveFenceInterruptionBreak = 0;
      return;
    }

    const alternatives = ranked.filter(other => (
      other !== candidate
      && isAnalyzedProspectiveFenceInterruption(state, color, other, candidate)
    ));
    const minimumNecessary = alternatives.length
      ? Math.min(...alternatives.map(other => (
        Math.max(0, Number(other.features.prospectiveFenceInterruptionBreak) || 0)
      )))
      : breakRisk;
    candidate.features.avoidableProspectiveFenceInterruptionBreak = Math.max(
      0,
      breakRisk - minimumNecessary,
    );
  });
  return ranked;
}

function annotateAvoidableProspectiveFenceAnchorMisses(state, color, ranked) {
  ranked.forEach((candidate) => {
    if (homeReady(state, color)) {
      candidate.features.avoidableProspectiveFenceAnchorMiss = 0;
      return;
    }
    const alternatives = ranked.filter(other => (
      other !== candidate
      && isAnalyzedProspectiveFenceAnchorSafety(other, candidate)
    ));
    candidate.features.avoidableProspectiveFenceAnchorMiss = alternatives.length
      ? Math.max(...alternatives.map(other => Math.max(
        0,
        Number(candidate.features.prospectiveFenceExtensionAfter || 0)
          - Number(other.features.prospectiveFenceExtensionAfter || 0),
      )))
      : 0;
  });
  return ranked;
}

function isComparableFenceEscape(candidate, selected) {
  if (!candidate?.tactical || !selected?.tactical) return false;
  const experienceSafetyOverride = isExperienceOverruledFenceEscape(candidate, selected);
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 260000000
    && !isDeepFenceSafetyRegression(candidate, selected)
    && (
      Number(candidate.experienceAdjustment || 0) >= (
        Number(selected.experienceAdjustment || 0) - 500000
      )
      || experienceSafetyOverride
    )
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.expectedImpact) >= (
      Number(selected.tactical.expectedImpact) - 3000000
    )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - 30000000
    )
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.headLandingBreak || 0)
      <= Number(selected.features.headLandingBreak || 0) + 24;
}

function isDeepFenceSafetyRegression(candidate, selected) {
  const closureRegression = Number(selected.features.fenceClosureDelta || 0)
    - Number(candidate.features.fenceClosureDelta || 0);
  // A marginal utility gain cannot buy substantial closure damage when the
  // all-dice recovery or bounded continuation estimates also regress.
  return hasBoundedFourPlyTactical(candidate)
    && hasBoundedFourPlyTactical(selected)
    && closureRegression > 12
    && (
      Number(candidate.tactical.recoveryExpected || 0)
        < Number(selected.tactical.recoveryExpected || 0) - 12000000
      || Number(candidate.tactical.recoveryTailRisk || 0)
        < Number(selected.tactical.recoveryTailRisk || 0) - 12000000
      || Number(candidate.tactical.continuationWorst || 0)
        < Number(selected.tactical.continuationWorst || 0) - 5000000
      || Number(candidate.tactical.continuationTailRisk || 0)
        < Number(selected.tactical.continuationTailRisk || 0) - 5000000
    );
}

function hasCompleteThreePlyTactical(candidate) {
  const tactical = candidate?.tactical;
  return Boolean(tactical)
    && Number(tactical.plies || 0) >= 3
    && Number(tactical.rolls || 0) === 21
    && Number(tactical.distributionWeight || 0) === 36
    && tactical.distributionComplete === true
    && tactical.doublesExpanded === true
    && Number(tactical.recoveryRolls || 0) === 21
    && Number(tactical.recoveryWeight || 0) === 36
    && tactical.recoveryDistributionComplete === true
    && hasFiniteTacticalMetrics(candidate, [
      'expectedImpact',
      'worstImpact',
      'recoveryExpected',
      'recoveryWorst',
      'recoveryTailRisk',
    ]);
}

function hasBoundedFourPlyTactical(candidate) {
  const tactical = candidate?.tactical;
  // This is a valid representative/worst proxy model, not a claim that every
  // recovery board was expanded. Production envelopes use it conservatively.
  return hasCompleteThreePlyTactical(candidate)
    && Number(tactical.plies || 0) >= 4
    && Number(tactical.continuationRolls || 0) === 21
    && Number(tactical.continuationWeight || 0) === 36
    && tactical.continuationDistributionComplete === true
    && tactical.continuationModelComplete === true
    && tactical.continuationModelKind === 'representative-worst-proxy-v1'
    && typeof tactical.continuationApproximate === 'boolean'
    && tactical.continuationCoverageComplete === !tactical.continuationApproximate
    && Number(tactical.continuationFrontierCount || 0) >= 1
    && Number(tactical.continuationFrontierCount || 0) <= 2
    && Number(tactical.continuationTotalFrontierCount || 0)
      >= Number(tactical.continuationFrontierCount || 0)
    && Number(tactical.continuationTotalFrontierCount || 0) <= 21
    && Number(tactical.continuationFrontierWeight || 0) >= 1
    && Number(tactical.continuationFrontierWeight || 0) <= 36
    && Number(tactical.continuationTotalFrontierWeight || 0) === 36
    && Number(tactical.continuationProxyWeight || 0) === 36
    && tactical.continuationApproximate === (
      Number(tactical.continuationFrontierWeight || 0) !== 36
      || Number(tactical.continuationFrontierCount || 0)
        !== Number(tactical.continuationTotalFrontierCount || 0)
    )
    && Number(tactical.continuationWorstRecoveryFrontierWeight || 0) >= 1
    && tactical.continuationRepresentativeFrontierIncluded === true
    && tactical.continuationWorstFrontierIncluded === true
    && hasFiniteTacticalMetrics(candidate, [
      'continuationExpected',
      'continuationWorst',
      'continuationTailRisk',
    ]);
}

function hasCompleteFourPlyTactical(candidate) {
  const tactical = candidate?.tactical;
  return hasBoundedFourPlyTactical(candidate)
    && tactical.continuationApproximate === false
    && tactical.continuationCoverageComplete === true
    && Number(tactical.continuationFrontierWeight || 0) === 36
    && Number(tactical.continuationFrontierCount || 0)
      === Number(tactical.continuationTotalFrontierCount || 0);
}

function isExperienceOverruledFenceEscape(candidate, selected) {
  const requiredTacticalMetrics = [
    'plies',
    'expectedImpact',
    'worstImpact',
    'recoveryTailRisk',
    'recoveryWorst',
  ];
  if (
    !candidate?.tactical
    || !selected?.tactical
    || !hasFiniteTacticalMetrics(candidate, requiredTacticalMetrics)
    || !hasFiniteTacticalMetrics(selected, requiredTacticalMetrics)
  ) return false;
  return Number(candidate.features.fenceEscapeTacticalReservation || 0) > 0
    && Number(candidate.experienceAdjustment || 0)
      < Number(selected.experienceAdjustment || 0) - 500000
    && scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      > Number(selected.features.latentFenceExposureDelta || 0)
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.plies || 0) >= 4
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) + 10000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) + 30000000
    && Number(candidate.tactical.recoveryTailRisk || 0)
      >= Number(selected.tactical.recoveryTailRisk || 0)
    && Number(candidate.tactical.recoveryWorst || 0)
      >= Number(selected.tactical.recoveryWorst || 0);
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
  const fenceClosureDelta = Number(features.fenceClosureDelta || 0);
  const fenceClosureBefore = Number(features.fenceClosureBefore || 0);
  score += fenceClosureDelta * (fenceClosureBefore > 0 ? 950000 : 620000);
  if (fenceClosureDelta < 0) {
    score += fenceClosureDelta
      * (2400000 + Math.min(1800000, Number(features.trapBefore || 0) * 1100));
  }
  const escapeGatewayDelta = Number(features.escapeGatewayDelta || 0);
  if (escapeGatewayDelta < 0) {
    score += escapeGatewayDelta
      * (1300000 + Math.min(1700000, Number(features.trapBefore || 0) * 900));
  }
  const distributionDelta = Number(features.distributionDelta || 0);
  if (outside > 0 && distributionDelta < 0) {
    score += distributionDelta
      * (150000 + Math.min(180000, Number(features.trapBefore || 0) * 120));
  }
  const routeTowerDelta = Number(features.routeTowerDelta || 0);
  const fenceRun = Number(features.opponentFenceRunBefore || 0);
  if (outside > 0 && routeTowerDelta !== 0) {
    const towerScale = 18000
      + Math.max(0, fenceRun - 2) * 9000
      + Math.min(45000, Number(features.trapBefore || 0) * 20);
    score += routeTowerDelta * towerScale;
    if (routeTowerDelta < 0 && fenceRun >= 4) {
      score += routeTowerDelta * 75000;
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
  if (routeProgressPreservesDefense(state, color, features)) {
    score += Math.max(0, Number(features.laggardDebtDelta) || 0)
      * (155000 + developmentPressure(state, color) * 42000);
  }
  return score;
}


/* bot-engine/long/nardu-game-adapter.ts */
function createNarduGameAdapter(game) {
  return {
    legalSequences(state, color, options = {}) {
      if (!game?.bestMoveSequences) return [];
      const prepared = {
        ...state,
        turn: color || state.turn,
        phase: 'move',
      };
      const limit = Math.max(0, Number(options.limit) || 0);
      const sequences = limit > 0 && game.sampledMoveSequences
        ? game.sampledMoveSequences(prepared, color, limit)
        : game.bestMoveSequences(prepared, color);
      return sequences
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


const ENGINE_VERSION = 'long-analytic-v35';
// The build injects a noncircular SHA of every policy TS source, game rules
// and production dispatch/weights. Raw unbuilt modules fail closed.
const POLICY_IMPLEMENTATION_ID = typeof NARDU_LONG_BOT_POLICY_IMPLEMENTATION_ID === 'string'
  ? NARDU_LONG_BOT_POLICY_IMPLEMENTATION_ID : '';
const FROZEN_EXPERIENCE_PREFIX = 'narduh-long-bot-frozen-experience-v35:';
const LEGACY_FROZEN_EXPERIENCE_PREFIXES = [
  'narduh-long-bot-frozen-experience-v34:',
  'narduh-long-bot-frozen-experience-v33:',
  'narduh-long-bot-frozen-experience-v32:',
];
const PRODUCTION_RUNTIME_OPTIONS = Object.freeze({
  strategyProfile: 'v25',
  maxCandidates: 64,
  analysisNodeBudget: 480,
});

function createBrowserLongBotEngine(game, options = {}) {
  const adapter = createNarduGameAdapter(game);
  const engine = createLongBotEngine(adapter, options);
  const experienceStorage = Object.prototype.hasOwnProperty.call(options, 'experienceStorage')
    ? options.experienceStorage
    : safeSessionStorage();
  let lastDecision = null;
  let decisionSerial = 0;
  let experienceFrozen = false;
  let experienceSessionKey = '';
  const pendingExperienceSources = new Map();
  const appliedExperienceSources = new Map();

  const runtimeDefaults = {
    ...PRODUCTION_RUNTIME_OPTIONS,
    ...(options.runtimeDefaults || {}),
  };
  const effectiveRuntimeOptions = runtimeOptions => ({
    ...runtimeDefaults,
    ...(runtimeOptions || {}),
  });

  // Native rules/evaluation never read durable analysis/botMemory. Carrying it
  // through every JSON-cloned hypothetical board makes search cost grow with
  // the complete game ledger. Strip ONLY that field at this native boundary;
  // generic engines/custom adapters keep their original full-state contract.
  const searchState = state => {
    const projected = { ...state };
    delete projected.analysis;
    return projected;
  };
  const restoreRankMetadata = (state, ranked) => {
    if (!ranked.length || !Object.prototype.propertyIsEnumerable.call(state, 'analysis')) {
      return ranked;
    }
    // Preserve the historical JSON-clone semantics (including null, undefined,
    // toJSON), while never sharing durable metadata with the input or another
    // returned candidate. Serialize once, then create one independent copy per
    // public result; no hypothetical board contains this payload.
    const serialized = JSON.stringify({ analysis: state.analysis });
    ranked.forEach(candidate => {
      const metadata = JSON.parse(serialized);
      if (Object.prototype.hasOwnProperty.call(metadata, 'analysis')) {
        candidate.after.analysis = metadata.analysis;
      }
    });
    return ranked;
  };

  return {
    plan(state, runtimeOptions = {}) {
      // Never let a failed/empty ranking leak telemetry from the previous turn.
      lastDecision = null;
      const color = state?.turn;
      if (!state || (state.variant && state.variant !== 'long') || !color) return [];
      const effectiveOptions = effectiveRuntimeOptions(runtimeOptions);
      const ranked = engine.rank(searchState(state), color, effectiveOptions);
      const recorded = decisionRecord(
        state,
        color,
        ranked,
        effectiveOptions.weights,
        engine.experienceSize(),
        experienceSnapshot(),
        decisionSerial + 1,
        effectiveOptions,
      );
      if (recorded) {
        decisionSerial += 1;
        lastDecision = recorded;
      }
      return (ranked[0]?.sequence || []).map(move => ({ from: move.from, die: move.die }));
    },

    rank(state, runtimeOptions = {}) {
      lastDecision = null;
      const color = state?.turn;
      if (!state || (state.variant && state.variant !== 'long') || !color) return [];
      return restoreRankMetadata(
        state,
        engine.rank(searchState(state), color, effectiveRuntimeOptions(runtimeOptions)),
      );
    },

    describeSequence(state, sequence, runtimeOptions = {}) {
      const color = runtimeOptions.color || state?.turn;
      if (!state || !color || !Array.isArray(sequence) || !sequence.length) return null;
      return engine.describeSequence(
        searchState(state),
        sequence,
        color,
        effectiveRuntimeOptions(runtimeOptions),
      );
    },

    reviewSequenceStatic(state, sequence, runtimeOptions = {}) {
      const color = runtimeOptions.color || state?.turn;
      if (!state || !color || !Array.isArray(sequence) || !sequence.length) return null;
      const effectiveOptions = effectiveRuntimeOptions(runtimeOptions);
      const projected = searchState(state);
      const normalizedSequence = sequence.map(move => ({
        from: Number(move.from),
        die: Number(move.die),
        to: move.bearOff ? 0 : Number(move.to),
        bearOff: Boolean(move.bearOff || Number(move.to) === 0),
      }));
      const described = engine.describeSequence(
        projected,
        normalizedSequence,
        color,
        effectiveOptions,
      );
      if (!described) return null;
      const after = adapter.applySequence(projected, normalizedSequence, color);
      restoreRankMetadata(state, [{ after }]);
      return {
        sequence: normalizedSequence,
        after,
        score: engine.scoreSequence(
          projected,
          normalizedSequence,
          color,
          effectiveOptions.weights,
        ),
        scoreSemantics: 'long-static-evaluator-v1',
        scoreIncludesTacticalSearch: false,
        scoreIncludesExperience: false,
        features: described.features || {},
        experience: described.experience || null,
      };
    },

    evaluateState(state, color = state?.turn, weights = undefined) {
      if (!state || !color) return 0;
      return engine.evaluateState(state, color, weights);
    },

    setExperience(patterns, source = 'runtime') {
      const sourceKey = String(source || 'runtime');
      const snapshot = Array.isArray(patterns)
        ? patterns.filter(pattern => pattern?.creditVersion !== 9 || serverCausalPatterns([pattern]))
          .map(pattern => ({ ...pattern }))
        : [];
      if (experienceFrozen) {
        pendingExperienceSources.set(sourceKey, snapshot);
        return engine.experienceSize();
      }
      appliedExperienceSources.set(sourceKey, snapshot);
      return engine.setExperience(snapshot, sourceKey);
    },

    experienceSize() {
      return engine.experienceSize();
    },

    experienceSnapshotEntries() {
      return engine.experienceSnapshotEntries();
    },

    experienceReplaySnapshot() {
      const identity = experienceSnapshot();
      return {
        schema: 'long-experience-replay-v1',
        engineVersion: ENGINE_VERSION,
        fingerprint: identity.fingerprint,
        size: identity.size,
        frozen: identity.frozen,
        patterns: engine.experienceSnapshotPatterns(),
      };
    },

    beginExperienceSession(sessionKey = '') {
      const nextSessionKey = String(sessionKey || '');
      // Startup recovery can announce the same room more than once. Once its
      // evidence is frozen, reopening that identical session must be a no-op:
      // draining pending sources here would mix lessons fetched mid-game into
      // a decision stream that promises one immutable fingerprint.
      if (
        experienceFrozen
        && nextSessionKey
        && nextSessionKey === experienceSessionKey
      ) {
        return experienceSnapshot();
      }
      experienceFrozen = false;
      engine.setExperience([], 'frozen-session');
      // A restored policy belongs only to its original room. Clear its actual
      // source before applying the latest queued RPC snapshot for a new game.
      engine.setExperience([], 'frozen-session-quarantine');
      pendingExperienceSources.forEach((patterns, source) => {
        appliedExperienceSources.set(source, patterns);
        engine.setExperience(patterns, source);
      });
      pendingExperienceSources.clear();
      experienceSessionKey = nextSessionKey;
      if (restoreFrozenExperience()) experienceFrozen = true;
      return experienceSnapshot();
    },

    freezeExperience(sessionKey = experienceSessionKey) {
      experienceSessionKey = String(sessionKey || experienceSessionKey || '');
      experienceFrozen = true;
      persistFrozenExperience();
      return experienceSnapshot();
    },

    experienceSnapshot,

    consumeLastDecision() {
      const decision = lastDecision;
      lastDecision = null;
      return decision;
    },

    productionOptions: Object.freeze({ ...PRODUCTION_RUNTIME_OPTIONS }),
    version: ENGINE_VERSION,
    policyImplementationId: POLICY_IMPLEMENTATION_ID,
  };

  function experienceSnapshot() {
    const serialized = engine.experienceSnapshotEntries();
    const input = JSON.stringify(serialized);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return {
      fingerprint: `lbe8-${(hash >>> 0).toString(16).padStart(8, '0')}`,
      size: engine.experienceSize(),
      frozen: experienceFrozen,
      pendingSources: Array.from(pendingExperienceSources.keys()).sort(),
      pendingPatternCount: Array.from(pendingExperienceSources.values()).reduce(
        (total, patterns) => total + patterns.length,
        0,
      ),
    };
  }

  function frozenStorageKey() {
    return experienceSessionKey ? `${FROZEN_EXPERIENCE_PREFIX}${experienceSessionKey}` : '';
  }

  function restoreFrozenExperience() {
    const key = frozenStorageKey();
    if (!key || !experienceStorage?.getItem) return false;
    try {
      const saved = JSON.parse(experienceStorage.getItem(key) || 'null');
      if (saved?.engineVersion !== ENGINE_VERSION || !Array.isArray(saved.patterns)) return false;
      const emptyQuarantine = saved.trust === 'long-v35-quarantined-empty'
        && saved.patterns.length === 0;
      const serverSnapshot = saved.trust === 'long-v35-server-causal-session-v1'
        && serverCausalPatterns(saved.patterns);
      if (!emptyQuarantine && !serverSnapshot) return false;
      // A prefetch can settle before startup discovers the resumed session.
      // Its live sources must not merge into that game's immutable snapshot;
      // retain their latest payloads for the next session instead.
      appliedExperienceSources.forEach((patterns, source) => {
        if (!pendingExperienceSources.has(source)) {
          pendingExperienceSources.set(source, patterns);
        }
        engine.setExperience([], source);
      });
      appliedExperienceSources.clear();
      engine.setExperience(saved.patterns, 'frozen-session-quarantine');
      return true;
    } catch {
      return false;
    }
  }

  function persistFrozenExperience() {
    const key = frozenStorageKey();
    if (!key || !experienceStorage?.setItem) return false;
    try {
      for (let index = (Number(experienceStorage.length) || 0) - 1; index >= 0; index -= 1) {
        const storedKey = experienceStorage.key?.(index);
        if (
          storedKey !== key
          && (
            storedKey?.startsWith(FROZEN_EXPERIENCE_PREFIX)
            || LEGACY_FROZEN_EXPERIENCE_PREFIXES.some(prefix => storedKey?.startsWith(prefix))
          )
        ) {
          experienceStorage.removeItem?.(storedKey);
        }
      }
      const patterns = engine.experienceSnapshotPatterns();
      const trustedPatterns = serverCausalPatterns(patterns) ? patterns : [];
      experienceStorage.setItem(key, JSON.stringify({
        engineVersion: ENGINE_VERSION,
        // Resume the same immutable server-fed policy, not a newer network
        // snapshot. This session cache is not evidence of server provenance:
        // the causal worker still rejects nonempty unsigned recursive memory.
        trust: trustedPatterns.length
          ? 'long-v35-server-causal-session-v1'
          : 'long-v35-quarantined-empty',
        patterns: trustedPatterns,
      }));
      return true;
    } catch {
      return false;
    }
  }
}

function serverCausalPatterns(patterns) {
  return /^[0-9a-f]{64}$/.test(POLICY_IMPLEMENTATION_ID)
    && Array.isArray(patterns) && patterns.length <= 256 && patterns.every(pattern => (
    pattern?.creditVersion === 9
    && pattern?.evidenceSchema === 'long-server-causal-pattern-v1'
    && pattern?.reviewerVersion === 'long-server-causal-review-v1'
    && pattern?.trustDomain === 'nardu/server-long-bot-causal/v1'
    && pattern?.policyImplementationId === POLICY_IMPLEMENTATION_ID
    && pattern?.outcomeUsed === false
    && /^[0-9a-f]{64}$/.test(String(pattern.runtimeDigest || ''))
    && /^[0-9a-f]{64}$/.test(String(pattern.aggregateId || ''))
    && Number.isInteger(pattern.samples) && pattern.samples >= 1 && pattern.samples <= 32
    && pattern.losses === pattern.samples && pattern.wins === 0
    && pattern.lossWeight === pattern.samples * 1.5
    && pattern.signalWeight === pattern.samples * 1.5
    && pattern.severeLosses === 0 && pattern.winWeight === 0
  ));
}

function safeSessionStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function decisionRecord(
  state,
  color,
  ranked,
  weights = undefined,
  experienceSize = 0,
  experienceSnapshot = null,
  serial = 1,
  runtimeOptions = {},
) {
  const choiceCount = Math.max(
    1,
    ...ranked.map(candidate => Number(candidate.features?.choiceCount) || 0),
  );
  const uniqueRanked = [];
  const seenPositions = new Set();
  ranked.forEach((candidate) => {
    const key = decisionCandidatePositionKey(candidate);
    if (seenPositions.has(key)) return;
    seenPositions.add(key);
    uniqueRanked.push(candidate);
  });
  const candidates = uniqueRanked.slice(0, 4).map(candidate => ({
    score: Math.round(candidate.score),
    moves: candidate.sequence.map(move => ({
      from: move.from,
      to: move.bearOff ? 0 : move.to,
      die: move.die,
    })),
    after: compactCandidateState(candidate.after),
    features: { ...(candidate.features || {}) },
    tactical: candidate.tactical ? {
      expectedImpact: Math.round(candidate.tactical.expectedImpact),
      worstImpact: Math.round(candidate.tactical.worstImpact),
      rolls: candidate.tactical.rolls,
      distributionWeight: Number(candidate.tactical.distributionWeight) || 0,
      distributionComplete: Boolean(candidate.tactical.distributionComplete),
      adjustment: Math.round(candidate.tactical.adjustment),
      recoveryExpected: Math.round(Number(candidate.tactical.recoveryExpected) || 0),
      recoveryWorst: Math.round(Number(candidate.tactical.recoveryWorst) || 0),
      recoveryRolls: Number(candidate.tactical.recoveryRolls) || 0,
      recoveryTailRisk: Math.round(Number(candidate.tactical.recoveryTailRisk) || 0),
      recoveryTailWeight: Number(candidate.tactical.recoveryTailWeight) || 0,
      recoveryWeight: Number(candidate.tactical.recoveryWeight) || 0,
      recoveryDistributionComplete: Boolean(candidate.tactical.recoveryDistributionComplete),
      recoveryModelKind: String(candidate.tactical.recoveryModelKind || ''),
      recoveryConditional: Boolean(candidate.tactical.recoveryConditional),
      recoveryPrimaryDiceKey: String(candidate.tactical.recoveryPrimaryDiceKey || ''),
      recoveryPrimaryDiceWeight: Number(candidate.tactical.recoveryPrimaryDiceWeight) || 0,
      recoveryPrimaryFrontierCount: Number(candidate.tactical.recoveryPrimaryFrontierCount) || 0,
      recoveryTotalPrimaryFrontierCount: Number(candidate.tactical.recoveryTotalPrimaryFrontierCount) || 0,
      recoveryPrimaryFrontierWeight: Number(candidate.tactical.recoveryPrimaryFrontierWeight) || 0,
      recoveryTotalPrimaryFrontierWeight: Number(candidate.tactical.recoveryTotalPrimaryFrontierWeight) || 0,
      deepAdjustment: Math.round(Number(candidate.tactical.deepAdjustment) || 0),
      continuationExpected: Math.round(Number(candidate.tactical.continuationExpected) || 0),
      continuationWorst: Math.round(Number(candidate.tactical.continuationWorst) || 0),
      continuationRolls: Number(candidate.tactical.continuationRolls) || 0,
      continuationTailRisk: Math.round(Number(candidate.tactical.continuationTailRisk) || 0),
      continuationTailWeight: Number(candidate.tactical.continuationTailWeight) || 0,
      continuationWeight: Number(candidate.tactical.continuationWeight) || 0,
      continuationDistributionComplete: Boolean(candidate.tactical.continuationDistributionComplete),
      continuationModelComplete: Boolean(candidate.tactical.continuationModelComplete),
      continuationModelKind: String(candidate.tactical.continuationModelKind || ''),
      continuationApproximate: candidate.tactical.continuationApproximate !== false,
      continuationCoverageComplete: Boolean(candidate.tactical.continuationCoverageComplete),
      continuationFrontierCount: Number(candidate.tactical.continuationFrontierCount) || 0,
      continuationFrontierWeight: Number(candidate.tactical.continuationFrontierWeight) || 0,
      continuationTotalFrontierCount: Number(candidate.tactical.continuationTotalFrontierCount) || 0,
      continuationTotalFrontierWeight: Number(candidate.tactical.continuationTotalFrontierWeight) || 0,
      continuationProxyWeight: Number(candidate.tactical.continuationProxyWeight) || 0,
      continuationWorstRecoveryFrontierWeight: Number(
        candidate.tactical.continuationWorstRecoveryFrontierWeight
      ) || 0,
      continuationRepresentativeDiceKey: String(candidate.tactical.continuationRepresentativeDiceKey || ''),
      continuationRepresentativeDiceWeight: Number(candidate.tactical.continuationRepresentativeDiceWeight) || 0,
      continuationRepresentativeProxyWeight: Number(candidate.tactical.continuationRepresentativeProxyWeight) || 0,
      continuationWorstRecoveryDiceKey: String(candidate.tactical.continuationWorstRecoveryDiceKey || ''),
      continuationWorstRecoveryDiceWeight: Number(candidate.tactical.continuationWorstRecoveryDiceWeight) || 0,
      continuationWorstRecoveryProxyWeight: Number(candidate.tactical.continuationWorstRecoveryProxyWeight) || 0,
      continuationRepresentativeFrontierIncluded: Boolean(
        candidate.tactical.continuationRepresentativeFrontierIncluded
      ),
      continuationWorstFrontierIncluded: Boolean(
        candidate.tactical.continuationWorstFrontierIncluded
      ),
      continuationAdjustment: Math.round(Number(candidate.tactical.continuationAdjustment) || 0),
      blockedProbability: Number(candidate.tactical.blockedProbability) || 0,
      expectedReplySequences: Number(candidate.tactical.expectedReplySequences) || 0,
      expectedOpponentPipGain: Number(candidate.tactical.expectedOpponentPipGain) || 0,
      expectedOpponentHeadRelease: Number(candidate.tactical.expectedOpponentHeadRelease) || 0,
      expectedOpponentOutsideReduction: Number(candidate.tactical.expectedOpponentOutsideReduction) || 0,
      doublesExpanded: Boolean(candidate.tactical.doublesExpanded),
      replyCoverageExpanded: Boolean(candidate.tactical.replyCoverageExpanded),
      plies: Number(candidate.tactical.plies) || 2,
    } : null,
    experience: candidate.experience ? { ...candidate.experience } : null,
    experienceAdjustment: Math.round(Number(candidate.experienceAdjustment) || 0),
  }));
  if (!candidates.length) return null;

  const positionId = positionFingerprint(state, color);
  const stateSnapshotV2 = longStateSnapshotV2(state, color);
  const stateFingerprintV2 = snapshotFingerprintV2(stateSnapshotV2);
  const rankingCandidateCount = uniqueRanked.length;
  return {
    id: `${positionId}-${Date.now().toString(36)}-${String(Math.max(1, Number(serial) || 1)).padStart(4, '0')}`,
    positionId,
    source: 'engine',
    at: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    choiceCount,
    experienceSize: Math.max(0, Number(experienceSize) || 0),
    experienceFingerprint: String(experienceSnapshot?.fingerprint || ''),
    experienceFrozen: Boolean(experienceSnapshot?.frozen),
    stateSnapshotV2,
    stateFingerprintV2,
    replayInput: {
      schema: 'long-shadow-replay-input-v1',
      stateFingerprintV2,
      engineVersion: ENGINE_VERSION,
      experienceFingerprint: String(experienceSnapshot?.fingerprint || ''),
      experienceSize: Math.max(0, Number(experienceSize) || 0),
      experienceFrozen: Boolean(experienceSnapshot?.frozen),
      runtime: compactRuntimeOptions(runtimeOptions),
      // Only the displayed top candidates are archived here. A reviewer must
      // rebuild the complete candidate cohort from stateSnapshotV2 and must
      // not mistake this bounded preview for complete counterfactual proof.
      archivedCandidateCount: candidates.length,
      rankingCandidateCount,
      archivedCandidatesComplete: candidates.length === rankingCandidateCount,
    },
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

function compactRuntimeOptions(runtimeOptions = {}) {
  const compact = {
    strategyProfile: String(runtimeOptions.strategyProfile || ''),
    maxCandidates: Math.max(0, Number(runtimeOptions.maxCandidates) || 0),
    analysisNodeBudget: Math.max(0, Number(runtimeOptions.analysisNodeBudget) || 0),
  };
  if (runtimeOptions.weights && typeof runtimeOptions.weights === 'object') {
    compact.weights = Object.fromEntries(
      Object.entries(runtimeOptions.weights)
        .map(([key, value]) => [key, Number(value)])
        .filter(([, value]) => Number.isFinite(value)),
    );
  }
  return compact;
}

function compactPoints(points = {}) {
  return Object.fromEntries(
    Object.entries(points)
      .filter(([, stack]) => stack && Number(stack.count) > 0)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([point, stack]) => [point, {
        color: String(stack.color || ''),
        count: Number(stack.count) || 0,
      }]),
  );
}

function compactCandidateState(state = {}) {
  return {
    points: compactPoints(state.points),
    bar: {
      white: Number(state.bar?.white) || 0,
      dark: Number(state.bar?.dark) || 0,
    },
    off: {
      white: Number(state.off?.white) || 0,
      dark: Number(state.off?.dark) || 0,
    },
  };
}

function longStateSnapshotV2(state = {}, color = state.turn) {
  return {
    schema: 'long-state-v2',
    variant: 'long',
    phase: String(state.phase || 'move'),
    turn: String(color || state.turn || ''),
    points: compactPoints(state.points),
    bar: {
      white: Number(state.bar?.white) || 0,
      dark: Number(state.bar?.dark) || 0,
    },
    off: {
      white: Number(state.off?.white) || 0,
      dark: Number(state.off?.dark) || 0,
    },
    dice: (state.dice || []).map(value => Number(value) || 0),
    rolled: (state.rolled || []).map(value => Number(value) || 0),
    firstMoveDone: {
      white: Boolean(state.firstMoveDone?.white),
      dark: Boolean(state.firstMoveDone?.dark),
    },
    headPlayedThisTurn: {
      white: Boolean(state.headPlayedThisTurn?.white),
      dark: Boolean(state.headPlayedThisTurn?.dark),
    },
    turnMoves: (state.turnMoves || []).map(move => ({
      color: String(move.color || ''),
      from: Number(move.from) || 0,
      to: move.bearOff || Number(move.to) === 0 ? 0 : Number(move.to) || 0,
      die: Number(move.die) || 0,
      bearOff: Boolean(move.bearOff || Number(move.to) === 0),
    })),
  };
}

function snapshotFingerprintV2(snapshot) {
  const input = stableStringify(snapshot || {});
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `lbs2-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

function decisionCandidatePositionKey(candidate) {
  const points = Object.entries(candidate?.after?.points || {})
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([point, stack]) => `${point}:${stack.color}:${stack.count}`)
    .join('|');
  return `${points}|bar:${Number(candidate?.after?.bar?.white) || 0}:${Number(candidate?.after?.bar?.dark) || 0}|off:${Number(candidate?.after?.off?.white) || 0}:${Number(candidate?.after?.off?.dark) || 0}`;
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
