import { createLongBotEngine } from './engine.ts';
import { createNarduGameAdapter } from './nardu-game-adapter.ts';

const ENGINE_VERSION = 'long-analytic-v15';

export function createBrowserLongBotEngine(game, options = {}) {
  const adapter = createNarduGameAdapter(game);
  const engine = createLongBotEngine(adapter, options);
  let lastDecision = null;

  return {
    plan(state, runtimeOptions = {}) {
      const color = state?.turn;
      if (!state || (state.variant && state.variant !== 'long') || !color) return [];
      const ranked = engine.rank(state, color, runtimeOptions);
      lastDecision = decisionRecord(
        state,
        color,
        ranked,
        runtimeOptions.weights,
        engine.experienceSize(),
      );
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

function decisionRecord(state, color, ranked, weights = undefined, experienceSize = 0) {
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
      recoveryExpected: Math.round(Number(candidate.tactical.recoveryExpected) || 0),
      recoveryWorst: Math.round(Number(candidate.tactical.recoveryWorst) || 0),
      recoveryRolls: Number(candidate.tactical.recoveryRolls) || 0,
      deepAdjustment: Math.round(Number(candidate.tactical.deepAdjustment) || 0),
      continuationExpected: Math.round(Number(candidate.tactical.continuationExpected) || 0),
      continuationWorst: Math.round(Number(candidate.tactical.continuationWorst) || 0),
      continuationRolls: Number(candidate.tactical.continuationRolls) || 0,
      continuationAdjustment: Math.round(Number(candidate.tactical.continuationAdjustment) || 0),
      plies: Number(candidate.tactical.plies) || 2,
    } : null,
    experience: candidate.experience ? { ...candidate.experience } : null,
    experienceAdjustment: Math.round(Number(candidate.experienceAdjustment) || 0),
  }));
  if (!candidates.length) return null;

  return {
    id: positionFingerprint(state, color),
    at: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    experienceSize: Math.max(0, Number(experienceSize) || 0),
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

export function installBrowserLongBotEngine(root = globalThis) {
  const game = root?.NarduGame;
  if (!game) return null;
  const api = createBrowserLongBotEngine(game);
  root.NarduLongBotEngine = api;
  return api;
}

if (typeof window !== 'undefined') {
  installBrowserLongBotEngine(window);
}
