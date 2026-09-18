const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const neural = require('../lib/long-bot-neural');

function rules() {
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => { throw new Error('Unexpected dice RNG'); };
  const context = vm.createContext({ window: {}, Math: deterministicMath, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8'), context);
  return context.window.NarduGame;
}
function rolled(game, dice = [2, 4]) {
  const state = game.initialState('long');
  state.turn = 'white';
  state.phase = 'roll';
  game.applyRoll(state, dice);
  return state;
}
function rotated(state) {
  const opponent = color => color === 'white' ? 'dark' : 'white';
  const point = from => ((from + 11) % 24) + 1;
  return { ...state,
    points: Object.fromEntries(Object.entries(state.points).map(([from, stack]) =>
      [point(Number(from)), { color: opponent(stack.color), count: stack.count }])),
    turn: state.turn && opponent(state.turn), winner: state.winner && opponent(state.winner),
    bar: { white: state.bar.dark, dark: state.bar.white },
    off: { white: state.off.dark, dark: state.off.white },
    firstMoveDone: { white: state.firstMoveDone.dark, dark: state.firstMoveDone.white },
    turnMoves: state.turnMoves.map(move => ({ ...move, color: opponent(move.color), from: point(move.from) })),
  };
}

test('long neural initialization is deterministic, bounded, and genuinely seed-dependent', () => {
  const first = neural.createModel({ seed: 42, hiddenSize: 8 });
  assert.deepEqual(first, neural.createModel({ seed: 42, hiddenSize: 8 }));
  assert.notDeepEqual(first.inputWeights, neural.createModel({ seed: 43, hiddenSize: 8 }).inputWeights);
  assert.equal(neural.validateModel(first), first);
  assert.equal(first.inputWeights.length, neural.INPUT_SIZE * 8);
  assert.throws(() => neural.createModel({ seed: -1 }));
  assert.throws(() => neural.createModel({ hiddenSize: 129 }));
});

test('long neural rejects incompatible, sparse, nonfinite, and unbounded model parameters', () => {
  for (const mutate of [model => { model.encodingVersion = 'different'; },
    model => { model.hiddenSize = 1e9; }, model => { model.inputWeights.pop(); },
    model => { delete model.inputWeights[0]; }, model => { model.outputBias = NaN; },
    model => { model.outputBias = 101; }, model => { model.extra = true; },
    model => { model.trainingSteps = -1; }]) {
    const model = neural.createModel();
    mutate(model);
    assert.throws(() => neural.validateModel(model));
  }
});

test('encoding is color-rotation invariant and excludes history, identity, and analysis', () => {
  const game = rules();
  const state = rolled(game, [3, 3, 3, 3]);
  assert.equal(game.applyMove(state, 24, 3, { autoEnd: false }), true);
  const vector = neural.encodeState(state, 'white');
  assert.equal(vector.length, 127);
  assert.deepEqual(vector, neural.encodeState(rotated(state), 'dark'));
  assert.deepEqual(vector, neural.encodeState({ ...state,
    history: [{ fabricatedWinner: 'dark' }], analysis: { weights: [9999] },
    playerName: 'secret', nextDice: [6, 6], score: { white: 9e9, dark: 0 } }, 'white'));
  assert(vector.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.notDeepEqual(vector, neural.encodeState({ ...state, firstMoveDone: { white: true, dark: false } }, 'white'));
  assert.notDeepEqual(vector, neural.encodeState({ ...state, turnMoves: [] }, 'white'));
});

test('encoding rejects short games, broken checker conservation, bar, and invalid dice', () => {
  const game = rules();
  const state = rolled(game);
  for (const bad of [{ ...state, variant: 'short' }, { ...state, off: { white: 1, dark: 0 } },
    { ...state, bar: { white: 1, dark: 0 } }, { ...state, dice: [0, 4] },
    { ...state, winner: 'white', phase: 'over' }]) {
    assert.throws(() => neural.encodeState(bad, 'white'));
  }
  assert.throws(() => neural.predict(neural.createModel(), state, 'someone'));
});

test('backpropagation updates both layers and reduces measured prediction error', () => {
  const state = rolled(rules());
  const model = neural.createModel({ seed: 10, hiddenSize: 8 });
  const before = JSON.parse(JSON.stringify(model));
  const initial = neural.predict(model, state, 'white');
  const target = initial < 0.5 ? 1 : 0;
  for (let index = 0; index < 80; index += 1) {
    const result = neural.trainSample(model, state, 'white', target, { learningRate: 0.2 });
    assert(Number.isFinite(result.loss));
  }
  assert(Math.abs(neural.predict(model, state, 'white') - target) < Math.abs(initial - target) / 2);
  assert.notDeepEqual(model.inputWeights, before.inputWeights);
  assert.notDeepEqual(model.outputWeights, before.outputWeights);
  assert.equal(model.trainingSteps, 80);
  neural.validateModel(model);
});

test('backpropagation matches a finite-difference gradient and invalid samples are atomic', () => {
  const state = rolled(rules());
  const model = neural.createModel({ hiddenSize: 4, seed: 77 });
  const delta = 1e-5;
  const original = model.inputWeights[0];
  model.inputWeights[0] = original + delta;
  const plus = (neural.predict(model, state, 'white') - 0.9) ** 2 / 2;
  model.inputWeights[0] = original - delta;
  const minus = (neural.predict(model, state, 'white') - 0.9) ** 2 / 2;
  model.inputWeights[0] = original;
  neural.trainSample(model, state, 'white', 0.9, { learningRate: 0.1 });
  assert(Math.abs((original - model.inputWeights[0]) / 0.1 - (plus - minus) / (2 * delta)) < 1e-8);
  const serialized = JSON.stringify(model);
  for (const [target, learningRate] of [[NaN, 0.1], [-1, 0.1], [2, 0.1], [1, Infinity]]) {
    assert.throws(() => neural.trainSample(model, state, 'white', target, { learningRate }));
    assert.equal(JSON.stringify(model), serialized);
  }
});

test('neural plans are maximum-use legal turns with first-double head exception and no RNG/state mutation', () => {
  const game = rules();
  const state = rolled(game, [3, 3, 3, 3]);
  const serialized = JSON.stringify(state);
  const bot = neural.createNeuralBot(game, neural.createModel({ hiddenSize: 4 }), { maxCandidates: 32 });
  const plan = bot.plan(state);
  const legal = game.bestMoveSequences(JSON.parse(serialized));
  assert(legal.some(sequence => JSON.stringify(Array.from(sequence, ({ from, die }) => ({ from, die }))) === JSON.stringify(plan)));
  assert.equal(plan.length, Math.max(...legal.map(sequence => sequence.length)));
  assert.equal(plan.filter(move => move.from === 24).length, 2);
  assert.equal(JSON.stringify(state), serialized);
  assert.deepEqual(bot.plan(state), plan);
  const after = JSON.parse(serialized);
  for (const move of plan) assert(game.applyMove(after, move.from, move.die, { autoEnd: false }));
  assert(!game.hasAnyMoves(after));
  assert.equal(bot.getLastDecision().legalSequences, legal.length);
});

test('inference snapshots are frozen and independent of subsequent training', () => {
  const game = rules();
  const state = rolled(game);
  const model = neural.createModel({ hiddenSize: 4 });
  const bot = neural.createNeuralBot(game, model);
  const inferenceBytes = JSON.stringify(bot.model);
  const before = bot.rank(state).map(row => row.value);
  neural.trainSample(model, state, 'white', 1, { learningRate: 1 });
  assert.equal(JSON.stringify(bot.model), inferenceBytes);
  assert.deepEqual(bot.rank(state).map(row => row.value), before);
  assert(Object.isFrozen(bot.model.inputWeights));
  assert.throws(() => neural.trainSample(bot.model, state, 'white', 1));
});

test('bounded candidate coverage and chosen plans are invariant under color rotation', () => {
  const game = rules();
  const state = rolled(game, [2, 2, 2, 2]);
  state.points = { 5: { color: 'white', count: 5 }, 10: { color: 'white', count: 5 },
    20: { color: 'white', count: 5 }, 12: { color: 'dark', count: 15 } };
  state.firstMoveDone = { white: true, dark: true };
  const mirror = rotated(state);
  const model = neural.createModel({ seed: 42, hiddenSize: 8 });
  for (const maxCandidates of [16, 64]) {
    const whiteBot = neural.createNeuralBot(game, model, { maxCandidates });
    const darkBot = neural.createNeuralBot(game, model, { maxCandidates });
    const whiteRows = whiteBot.rank(state);
    const darkRows = darkBot.rank(mirror);
    assert.deepEqual(whiteRows.map(row => Array.from(neural.encodeState(row.afterState, 'white'))),
      darkRows.map(row => Array.from(neural.encodeState(row.afterState, 'dark'))));
    assert.deepEqual(whiteRows.map(row => row.value), darkRows.map(row => row.value));
    assert.deepEqual(whiteBot.getLastDecision(), darkBot.getLastDecision());
    assert.deepEqual(whiteBot.plan(state), darkBot.plan(mirror).map(move =>
      ({ ...move, from: ((move.from + 11) % 24) + 1 })));
  }
});

test('bear-off wins receive exact terminal values, independent of network parameters', () => {
  const game = rules();
  const state = rolled(game, [1, 2]);
  state.points = { 1: { color: 'white', count: 1 }, 12: { color: 'dark', count: 15 } };
  state.off.white = 14;
  state.firstMoveDone = { white: true, dark: true };
  const model = neural.createModel();
  model.outputBias = -100;
  const rows = neural.createNeuralBot(game, model).rank(state);
  assert(rows.length > 0);
  assert.equal(rows[0].value, 1);
  assert.equal(rows[0].afterState.winner, 'white');
  assert.equal(neural.predict(model, rows[0].afterState, 'dark'), 0);
  assert.throws(() => neural.trainSample(model, rows[0].afterState, 'white', 1));
});

test('rules-certified wins take precedence over saturated predictions and offline exploration', () => {
  const game = rules();
  const state = rolled(game, [1, 2]);
  state.points = { 1: { color: 'white', count: 1 }, 2: { color: 'white', count: 1 },
    12: { color: 'dark', count: 15 } };
  state.off.white = 13;
  state.firstMoveDone = { white: true, dark: true };
  const model = neural.createModel();
  model.outputBias = 100;
  const all = neural.createNeuralBot(game, model).rank(state);
  assert(all.some(row => !row.afterState.winner && row.value === 1));
  assert.equal(all[0].afterState.winner, 'white');
  const bot = neural.createNeuralBot(game, model, { maxCandidates: 1, epsilon: 1,
    rng: () => { throw new Error('Known wins must not explore'); } });
  const plan = bot.plan(state);
  for (const move of plan) assert(game.applyMove(state, move.from, move.die, { autoEnd: false }));
  assert.equal(state.winner, 'white');
});

test('offline exploration requires an explicit valid RNG; planning refuses pre-roll phases', () => {
  const game = rules();
  const model = neural.createModel();
  assert.throws(() => neural.createNeuralBot(game, model, { epsilon: 0.1 }));
  assert.throws(() => neural.createNeuralBot(game, model, { maxCandidates: 0 }));
  assert.throws(() => neural.createNeuralBot(game, model, { epsilon: 1, rng: () => 1 }).plan(rolled(game)));
  assert.throws(() => neural.createNeuralBot(game, model).plan(game.initialState('long')));
});

test('UMD neural module works in a browser without require or network dependencies', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'long-bot-neural.js'), 'utf8'), context);
  const api = context.window.NarduLongNeural;
  assert.equal(api.MODEL_SCHEMA, neural.MODEL_SCHEMA);
  assert.equal(api.createModel({ seed: 5 }).inputSize, 127);
});
