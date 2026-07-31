export function shortMetrics(state, color) {
  const opponent = NarduGame.opponentOf(color);
  const path = NarduGame.pathFor(color, state);
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
        anchorValue += 7 - pos;
      }
    } else {
      run = 0;
      blots += 1;
      exposure += blotRisk(state, color, point, pos);
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
  };
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
