const SHORT_ENGINE_VERSION = 'short-analytic-v5';

export function shortStateToWildbgBoard(game, state, color = state?.turn) {
  if (!game || !state || state.variant !== 'short' || !color) return null;
  const opponent = game.opponentOf(color);
  const board = new Int8Array(26);
  Object.entries(state.points || {}).forEach(([rawPoint, stack]) => {
    const point = Number(rawPoint);
    const pathPosition = game.pathPos(color, point, state);
    const count = Number(stack?.count) || 0;
    if (pathPosition < 0 || pathPosition > 23 || count < 1) return;
    board[24 - pathPosition] = stack.color === color ? count : -count;
  });
  board[25] = Number(state.bar?.[color]) || 0;
  board[0] = -(Number(state.bar?.[opponent]) || 0);
  return board;
}

export function prepareShortWildbgRequest(game, state, color = state?.turn) {
  if (!state || state.variant !== 'short' || !color) return null;
  const dice = (state.dice || []).map(Number);
  const isDouble = dice.length === 4 && dice.every(die => die === dice[0]);
  if ((!isDouble && dice.length !== 2)
    || dice.slice(0, 2).some(die => !Number.isInteger(die) || die < 1 || die > 6)) {
    return null;
  }
  const board = shortStateToWildbgBoard(game, state, color);
  return board ? {
    board,
    die1: dice[0],
    die2: dice[1],
    // The product distinguishes normal, Mars (gammon), and Koks
    // (backgammon) results. Money-game equity preserves those different
    // values; one-pointer scoring deliberately treats them as equal.
    isOnePointer: false,
  } : null;
}

function shortWildbgPlayForSequence(game, adapter, state, color, sequence) {
  let preview = JSON.parse(JSON.stringify(state || {}));
  const play = [];
  (sequence || []).forEach(move => {
    const from = Number(move.from) === game.barPoint(color)
      ? 25
      : 24 - game.pathPos(color, Number(move.from), preview);
    const to = move.bearOff || Number(move.to) === 0
      ? 0
      : 24 - game.pathPos(color, Number(move.to), preview);
    play.push({ from, to });
    preview = adapter.applySequence(preview, [move], color);
  });
  return {
    play,
    position: shortStateToWildbgBoard(game, preview, color),
  };
}

function validWildbgPlay(play) {
  return Array.isArray(play) && play.length > 0 && play.length <= 4 && play.every(step => (
    Number.isInteger(Number(step?.from))
    && Number(step.from) >= 1
    && Number(step.from) <= 25
    && Number.isInteger(Number(step?.to))
    && Number(step.to) >= 0
    && Number(step.to) <= 24
    && Number(step.from) > Number(step.to)
  ));
}

function validWildbgPosition(position) {
  return position && typeof position.length === 'number' && position.length === 26
    && Array.from(position).every(value => Number.isInteger(Number(value))
      && Number(value) >= -15 && Number(value) <= 15);
}

function sameWildbgPlay(left, right) {
  return left.length === right.length && left.every((step, index) => (
    Number(step.from) === Number(right[index]?.from)
    && Number(step.to) === Number(right[index]?.to)
  ));
}

function sameWildbgPosition(left, right) {
  return left && right && left.length === right.length
    && Array.from(left).every((value, index) => Number(value) === Number(right[index]));
}

export function matchShortWildbgAnalysis(game, state, analysis, color = state?.turn, adapter = null) {
  const best = analysis?.moves?.[0];
  if (!game || !state || state.variant !== 'short' || !color || !validWildbgPlay(best?.play)) {
    return null;
  }
  const rules = adapter || createShortNarduGameAdapter(game);
  const candidates = rules.legalSequences(state, color, { limit: 0 }).map(sequence => ({
    sequence,
    ...shortWildbgPlayForSequence(game, rules, state, color, sequence),
  }));
  const hasPosition = Object.prototype.hasOwnProperty.call(best, 'position');
  if (hasPosition && !validWildbgPosition(best.position)) return null;
  const exact = candidates.find(candidate => sameWildbgPlay(candidate.play, best.play));
  if (exact) {
    if (hasPosition && !sameWildbgPosition(exact.position, best.position)) return null;
    return { ...exact, match: 'play', analysis: best, phase: analysis.phase || null };
  }
  if (!hasPosition) return null;
  const byPosition = candidates.find(candidate => sameWildbgPosition(candidate.position, best.position));
  return byPosition
    ? { ...byPosition, match: 'position', analysis: best, phase: analysis.phase || null }
    : null;
}

