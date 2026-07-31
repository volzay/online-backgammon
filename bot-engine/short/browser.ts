const SHORT_ENGINE_VERSION = 'short-analytic-v2';

export function createBrowserShortBotEngine(game, options = {}) {
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

export function installBrowserShortBotEngine(root = globalThis) {
  if (!root?.NarduGame) return null;
  const api = createBrowserShortBotEngine(root.NarduGame);
  root.NarduShortBotEngine = api;
  return api;
}

if (typeof window !== 'undefined') installBrowserShortBotEngine(window);
