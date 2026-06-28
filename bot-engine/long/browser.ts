import { createLongBotEngine } from './engine.ts';
import { createNarduGameAdapter } from './nardu-game-adapter.ts';

const ENGINE_VERSION = 'long-linear-v4';

export function createBrowserLongBotEngine(game, options = {}) {
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
  return `lb3-${(hash >>> 0).toString(16).padStart(8, '0')}`;
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