export function createBrowserShortBotEngine(game, options = {}) {
  const adapter = createShortNarduGameAdapter(game);
  const engine = createShortBotEngine(adapter, options);
  let lastDecision = null;

  function analyzer() {
    return options.getWildbgAnalyzer?.() || options.wildbgAnalyzer || null;
  }

  function recordWildbgDecision(state, color, matched) {
    const described = engine.describeSequence(state, matched.sequence, color);
    const decision = shortDecisionRecord(state, color, [described], engine.experienceSize());
    if (!decision) return null;
    decision.engine = {
      name: 'wildbg',
      provenance: 'wildbg-wasm',
      match: matched.match,
      phase: matched.phase,
      equity: Number.isFinite(Number(matched.analysis?.equity))
        ? Number(matched.analysis.equity)
        : null,
      score: Number.isFinite(Number(matched.analysis?.score))
        ? Number(matched.analysis.score)
        : null,
    };
    return decision;
  }

  function planFromWildbgAnalysis(state, analysis) {
    const color = state?.turn;
    const matched = matchShortWildbgAnalysis(game, state, analysis, color, adapter);
    if (!matched) return null;
    lastDecision = recordWildbgDecision(state, color, matched);
    return matched.sequence.map(move => ({ from: move.from, die: move.die }));
  }

  function analyticPlan(state, runtimeOptions, wildbgFailure = '') {
    const color = state.turn;
    const ranked = engine.rank(state, color, runtimeOptions);
    lastDecision = shortDecisionRecord(state, color, ranked, engine.experienceSize());
    if (lastDecision) {
      lastDecision.engine = {
        name: 'short-analytic',
        provenance: wildbgFailure ? 'builtin-fallback' : 'builtin',
        wildbgFailure: wildbgFailure || null,
      };
    }
    return (ranked[0]?.sequence || []).map(move => ({ from: move.from, die: move.die }));
  }

  return {
    plan(state, runtimeOptions = {}) {
      const color = state?.turn;
      if (!state || state.variant !== 'short' || !color) return [];
      const request = prepareShortWildbgRequest(game, state, color);
      const wildbg = analyzer();
      if (request && typeof wildbg?.analyze === 'function') {
        try {
          const analysis = wildbg.analyze(
            request.board,
            request.die1,
            request.die2,
            request.isOnePointer,
          );
          if (!analysis || typeof analysis.then === 'function') {
            return analyticPlan(state, runtimeOptions, 'async-or-empty-analysis');
          }
          const plan = planFromWildbgAnalysis(state, analysis);
          if (plan) return plan;
          return analyticPlan(state, runtimeOptions, 'illegal-or-unmatched-analysis');
        } catch (error) {
          return analyticPlan(state, runtimeOptions, `analysis-error:${error?.message || error}`);
        }
      }
      return analyticPlan(state, runtimeOptions);
    },
    prepareWildbgRequest(state) {
      return prepareShortWildbgRequest(game, state, state?.turn);
    },
    planFromWildbgAnalysis,
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

export function installBrowserShortBotEngine(root = globalThis) {
  if (!root?.NarduGame) return null;
  const api = createBrowserShortBotEngine(root.NarduGame, {
    getWildbgAnalyzer: () => root.NarduWildbgAnalyzer,
  });
  root.NarduShortBotEngine = api;
  return api;
}

if (typeof window !== 'undefined') installBrowserShortBotEngine(window);
