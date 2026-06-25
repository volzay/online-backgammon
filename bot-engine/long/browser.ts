import { createLongBotEngine } from './engine.ts';
import { createNarduGameAdapter } from './nardu-game-adapter.ts';

export function createBrowserLongBotEngine(game, options = {}) {
  const adapter = createNarduGameAdapter(game);
  const engine = createLongBotEngine(adapter, options);

  return {
    plan(state, runtimeOptions = {}) {
      const color = state?.turn;
      if (!state || (state.variant && state.variant !== 'long') || !color) return [];
      return engine.plan(state, color, runtimeOptions);
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
  };
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
