'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { clearRuntimeCache, loadRuntime, canonicalMoveKey } = require('../scripts/generate-long-bot-shadow-replay');

test('one RPC aggregate changes an eligible native decision, not merely the experience counter', async () => {
  // Contract fixture only, NOT a claimed real regret or training observation.
  // Board from H7VV-VWUS; the mocked aggregate deliberately penalizes one
  // action so the entire RPC -> validation -> engine -> choice path is tested.
  clearRuntimeCache();
  const { game, engine } = loadRuntime();
  const state = game.initialState('long');
  Object.assign(state, { phase: 'move', turn: 'dark', dice: [3, 4], rolled: [3, 4],
    points: { 2: { color: 'white', count: 2 }, 6: { color: 'white', count: 1 },
      14: { color: 'dark', count: 3 }, 16: { color: 'dark', count: 3 }, 17: { color: 'dark', count: 3 } },
    off: { white: 12, dark: 6 }, firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false } });
  const options = { ...engine.productionOptions };
  const cold = engine.rank(state, options)[0];
  const pattern = { creditVersion: 9, evidenceSchema: 'long-server-causal-pattern-v1',
    reviewerVersion: 'long-server-causal-review-v1', trustDomain: 'nardu/server-long-bot-causal/v1',
    runtimeDigest: 'a'.repeat(64), aggregateId: 'b'.repeat(64),
    policyImplementationId: engine.policyImplementationId,
    contextKey: cold.experience.contextKey, actionKey: cold.experience.actionKey,
    samples: 1, losses: 1, wins: 0, lossWeight: 1.5, signalWeight: 1.5,
    severeLosses: 0, winWeight: 0, outcomeUsed: false };
  const values = new Map();
  const context = { window: { NarduLongBotEngine: engine,
    NarduSupabase: { configured: () => true, client: async () => ({
      rpc: async name => {
        assert.equal(name, 'get_long_bot_experience_patterns');
        return { data: [pattern], error: null };
      },
    }) } },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    Date, Math, JSON, Map, Uint8Array, TextEncoder, fetch, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../rooms-client.js'), 'utf8'), context);
  try {
    const loaded = await context.window.NarduRooms.loadLongBotExperience({ playerName: 'Synthetic contract test' });
    assert.equal(loaded.length, 1);
    assert.equal(engine.experienceSize(), 1);
    const learned = engine.rank(state, options);
    const penalized = learned.find(candidate => candidate.experience.contextKey === pattern.contextKey
      && candidate.experience.actionKey === pattern.actionKey);
    assert.ok(penalized.experienceAdjustment < 0);
    assert.notEqual(canonicalMoveKey(learned[0].sequence), canonicalMoveKey(cold.sequence));
    assert.equal(learned[0].features.experienceSafetyRejected || 0, 0);
    engine.freezeExperience('synthetic-consumption-only');
    engine.plan(state, options);
    const decision = engine.consumeLastDecision();
    assert.equal(decision.experienceSize, 1);
    assert.equal(decision.experienceFrozen, true);
    assert.equal(canonicalMoveKey(decision.selected.moves), canonicalMoveKey(learned[0].sequence));
  } finally { clearRuntimeCache(); }
});
