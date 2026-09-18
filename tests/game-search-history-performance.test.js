'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const neural = require('../lib/long-bot-neural');
const source = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function load({ legacy = false } = {}) {
  let code = source;
  if (legacy) {
    // The previous implementation differs only in these three internal
    // simulation clone sites, not rules, scoring or candidate ordering.
    const sites = [
      ['const next = cloneSimulationState(state);', 'const next = cloneState(state);'],
      ['state: cloneSimulationState(state), sequence: []', 'state: cloneState(state), sequence: []'],
      ['const next = cloneSimulationState(node.state);', 'const next = cloneState(node.state);'],
    ];
    for (const [current, previous] of sites) { assert(code.includes(current)); code = code.replace(current, previous); }
  }
  const math = Object.create(Math); math.random = () => { throw new Error('Search must not generate dice'); };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [1])); } static now() { return 1; } }
  const context = vm.createContext({ window: {}, Date: FixedDate, Math: math, copiedHistoryElements: 0 });
  vm.runInContext(`const originalMap = Array.prototype.map; Array.prototype.map = function(callback, thisArg) {
    if (this.length && this[0] && this[0].auditHistoryEvent === true) copiedHistoryElements += this.length;
    return originalMap.call(this, callback, thisArg);
  };`, context);
  code = code.replace('    initialState,\n', '    __fullCloneForTest: cloneState,\n    __parseForTest: input => JSON.parse(input),\n    initialState,\n');
  vm.runInContext(code, context);
  return { game: context.window.NarduGame, context };
}
function evidenceHistory(length) {
  return Array.from({ length }, (_, index) => ({ auditHistoryEvent: true, index,
    color: index % 2 ? 'dark' : 'white', from: 24, die: 2, to: 22,
    fairDiceProof: { protocol: 'system-csprng-v1', request: { id: `proof-${index}` },
      receiptSignature: 'a'.repeat(128), commitReveal: { serverSeed: 'b'.repeat(64), clientSeed: 'c'.repeat(64) } } }));
}
function position(game, { variant = 'long', color = 'white', dice = [2, 2, 2, 2], spread = true, historyLength = 0 } = {}) {
  const state = game.initialState(variant); state.turn = color; state.phase = 'roll'; game.applyRoll(state, dice);
  if (variant === 'long' && spread) {
    state.points = { 5: { color: 'white', count: 5 }, 10: { color: 'white', count: 5 },
      20: { color: 'white', count: 5 }, 12: { color: 'dark', count: 15 } };
    state.firstMoveDone = { white: true, dark: true };
  }
  state.history = game.__parseForTest(JSON.stringify(evidenceHistory(historyLength)));
  return state;
}

test('exact and sampled legal search copy zero archived history elements as the game grows', () => {
  for (const historyLength of [0, 200, 1200]) {
    const { game, context } = load(); const state = position(game, { historyLength });
    const before = JSON.stringify(state); const sequences = game.bestMoveSequences(state);
    assert.equal(sequences.length, 257);
    game.sampledMoveSequences(state, state.turn, 32);
    game.hasAnyMoves(state); game.isValidMove(state, sequences[0][0].from, sequences[0][0].die);
    assert.equal(context.copiedHistoryElements, 0);
    assert.equal(JSON.stringify(state), before, 'Search preserves the complete signed evidence and live board');
    if (historyLength) {
      const previous = load({ legacy: true });
      previous.game.bestMoveSequences(position(previous.game, { historyLength }));
      assert(previous.context.copiedHistoryElements >= historyLength * 3,
        'Regression counter must detect the actual previous per-search-node history copying');
    }
  }
});

test('simulation-only optimization preserves exact candidate order/legal/head/high-die rules for both variants and colors', () => {
  const current = load().game; const previous = load({ legacy: true }).game;
  for (const variant of ['long', 'short']) for (const color of ['white', 'dark']) {
    for (const dice of [[1, 2], [2, 4], [3, 3, 3, 3], [6, 6, 6, 6]]) {
      for (const spread of variant === 'long' ? [false, true] : [false]) {
        const state = position(current, { variant, color, dice, spread, historyLength: 12 });
        assert.deepEqual(plain(current.bestMoveSequences(plain(state))), plain(previous.bestMoveSequences(plain(state))));
        assert.deepEqual(plain(current.sampledMoveSequences(plain(state), color, 32)), plain(previous.sampledMoveSequences(plain(state), color, 32)));
      }
    }
  }
});

test('real applied sequences and post-turn state remain identical, including the entire original proof history', () => {
  const current = load().game; const previous = load({ legacy: true }).game;
  for (const variant of ['long', 'short']) for (const color of ['white', 'dark']) {
    const state = position(current, { variant, color, dice: [2, 4], historyLength: 200 });
    const actual = plain(state); const baseline = plain(state);
    for (const move of current.bestMoveSequences(plain(state))[0]) {
      assert.equal(current.applyMove(actual, move.from, move.die), previous.applyMove(baseline, move.from, move.die));
      assert.deepEqual(plain(actual), plain(baseline));
    }
    assert.deepEqual(actual.history.filter(event => event.auditHistoryEvent), plain(state.history));
  }
});

test('public full clone still retains every proof and event, while search never mutates frozen proof objects', () => {
  const { game } = load(); const state = position(game, { dice: [2, 4], historyLength: 1200 });
  for (const event of state.history) { Object.freeze(event.fairDiceProof.request); Object.freeze(event.fairDiceProof.commitReveal);
    Object.freeze(event.fairDiceProof); Object.freeze(event); }
  const cloned = game.__fullCloneForTest(state);
  assert.deepEqual(plain(cloned.history), plain(state.history)); assert.notEqual(cloned.history, state.history);
  assert.notEqual(cloned.history[0], state.history[0]);
  assert.equal(game.bestMoveSequences(state).length > 0, true);
  const move = game.bestMoveSequences(state)[0][0]; assert(game.applyMove(state, move.from, move.die));
  assert.equal(state.history.filter(event => event.auditHistoryEvent).length, 1200);
});

test('the shipped trained value network selects identical plans and values with the compatible optimized search', () => {
  const current = load().game; const previous = load({ legacy: true }).game;
  const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vendor/long-neural/model.json'), 'utf8')).model;
  const optimizedBot = neural.createNeuralBot(current, model, { epsilon: 0, maxCandidates: 16 });
  const evaluatedBot = neural.createNeuralBot(previous, model, { epsilon: 0, maxCandidates: 16 });
  for (const color of ['white', 'dark']) for (const fixture of [
    { dice: [2, 4], spread: false }, { dice: [3, 3, 3, 3], spread: false },
    { dice: [2, 2, 2, 2], spread: true },
  ]) {
    const state = position(current, { color, ...fixture, historyLength: 200 });
    assert.deepEqual(plain(optimizedBot.plan(state)), plain(evaluatedBot.plan(state)));
    assert.deepEqual(plain(optimizedBot.rank(state).map(row => ({ moves: row.moves, value: row.value }))),
      plain(evaluatedBot.rank(state).map(row => ({ moves: row.moves, value: row.value }))));
  }
  assert.equal(model.trainingSteps, 35147);
});
