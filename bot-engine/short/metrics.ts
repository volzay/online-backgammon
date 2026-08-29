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

export function shortPubevalScore(state, color, phaseHint = '') {
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

export function shortMetrics(state, color) {
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

export function blotRisk(state, color, point, pos = NarduGame.pathPos(color, point, state)) {
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

export function shortPhase(state, color) {
  const opponent = NarduGame.opponentOf(color);
  if ((state.bar?.[color] || 0) > 0 || (state.bar?.[opponent] || 0) > 0) return 'bar';
  if (shortHasContact(state, color)) return 'contact';
  if (NarduGame.homeReady(state, color)) return 'bearoff';
  return 'race';
}

export function shortHasContact(state, color) {
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
