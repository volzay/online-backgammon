const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const crypto = require('node:crypto');
const neural = require('../lib/long-bot-neural');
const buildModel = require('../scripts/build-long-neural-model');
const { fingerprint } = require('../lib/long-neural-artifact');
const ROOT = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function environment({ model = true, core = true, adapter = true, payload } = {}) {
  const guardedMath = Object.create(Math);
  guardedMath.random = () => { throw new Error('Neuro must not call any RNG'); };
  const context = vm.createContext({ window: {}, Math: guardedMath, Date,
    console: { warn() { throw new Error('Neuro must not fall back'); } } });
  vm.runInContext(read('game.js'), context);
  context.NarduGame = context.window.NarduGame;
  if (core) vm.runInContext(read('lib/long-bot-neural.js'), context);
  if (model) vm.runInContext(read('vendor/long-neural/model.js'), context);
  if (payload) context.window.NarduLongNeuralModel = payload;
  if (adapter) vm.runInContext(read('long-neural-bot.js'), context);
  context.window.NarduStrongBot = { plan() { throw new Error('Neuro must not call strong heuristic'); } };
  vm.runInContext(read('bot.js'), context);
  return { context, game: context.window.NarduGame, bot: context.window.NarduBot,
    neuro: context.window.NarduNeuralBot, payload: context.window.NarduLongNeuralModel };
}
function rolled(game, dice = [2, 4]) {
  const state = game.initialState('long');
  state.turn = 'white'; state.phase = 'roll'; game.applyRoll(state, dice);
  return state;
}

test('shipped public weights have the actual evaluated model hash, counters and frozen shape', () => {
  const payload = JSON.parse(read('vendor/long-neural/model.json'));
  assert.equal(buildModel.validatePublicModel(payload), payload);
  assert.equal(fingerprint(payload.model), buildModel.PIN.modelFingerprint);
  assert.equal(payload.model.trainingSteps, 35147);
  assert.equal(payload.model.inputWeights.length, 127 * 32);
  assert.equal(payload.metadata.trainingGames, 448);
  assert.deepEqual(Object.keys(payload).sort(), ['metadata', 'model', 'schema']);
  assert.equal(read('vendor/long-neural/model.js'), buildModel.assetSource(payload));
  const { payload: browserPayload, neuro } = environment();
  for (const value of [browserPayload, browserPayload.metadata, browserPayload.model,
    browserPayload.model.inputWeights, browserPayload.model.hiddenBias, browserPayload.model.outputWeights]) assert(Object.isFrozen(value));
  assert.equal(neuro.getModelMetadata().id, 'hard-neuro-448-v1');
});

