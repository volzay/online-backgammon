import type { LongBotColor, LongBotState } from './types.ts';

export const LONG_PATHS = {
  white: [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  dark: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13],
};

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

export function headLandingSupportScore(state, color) {
  const head = headPoint(color);
  const headCount = countAt(state, head, color);
  if (headCount <= 2) return 0;
  const importantDice = [1, 3, 5, 6];
  const pressure = 1 + Math.max(0, headCount - 4) / 5;

  return importantDice.reduce((score, die) => {
    const target = pathFor(color)[die];
    const stack = target ? stackAt(state, target) : null;
    const dieWeight = die === 1 || die === 3 || die === 5 ? 1.45 : 1.2;
    if (stack?.color === color) {
      const made = stack.count >= 2 ? 1.9 : 0.9;
      const stackPenalty = Math.max(0, stack.count - 3) * 0.42;
      return score + dieWeight * Math.max(0.3, made - stackPenalty);
    }
    if (!stack) return score - dieWeight * 0.75;
    return score - dieWeight * 1.8;
  }, 0) * pressure;
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

  return risk;
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
