'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');

function storage() {
  const values = new Map();
  return { get length() { return values.size; }, key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.get(key) || null; }, setItem(key, value) { values.set(key, String(value)); }, removeItem(key) { values.delete(key); } };
}
function harness({ model = true, localStorage = storage(), difficulty = 'hard-neuro', variant = 'long' } = {}) {
  const pending = new Map(); let timerId = 0;
  const calls = { fallback: 0, experience: 0, animations: [], warns: [] };
  const setTimer = (callback, ms) => { const id = ++timerId; pending.set(id, { callback, ms }); return id; };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [1789732800000])); } static now() { return 1789732800000; } }
  const math = Object.create(Math); math.random = () => { throw new Error('Unexpected RNG in neural turn'); };
  const window = {
    addEventListener() {}, setTimeout: setTimer,
    NarduFairDiceCrypto: { hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); } },
    NarduApp: { getUser: () => ({ id: 'neural-controller-user', name: 'Tester', guest: false }), paintUser() {}, formatRating: () => '1500' },
    NarduSound: { prime() {}, move() {}, bearOff() {}, click() {}, dice() {}, win() {}, lose() {} },
    NarduBoardEngine: { animateCheckerMove: async input => { calls.animations.push(plain(input)); } },
  };
  const context = { window, Date: FixedDate, Math: math, JSON, URL, Uint8Array, TextEncoder,
    console: { warn(...args) { calls.warns.push(args.map(String)); }, log() {} },
    document: { hidden: false, visibilityState: 'visible', addEventListener() {}, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ id: '', className: '', innerHTML: '', addEventListener() {}, querySelector: () => null,
        querySelectorAll: () => [], classList: { add() {}, remove() {} } }),
      body: { classList: { add() {}, remove() {} }, appendChild() {} } },
    setTimeout: setTimer, clearTimeout: id => pending.delete(id), setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: callback => callback(), localStorage, sessionStorage: storage(),
    location: { href: `https://example.test/room.html?mode=bot&game=NEUR-TEST&variant=${variant}&difficulty=${difficulty}`,
      pathname: '/room.html', search: `?mode=bot&game=NEUR-TEST&variant=${variant}&difficulty=${difficulty}`, hostname: 'example.test' },
    history: { replaceState() {} } };
  window.window = window; vm.createContext(context);
  for (const file of ['game.js', 'lib/long-bot-neural.js', 'lib/long-bot-neural-v2.js',
    ...(model ? ['vendor/long-neural/model-v2.js'] : []), 'long-neural-bot.js', 'bot.js']) {
    vm.runInContext(read(file), context, { filename: file });
  }
  context.NarduGame = window.NarduGame; context.NarduBot = window.NarduBot;
  context.NarduSound = window.NarduSound; context.NarduBoardEngine = window.NarduBoardEngine;
  window.NarduLongBotEngine = { beginExperienceSession() { calls.experience += 1; }, consumeLastDecision: () => null,
    experienceSize: () => 0, experienceReplaySnapshot() { calls.experience += 1; return null; } };
  window.NarduStrongBot = { plan() { calls.fallback += 1; throw new Error('Unexpected hard fallback'); },
    syncLocalExperience() { calls.experience += 1; }, consumeLastFallbackDecision: () => null };
  const marker = '    preferredMoveAction,\n  };';
  const source = read('game-controller.js'); assert(source.includes(marker));
  const exposed = source.replace(marker,
    `    preferredMoveAction,\n    __neuroTest: { safeBotPlan, playBotTurn, adoptBotIdentity, normalizeRestoredState, recordNeuralExecution, rememberNeuralDecision, activeNeuralDecision, botTrainingStatePayload, botAnalysisPayload, validateNeuralBotAvailability, ensureAutoProgress, setState(next) { state = next; variant = next.variant || variant; }, status: () => ({ mode, variant, botDifficulty, opponentName, opponentRating, botPlannerError, botTurnActive }), waitPlan: () => botTurnPlanPromise },\n  };`);
  vm.runInContext(exposed, context, { filename: 'game-controller.js actual controller, private functions exposed for tests' });
  const controller = window.NarduController;
  controller.init({ mode: 'bot', roomCode: 'NEUR-TEST', variant, difficulty,
    opponent: 'Бот сложный 1500', opponentRating: 1500, skipAutoStart: true });
  function setRolled(dice = [2, 4]) {
    const state = window.NarduGame.initialState('long'); state.turn = 'dark'; state.phase = 'roll';
    window.NarduGame.applyRoll(state, dice);
    Object.assign(controller.getState(), state); controller.getState().botDifficulty = difficulty;
    controller.__neuroTest.validateNeuralBotAvailability();
    return controller.getState();
  }
  async function flush() { for (let index = 0; index < 16; index += 1) await Promise.resolve(); }
  async function finishTurn() {
    await flush();
    for (let index = 0; index < 8; index += 1) {
      const next = [...pending].find(([, item]) => item.ms === 120); if (!next) break;
      pending.delete(next[0]); next[1].callback(); await flush();
    }
    await flush();
  }
  return { context, window, controller, api: controller.__neuroTest, calls, pending,
    game: window.NarduGame, setRolled, flush, finishTurn, localStorage };
}

