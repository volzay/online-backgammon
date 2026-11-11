'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { clearRuntimeCache, loadRuntime, canonicalMoveKey } = require('../scripts/generate-long-bot-shadow-replay');

test('a published lesson changes an eligible native decision in the next round', async () => {
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
  let published = [];
  const signedRounds = new Map();
  const values = new Map();
  const context = { window: { NarduLongBotEngine: engine,
    NarduSupabase: { configured: () => true, client: async () => ({
      rpc: async (name, args) => {
        assert.equal(name, 'load_signed_long_bot_experience');
        assert.equal(args.p_policy_implementation_id, engine.policyImplementationId);
        assert.equal(args.p_room_code, 'TEST-ROOM');
        const round = args.p_round_started_at;
        assert.ok(Number.isSafeInteger(round));
        if (!signedRounds.has(round)) signedRounds.set(round, published);
        return { data: { policyImplementationId: engine.policyImplementationId, patterns: signedRounds.get(round) },
          error: null };
      },
    }) } },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    Date, Math, JSON, Map, Uint8Array, TextEncoder, fetch, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../rooms-client.js'), 'utf8'), context);
  try {
    const fetchLatest = roundStartedAt => context.window.NarduRooms.loadLongBotExperience({
      playerName: 'Synthetic contract test', refresh: true,
      signedRound: { roomCode: 'TEST-ROOM', roundStartedAt },
    });
    const firstRound = 1789689600000;
    const secondRound = firstRound + 1000;
    engine.beginExperienceSession('synthetic-round-1');
    assert.equal((await fetchLatest(firstRound)).length, 0);
    engine.freezeExperience('synthetic-round-1');

    published = [pattern];
    assert.equal((await fetchLatest(firstRound)).length, 0);
    assert.equal(engine.experienceSize(), 0);
    assert.equal(canonicalMoveKey(engine.rank(state, options)[0].sequence), canonicalMoveKey(cold.sequence));

    engine.beginExperienceSession('synthetic-round-2');
    assert.equal((await fetchLatest(secondRound)).length, 1);
    engine.freezeExperience('synthetic-round-2');
    assert.equal(engine.experienceSize(), 1);
    const learned = engine.rank(state, options);
    const penalized = learned.find(candidate => candidate.experience.contextKey === pattern.contextKey
      && candidate.experience.actionKey === pattern.actionKey);
    assert.ok(penalized.experienceAdjustment < 0);
    assert.notEqual(canonicalMoveKey(learned[0].sequence), canonicalMoveKey(cold.sequence));
    assert.equal(learned[0].features.experienceSafetyRejected || 0, 0);
    engine.plan(state, options);
    const decision = engine.consumeLastDecision();
    assert.equal(decision.experienceSize, 1);
    assert.equal(decision.experienceFrozen, true);
    assert.equal(canonicalMoveKey(decision.selected.moves), canonicalMoveKey(learned[0].sequence));
  } finally { clearRuntimeCache(); }
});
