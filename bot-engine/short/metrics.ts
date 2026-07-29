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

  path.forEach((point, pos) => {
    const stack = state.points?.[point];
    if (stack?.color !== color) {
      run = 0;
      return;
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
  if (NarduGame.homeReady(state, color)) return 'bearoff';
  const own = shortMetrics(state, color);
  const other = shortMetrics(state, opponent);
  if (own.exposure || other.exposure || own.anchors || other.anchors) return 'contact';
  return 'race';
}