test('controller keeps hard-neuro identity despite an old hard name and 1500 rating', () => {
  const h = harness(); const status = h.api.status();
  assert.equal(status.botDifficulty, 'hard-neuro'); assert.equal(status.opponentName, 'Сложный бот-нейро');
  assert.equal(status.opponentRating, 1500); assert.equal(h.calls.experience, 0);
  for (const value of ['hard-neuro', 'Сложный бот-нейро', 'Hard neural bot']) {
    assert.equal(h.controller.resolveBotDifficulty(value, 'hard', 1500), 'hard-neuro');
  }
});

test('experimental hard-neuro games remain unrated until the strength gate passes', () => {
  const source = read('game-controller.js');
  assert.match(source,
    /const unratedNeuralPlayerTest = mode === 'bot' && botDifficulty === 'hard-neuro';/);
  assert.match(source,
    /mode === 'bot' && !unratedNeuralPlayerTest && botRatingPersistenceKey !== resultKey/);
  assert.match(source,
    /if \(unratedNeuralPlayerTest\) \{[\s\S]*?lastRatingResult = null;/);
});

test('unsupported short neural room pauses during initialization before any automatic turn', () => {
  const h = harness({ variant: 'short' });
  assert.equal(h.api.status().botDifficulty, 'hard-neuro');
  assert.match(h.api.status().botPlannerError, /только в длинных нардах/);
  assert.equal(h.calls.experience, 0);
  assert.equal(h.calls.fallback, 0);
  h.api.ensureAutoProgress();
  assert.equal(h.controller.getState().phase, 'opening');
});

test('a restored short rule state cannot pass availability validation under a long URL', () => {
  const h = harness();
  h.controller.getState().variant = 'short';
  assert.equal(h.api.validateNeuralBotAvailability(), false);
  assert.match(h.api.status().botPlannerError, /только в длинных нардах/);
  assert.equal(h.calls.fallback, 0);
});

test('authoritative ordinary room identity cannot be upgraded by stale neural URL/config hints', () => {
  const h = harness();
  const saved = h.game.initialState('long');
  saved.botDifficulty = 'hard';
  saved.analysis = { difficulty: 'hard', botName: 'Бот сложный' };
  h.api.adoptBotIdentity(saved, true);
  assert.equal(h.api.status().botDifficulty, 'hard');
  assert.equal(h.api.status().opponentName, 'Бот сложный');
});

test('a restored V1 neural room pauses instead of switching models during an unfinished game', () => {
  const h = harness();
  const state = h.controller.getState();
  const legacy = {
    id: 'hard-neuro-448-v1',
    modelFingerprint: 'sha256:4254bfa9f4afccbeb73657f11e37ff39a7fcd9162e7887f1aae28eaa7fbe0155',
  };
  state.analysis = { ...(state.analysis || {}), neuralModel: legacy };
  assert.equal(h.api.validateNeuralBotAvailability(), false);
  assert.match(h.api.status().botPlannerError, /Версия нейробота обновлена/);
  assert.deepEqual(plain(state.analysis.neuralModel), legacy, 'old room identity remains available for an explicit restart');
  assert.equal(h.calls.fallback, 0);
});

test('partial neural metadata cannot be silently relabelled as the current model', () => {
  for (const partial of [{}, { id: 'hard-neuro-search-v2-32games-v1' },
    { modelFingerprint: 'sha256:6484d2e9e489c63c0844b98a4bbcf616a62e48ce0f162c546fd66eb951f09c5e' }]) {
    const h = harness();
    const state = h.controller.getState();
    state.analysis = { ...(state.analysis || {}), neuralModel: partial };
    assert.equal(h.api.validateNeuralBotAvailability(), false);
    assert.match(h.api.status().botPlannerError, /Версия нейробота обновлена/);
    assert.deepEqual(plain(state.analysis.neuralModel), partial);
    assert.equal(h.calls.fallback, 0);
  }
});

test('a human opponent name or query hint containing neural cannot change a remote game into a neural bot room', () => {
  const h = harness();
  h.controller.init({ mode: 'remote', roomCode: 'NEUR-TEST', variant: 'long',
    difficulty: 'hard-neuro', opponent: 'Нейрохирург', opponentRating: 1500,
    skipAutoStart: true, skipRemoteSync: true });
  const state = h.controller.getState();
  assert.equal(state.mode, 'remote');
  assert.notEqual(state.botDifficulty, 'hard-neuro');
  assert.equal(state.analysis?.neuralModel, undefined);
  assert.equal(h.api.status().opponentName, 'Нейрохирург');
});

test('controller restore retains neural ledger/model and restores the correct head-rule state', () => {
  const h = harness(); const state = h.setRolled([3, 3, 3, 3]);
  h.api.safeBotPlan(); const saved = plain(state);
  const restored = h.api.normalizeRestoredState(saved, new URL(h.context.location.href));
  h.api.adoptBotIdentity(restored); h.api.setState(restored);
  assert.equal(h.api.status().botDifficulty, 'hard-neuro');
  assert.deepEqual(plain(restored.analysis.neuralDecisions), saved.analysis.neuralDecisions);
  assert.deepEqual(plain(restored.firstMoveDone), saved.firstMoveDone);
  assert.deepEqual(plain(restored.headPlayedThisTurn), saved.headPlayedThisTurn);
  assert.equal(restored.analysis.neuralModel.id, 'hard-neuro-search-v2-32games-v1');
  assert.equal(restored.analysis.neuralModel.modelTrainingSteps, 39040);
  assert.equal(restored.analysis.neuralModel.v2CompletedTrainingGames, 32);
});

test('safe neural plan archives exact selected moves and no old hard botMemory/XP', () => {
  const h = harness(); const state = h.setRolled([3, 3, 3, 3]);
  const before = plain(state); const moves = plain(h.api.safeBotPlan());
  const decision = state.analysis.neuralDecisions.at(-1);
  assert.deepEqual(plain(decision.selected), moves);
  assert.equal(decision.diagnostics.modelId, 'hard-neuro-search-v2-32games-v1');
  assert.equal(decision.diagnostics.v2CompletedTrainingGames, 32);
  assert.deepEqual(plain(decision.diagnostics.policyOptions), {
    maxCandidates: 32, replyTopCandidates: 2, replyCandidates: 4, replyWeight: 0.35,
  });
  assert.equal(decision.diagnostics.evaluatedPositions, decision.diagnostics.uniqueLegalPositions);
  assert.equal(decision.diagnostics.scoreKind, 'bounded-search-utility-not-calibrated-probability');
  assert.equal(decision.diagnostics.productionEligible, false);
  assert.equal(decision.execution.complete, false); assert.equal(state.analysis.botMemory, undefined);
  assert.deepEqual(plain(decision.before.firstMoveDone), before.firstMoveDone);
  assert.deepEqual(plain(decision.before.headPlayedThisTurn), before.headPlayedThisTurn);
  assert.equal(h.calls.experience, 0); assert.equal(h.calls.fallback, 0);
});

test('neural legality validation searches only a detached rule position, not growing proof or analytics history', () => {
  const h = harness();
  const state = h.setRolled();
  state.history = [{ privateProofMarker: 'excluded' }];
  state.analysis.largePrivateMarker = 'excluded';
  const snapshot = plain(state);
  const original = h.game.bestMoveSequences;
  let checks = 0;
  h.game.bestMoveSequences = (input, color) => {
    assert.notEqual(input, state);
    assert.equal(input.analysis, undefined);
    assert.equal((input.history || []).length, 0);
    checks += 1;
    return original(input, color);
  };
  h.api.safeBotPlan();
  assert.ok(checks >= 2);
  assert.deepEqual(plain(state.points), snapshot.points);
  assert.deepEqual(plain(state.history), snapshot.history);
  assert.deepEqual(plain(state.dice), snapshot.dice);
});

test('multiple plans for one timestamp/position have unique neural decision ids', () => {
  const h = harness(); h.setRolled();
  for (let index = 0; index < 3; index += 1) h.api.safeBotPlan();
  const decisions = h.controller.getState().analysis.neuralDecisions;
  assert.equal(new Set(decisions.map(decision => decision.id)).size, 3);
  assert.equal(h.api.activeNeuralDecision(), decisions.at(-1));
});

test('actual neural turn executes only the archived full legal plan and matching from/to/die ledger', async () => {
  const h = harness(); const state = h.setRolled(); const before = plain(state);
  h.api.playBotTurn(); await h.finishTurn();
  const decision = state.analysis.neuralDecisions.at(-1);
  const replay = plain(before); const expected = [];
  for (const move of decision.selected) {
    const to = h.game.moveTo(replay.turn, move.from, move.die, replay);
    expected.push({ from: move.from, die: move.die, to, bearOff: to === 0 });
    assert(h.game.applyMove(replay, move.from, move.die));
  }
  assert.deepEqual(plain(decision.execution.executedMoves), expected);
  assert.equal(decision.execution.complete, true);
  assert.deepEqual(plain(state.points), plain(replay.points));
  assert.deepEqual(plain(state.off), plain(replay.off));
  assert.equal(state.turn, replay.turn); assert.equal(state.phase, replay.phase);
  assert.deepEqual(plain(decision.execution.after.points), plain(state.points));
  assert.equal(decision.execution.after.turn, state.turn); assert.equal(decision.execution.after.phase, state.phase);
  assert.equal(h.api.status().botTurnActive, false); assert.equal(h.calls.fallback, 0);
});

test('missing model pauses room before any progress without a fallback or skipped turn', async () => {
  const h = harness({ model: false }); const state = h.setRolled(); const before = plain(state);
  assert.match(h.api.status().botPlannerError, /приостановлена/);
  h.api.playBotTurn(); h.api.ensureAutoProgress(0); await h.finishTurn();
  assert.deepEqual(plain(state.points), before.points); assert.deepEqual(plain(state.dice), before.dice);
  assert.equal(state.turn, before.turn); assert.equal(state.phase, before.phase);
  assert.equal(h.calls.animations.length, 0); assert.equal(h.calls.fallback, 0);
});

test('a neural planner exception pauses at the original dice, never ends or substitutes its turn', async () => {
  const h = harness(); const state = h.setRolled(); const before = plain(state);
  h.context.NarduBot = { plan() { throw new Error('forced-neural-planner-error'); } };
  h.api.playBotTurn(); await h.finishTurn();
  assert.match(h.api.status().botPlannerError, /приостановлена/);
  assert.deepEqual(plain(state.points), before.points); assert.deepEqual(plain(state.dice), before.dice);
  assert.equal(state.turn, before.turn); assert.equal(state.phase, 'move');
  assert.equal(h.calls.animations.length, 0); assert.equal(h.calls.fallback, 0);
  assert.equal(h.api.status().botTurnActive, false);
});

test('a next-turn planning failure never rewrites the previous completed neural execution', async () => {
  const h = harness(); const state = h.setRolled();
  h.api.playBotTurn(); await h.finishTurn();
  const completed = state.analysis.neuralDecisions.at(-1); const saved = plain(completed);
  state.turn = 'dark'; state.phase = 'roll'; h.game.applyRoll(state, [1, 2]);
  h.context.NarduBot = { plan() { throw new Error('next-turn-planner-error'); } };
  h.api.playBotTurn(); await h.finishTurn();
  assert.match(h.api.status().botPlannerError, /приостановлена/);
  assert.deepEqual(plain(completed), saved);
  assert.equal(state.analysis.neuralDecisions.length, 1);
});

test('an incomplete or empty neural plan with available legal moves never passes the turn', async () => {
  for (const invalid of [[], [{ from: 12, die: 2 }], [{ from: 999, die: 6 }]]) {
    const h = harness(); const state = h.setRolled(); const before = plain(state);
    h.context.NarduBot = { plan: () => invalid };
    h.api.playBotTurn(); await h.finishTurn();
    assert.match(h.api.status().botPlannerError, /приостановлена/);
    assert.deepEqual(plain(state.points), before.points); assert.deepEqual(plain(state.dice), before.dice);
    assert.equal(state.turn, before.turn); assert.equal(state.phase, 'move');
    assert.equal(h.calls.animations.length, 0); assert.equal(h.calls.fallback, 0);
  }
});

test('rejected neural applyMove never substitutes, completes or ends its turn', async () => {
  const h = harness(); const state = h.setRolled(); const before = plain(state);
  h.window.NarduBoardEngine.animateCheckerMove = async () => {
    h.context.NarduGame = { ...h.game, applyMove: () => false };
  };
  h.api.playBotTurn(); await h.finishTurn();
  assert.match(h.api.status().botPlannerError, /приостановлена/);
  assert.deepEqual(plain(state.points), before.points); assert.deepEqual(plain(state.dice), before.dice);
  assert.equal(state.turn, before.turn); assert.equal(state.phase, 'move');
  const decision = state.analysis.neuralDecisions.at(-1);
  assert.equal(decision.execution.complete, false); assert.equal(decision.execution.executedMoves.length, 0);
  assert.match(decision.execution.error, /application rejected/); assert.equal(h.calls.fallback, 0);
});

test('execution invalidation after planning pauses instead of selecting another legal checker', async () => {
  const h = harness(); const state = h.setRolled(); const before = plain(state);
  h.api.playBotTurn();
  h.context.NarduGame = { ...h.game, isValidMove: () => false };
  await h.finishTurn();
  assert.match(h.api.status().botPlannerError, /приостановлена/);
  assert.deepEqual(plain(state.points), before.points); assert.deepEqual(plain(state.dice), before.dice);
  assert.equal(state.turn, before.turn); assert.equal(state.phase, 'move');
  const decision = state.analysis.neuralDecisions.at(-1);
  assert.equal(decision.execution.complete, false); assert.match(decision.execution.error, /substitution forbidden/);
  assert.equal(h.calls.animations.length, 0); assert.equal(h.calls.fallback, 0);
});

test('a legal plan without matching one-shot neural diagnostics is refused', async () => {
  const h = harness(); const state = h.setRolled(); const before = plain(state);
  const legal = h.game.bestMoveSequences(state, state.turn)[0];
  h.context.NarduBot = { plan: () => legal };
  h.api.playBotTurn(); await h.finishTurn();
  assert.match(h.api.status().botPlannerError, /приостановлена/);
  assert.deepEqual(plain(state.points), before.points); assert.deepEqual(plain(state.dice), before.dice);
  assert.equal(state.phase, 'move'); assert.equal(state.analysis.neuralDecisions, undefined);
  assert.equal(h.calls.animations.length, 0); assert.equal(h.calls.fallback, 0);
});

test('a rules-certified genuine neural pass archives the actual post-endTurn state', async () => {
  const h = harness(); const state = h.setRolled();
  state.points = { 12: { color: 'dark', count: 15 }, 10: { color: 'white', count: 7 }, 8: { color: 'white', count: 8 } };
  assert.equal(h.game.hasAnyMoves(state), false);
  h.api.playBotTurn(); await h.finishTurn();
  const decision = state.analysis.neuralDecisions.at(-1);
  assert.equal(decision.selected.length, 0); assert.equal(decision.execution.executedMoves.length, 0);
  assert.equal(decision.execution.complete, true);
  assert.equal(state.turn, 'white'); assert.equal(state.phase, 'roll');
  assert.equal(decision.execution.after.turn, state.turn); assert.equal(decision.execution.after.phase, state.phase);
  assert.equal(h.api.status().botPlannerError, ''); assert.equal(h.calls.fallback, 0);
});

test('neural final bear-off ledger records exact zero destination and completed terminal board', async () => {
  const h = harness(); const state = h.setRolled();
  state.points = { 13: { color: 'dark', count: 1 }, 24: { color: 'white', count: 15 } };
  state.off.dark = 14; state.firstMoveDone = { white: true, dark: true };
  h.api.playBotTurn(); await h.finishTurn();
  const decision = state.analysis.neuralDecisions.at(-1);
  assert.equal(state.winner, 'dark'); assert.equal(state.off.dark, 15);
  assert.equal(decision.execution.complete, true); assert.equal(decision.execution.executedMoves.length, 1);
  assert.equal(decision.execution.executedMoves[0].to, 0); assert.equal(decision.execution.executedMoves[0].bearOff, true);
  assert.equal(decision.execution.after.winner, 'dark'); assert.equal(decision.execution.after.off.dark, 15);
  assert.equal(h.calls.fallback, 0);
});

test('neural ledger retains a bounded 180-decision window with unique ids', () => {
  const h = harness(); const state = h.setRolled();
  for (let index = 0; index < 190; index += 1) h.api.rememberNeuralDecision([{ from: 12, die: 2 }],
    { difficulty: 'hard-neuro', modelId: 'hard-neuro-search-v2-32games-v1', ordinal: index });
  assert.equal(state.analysis.neuralDecisions.length, 180);
  assert.equal(state.analysis.neuralDecisions[0].diagnostics.ordinal, 10);
  assert.equal(state.analysis.neuralDecisions.at(-1).diagnostics.ordinal, 189);
  assert.equal(new Set(state.analysis.neuralDecisions.map(decision => decision.id)).size, 180);
});

test('neural training archive preserves full move history and excludes the old replay experience', () => {
  const h = harness(); const state = h.setRolled();
  state.history = Array.from({ length: 240 }, (_, index) => ({ from: 12, die: 1, sequenceNumber: index }));
  h.api.safeBotPlan(); const payload = h.api.botTrainingStatePayload();
  assert.equal(payload.history.length, 240); assert.equal(payload.botDifficulty, 'hard-neuro');
  assert.equal(payload.analysis.neuralDecisions.length, 1); assert.equal(payload.analysis.botMemory, undefined);
  assert.equal(h.calls.experience, 0);
});

test('existing hard identity and durable old botMemory decision path remain separate', () => {
  const h = harness({ difficulty: 'hard' }); const state = h.setRolled();
  const moves = h.game.chooseBotSequence(state, state.turn, { difficulty: 'hard' });
  h.context.NarduBot = { plan: () => moves };
  assert.equal(h.api.status().botDifficulty, 'hard');
  assert(h.api.safeBotPlan().length); assert(state.analysis.botMemory.decisions.length);
  assert.equal(state.analysis.neuralDecisions, undefined); assert.equal(state.analysis.neuralModel, undefined);
});