test('public model builder runs from committed weights without ignored training data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-model-build-'));
  const assetPath = path.join(directory, 'model.js');
  const result = buildModel({ assetPath });
  assert.equal(result.metadata.id, 'hard-neuro-448-v1');
  assert.equal(fs.readFileSync(assetPath, 'utf8'), read('vendor/long-neural/model.js'));
  const bytes = read('lib/long-bot-neural.js');
  assert.equal(`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, buildModel.PIN.inferenceCodeFingerprint);
  fs.unlinkSync(assetPath); fs.rmdirSync(directory);
});

test('public model builder rejects a reset network, changed weight, extra provenance or wrong metadata', () => {
  const baseline = JSON.parse(read('vendor/long-neural/model.json'));
  for (const mutate of [p => { p.model.trainingSteps = 0; }, p => { p.model.inputWeights[0] += 1e-5; },
    p => { p.metadata.trainingGames = 449; }, p => { p.results = []; },
    p => { p.metadata.maxCandidates = 64; }, p => { p.model.extra = true; }]) {
    const payload = plain(baseline); mutate(payload);
    assert.throws(() => buildModel.validatePublicModel(payload));
  }
});

test('hard-neuro normalization preserves its identity before the old hard/name/rating hints', () => {
  const { bot } = environment();
  for (const hint of ['hard-neuro', 'hard neuro', 'hard_neuro', 'Hard neural bot', 'Сложный бот-нейро']) {
    assert.equal(bot.normalizeDifficulty(hint, { botDifficulty: 'hard', analysis: { botName: 'Бот сложный 1500' } }), 'hard-neuro');
  }
  assert.equal(bot.normalizeDifficulty('hard', { analysis: { difficulty: 'hard-neuro' } }), 'hard-neuro');
  for (const level of ['easy', 'medium', 'hard']) assert.equal(bot.normalizeDifficulty(level), level);
});

test('hard-neuro uses only saved network, obeys the full first-double turn and never generates dice', () => {
  const { game, bot, neuro, payload } = environment();
  const state = rolled(game, [3, 3, 3, 3]);
  const before = JSON.stringify(state); const weights = JSON.stringify(payload.model);
  const plan = plain(bot.plan(state, { difficulty: 'hard-neuro' }));
  const reference = neural.createNeuralBot(game, plain(payload.model), { epsilon: 0, maxCandidates: 16 });
  assert.deepEqual(plan, plain(reference.plan(state)));
  assert.equal(plan.filter(move => move.from === 24).length, 2);
  assert.equal(plan.length, 4);
  const legal = game.bestMoveSequences(plain(state));
  assert(legal.some(sequence => JSON.stringify(plain(sequence).map(({ from, die }) => ({ from, die }))) === JSON.stringify(plan)));
  const replay = plain(state);
  for (const move of plan) assert(game.applyMove(replay, move.from, move.die, { autoEnd: false }));
  assert(!game.hasAnyMoves(replay));
  assert.equal(JSON.stringify(state), before);
  assert.equal(JSON.stringify(payload.model), weights);
  const decision = neuro.getLastDecision();
  assert.equal(decision.modelFingerprint, buildModel.PIN.modelFingerprint);
  assert.equal(decision.maxCandidates, 16);
  assert.equal(decision.trainingSteps, 35147);
  assert.equal(decision.onlineLearning, false);
  assert.equal(decision.exploration, 0);
  assert(decision.selectedValue >= 0 && decision.selectedValue <= 1);
});

test('neuro consumes one decision and a later invalid request clears its diagnostics', () => {
  const { game, neuro } = environment();
  neuro.plan(rolled(game));
  assert(neuro.consumeLastDecision()); assert.equal(neuro.consumeLastDecision(), null);
  neuro.plan(rolled(game));
  assert.throws(() => neuro.plan({ variant: 'short' }), /only long/);
  assert.equal(neuro.getLastDecision(), null);
});

test('a rules-certified terminal bear-off is preserved by the network adapter', () => {
  const { game, neuro } = environment();
  const state = rolled(game, [2, 4]);
  state.points = { 2: { color: 'white', count: 1 }, 12: { color: 'dark', count: 15 } };
  state.off.white = 14; state.firstMoveDone = { white: true, dark: true };
  const plan = neuro.plan(state);
  const replay = plain(state);
  for (const move of plan) assert(game.applyMove(replay, move.from, move.die, { autoEnd: false }));
  assert.equal(replay.winner, 'white'); assert.equal(replay.off.white, 15);
  assert.equal(neuro.getLastDecision().selectedValue, 1);
});

test('hard-neuro never reads future dice, account identities or supplied analysis weights', () => {
  const { game, bot, neuro } = environment();
  const state = rolled(game); const expected = plain(neuro.plan(state));
  for (const key of ['nextDice', 'auth', 'playerName', 'password']) Object.defineProperty(state, key,
    { enumerable: true, get() { throw new Error(`Forbidden access: ${key}`); } });
  state.analysis = { difficulty: 'hard-neuro', weights: [1e9], opponentPassword: 'ignored' };
  assert.deepEqual(plain(bot.plan(state, { difficulty: 'hard-neuro' })), expected);
});

test('missing model, core or adapter fails closed without a heuristic fallback', () => {
  for (const options of [{ model: false }, { core: false }, { adapter: false }]) {
    const { game, bot } = environment(options);
    assert.throws(() => bot.plan(rolled(game), { difficulty: 'hard-neuro' }), /unavailable|not loaded/);
  }
});

test('wrong or mutable public model metadata cannot masquerade as the trained network', () => {
  const baseline = JSON.parse(read('vendor/long-neural/model.json'));
  for (const mutate of [p => { p.metadata.modelFingerprint = 'sha256:' + '0'.repeat(64); },
    p => { p.metadata.trainingSteps = 0; }, p => { p.metadata.rulesFingerprint = 'sha256:' + '0'.repeat(64); },
    p => { p.metadata.maxCandidates = 64; }, p => { p.model.trainingSteps = 0; }]) {
    const payload = plain(baseline); mutate(payload);
    for (const key of ['inputWeights', 'hiddenBias', 'outputWeights']) Object.freeze(payload.model[key]);
    Object.freeze(payload.metadata); Object.freeze(payload.model); Object.freeze(payload);
    const { game, bot } = environment({ model: false, payload });
    assert.throws(() => bot.plan(rolled(game), { difficulty: 'hard-neuro' }));
  }
  const { game, bot } = environment({ model: false, payload: baseline });
  assert.throws(() => bot.plan(rolled(game), { difficulty: 'hard-neuro' }));
});

test('neuro rejects short and unrolled games instead of becoming the old hard bot', () => {
  const { game, bot } = environment();
  assert.throws(() => bot.plan(game.initialState('short'), { difficulty: 'hard-neuro' }), /only long/);
  assert.throws(() => bot.plan(game.initialState('long'), { difficulty: 'hard-neuro' }), /already rolled/);
});

test('existing medium and hard planners retain their previous branches', () => {
  const { context, game, bot } = environment();
  const state = rolled(game);
  let hardCalls = 0;
  context.window.NarduStrongBot = { plan() { hardCalls += 1; return [{ from: 24, die: 2 }]; } };
  assert.deepEqual(plain(bot.plan(state, { difficulty: 'hard' })), [{ from: 24, die: 2 }]);
  assert.equal(hardCalls, 1);
  const medium = plain(game.chooseBotSequence(plain(state), state.turn, { difficulty: 'medium' }))
    .map(({ from, die }) => ({ from, die }));
  assert.deepEqual(plain(bot.plan(state, { difficulty: 'medium' })), medium);
  assert.equal(hardCalls, 1);
});
