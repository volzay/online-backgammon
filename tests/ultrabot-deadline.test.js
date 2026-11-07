'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const neural = require('../lib/long-bot-neural-v2');
const { createCore } = require('../experiments/ultrabot/fast-inference');
const core = require('../lib/long-bot-neural');
const { model } = require('../vendor/long-neural/model-v2.json');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const adapterScope = { self: {} };
vm.runInNewContext(read('experiments/ultrabot/fast-rules.js'), adapterScope);
const { createAdapter } = adapterScope.self.NarduUltrabotRules;

function nativeGame() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(read('game.js'), context);
  return context.window.NarduGame;
}

function roll(game, dice, extra = {}) {
  const state = { ...game.initialState('long'), turn: 'white', phase: 'roll', ...extra };
  game.applyRoll(state, dice);
  return state;
}

test('preview search keeps the native maximal afterstates and exact V2 witness order', () => {
  const game = nativeGame();
  const fast = createAdapter(game, () => {});
  const lastChecker = {
    points: { 1: { color: 'white', count: 1 }, 12: { color: 'dark', count: 15 } },
    off: { white: 14, dark: 0 },
  };
  const manyWhite = Object.fromEntries([24, 22, 20, 18, 16, 14, 10, 4]
    .map((point, index) => [point, { color: 'white', count: index === 7 ? 1 : 2 }]));
  const fixtures = [
    roll(game, [3, 3, 3, 3]),
    roll(game, [4, 4, 4, 4], { turn: 'dark' }),
    roll(game, [1, 2], lastChecker),
    roll(game, [1, 2], { points: {
      24: { color: 'white', count: 15 }, 22: { color: 'dark', count: 1 },
      23: { color: 'dark', count: 1 }, 12: { color: 'dark', count: 13 },
    } }),
    roll(game, [1, 1, 1, 1], {
      points: { ...manyWhite, 12: { color: 'dark', count: 15 } },
      firstMoveDone: { white: true, dark: true },
    }),
  ];
  const partial = plain(fixtures[0]);
  assert(game.applyMove(partial, 24, 3, { autoEnd: false }));
  fixtures.push(partial);
  for (const state of fixtures) {
    const before = plain(state);
    const native = game.bestMoveSequences(plain(state));
    const first = fast.firstBestMoveSequence(state);
    const key = moves => JSON.stringify(moves.map(({ from, die }) => [from, die]));
    assert(native.some(sequence => key(sequence) === key(first)));
    const rows = api => neural.enumerateUniqueTurns(api, state).rows
      .map(({ sequenceKey, positionKey }) => [sequenceKey, positionKey]);
    assert.deepEqual(rows(fast), rows(game));
    assert.deepEqual(plain(state), before);
  }
});

test('typed frozen-model inference preserves the original numeric result', () => {
  const game = nativeGame();
  const frozen = Object.freeze({ ...model, inputWeights: Object.freeze(model.inputWeights.slice()),
    hiddenBias: Object.freeze(model.hiddenBias.slice()), outputWeights: Object.freeze(model.outputWeights.slice()) });
  let checks = 0;
  const accelerated = createCore(core, () => { checks++; });
  const state = roll(game, [3, 4]);
  for (const color of ['white', 'dark']) {
    assert(Object.is(accelerated.predict(frozen, state, color), core.predict(frozen, state, color)));
  }
  assert.equal(checks, 2);
});

function workerMessages(state, cutOffSearch, loadAdviser = true) {
  const workerDir = path.join(root, 'experiments/ultrabot');
  const messages = [];
  let clock = 0;
  const context = vm.createContext({
    URL, TextEncoder, TextDecoder, performance: { now: () => clock },
    location: { href: 'http://127.0.0.1/online-backgammon/experiments/ultrabot/worker.js' },
  });
  context.self = context;
  context.importScripts = (...paths) => {
    for (const file of paths) {
      if (!loadAdviser && file.endsWith('/long-bot-engine.js')) throw new Error('Test adviser unavailable');
      vm.runInContext(fs.readFileSync(path.resolve(workerDir, file), 'utf8'), context);
    }
  };
  context.postMessage = message => {
    messages.push(plain(message));
    if (message.stage === 'provisional' && message.search === cutOffSearch) clock = 9000;
  };
  vm.runInContext(read('experiments/ultrabot/worker.js'), context);
  context.onmessage({ data: { id: 'ultrabot-player-test-v1', state } });
  return messages;
}

test('a deadline returns the latest certified neural forecast', () => {
  const game = nativeGame();
  const state = roll(game, [3, 4]);
  const expected = neural.createNeuralBot(game, model, {
    maxCandidates: 32, replyTopCandidates: 6, replyCandidates: 4, replyWeight: 0.35,
  }).plan(state);
  const full = workerMessages(state, 'full');
  assert.equal(full.at(-1).stage, 'complete');
  assert.equal(full.at(-1).search, 'full');
  assert.deepEqual(full.at(-1).moves, plain(expected));
  const cutOff = workerMessages(state, 'static');
  assert.equal(cutOff.at(-1).stage, 'complete');
  assert.equal(cutOff.at(-1).search, 'static');
  assert.deepEqual(cutOff.at(-1).moves, cutOff.at(-2).moves);
});

const stacks = (color, counts) => Object.fromEntries(Object.entries(counts)
  .map(([point, count]) => [point, { color, count }]));

test('positional review prefers home entry over rearranging two checkers already home', () => {
  const game = nativeGame();
  const state = roll(game, [4, 1], {
    points: {
      ...stacks('white', { 1: 1, 3: 4, 4: 4, 5: 2, 6: 2, 11: 1, 20: 1 }),
      ...stacks('dark', { 13: 3, 14: 1, 15: 1, 16: 3, 17: 2, 18: 4, 21: 1 }),
    },
    firstMoveDone: { white: true, dark: true },
  });
  const messages = workerMessages(state);
  const neural = messages.find(message => message.stage === 'provisional' && message.search === 'full');
  const selected = messages.at(-1);
  assert.deepEqual(neural.moves, [{ from: 6, die: 1 }, { from: 5, die: 4 }]);
  assert.equal(selected.stage, 'complete');
  assert.equal(selected.search, 'full');
  assert.deepEqual(selected.moves, [{ from: 11, die: 1 }, { from: 10, die: 4 }]);
  const missingAdviser = workerMessages(state, undefined, false).at(-1);
  assert.equal(missingAdviser.stage, 'complete');
  assert.equal(missingAdviser.search, 'full');
  assert.deepEqual(missingAdviser.moves, neural.moves);
});

test('under Mars pressure the forecast helps the rear checker around occupied points', () => {
  const game = nativeGame();
  const state = roll(game, [3, 1], {
    turn: 'dark',
    points: {
      ...stacks('white', { 1: 4, 5: 2, 6: 5, 9: 3, 10: 1 }),
      ...stacks('dark', { 3: 1, 4: 1, 7: 1, 8: 1, 11: 1, 13: 1, 15: 1, 16: 5, 17: 2, 18: 1 }),
    },
    firstMoveDone: { white: true, dark: true },
  });
  const messages = workerMessages(state);
  const prior = messages.at(-2);
  const rescue = messages.at(-1);
  assert.equal(prior.stage, 'provisional');
  assert.equal(prior.search, 'full');
  assert.deepEqual(prior.moves, [{ from: 3, die: 1 }, { from: 2, die: 3 }]);
  assert.equal(rescue.stage, 'complete');
  assert.deepEqual(rescue.moves, [{ from: 11, die: 3 }, { from: 3, die: 1 }]);
  assert(game.bestMoveSequences(state).some(sequence => sequence.length === rescue.moves.length
    && sequence.every(({ from, die }, index) => from === rescue.moves[index].from
      && die === rescue.moves[index].die)));
});

test('route advice cannot override the plan if it leaves the slowest checkers blocked', () => {
  const game = nativeGame();
  const state = roll(game, [4, 1], {
    points: {
      ...stacks('white', { 1: 2, 3: 1, 5: 1, 8: 1, 10: 5, 11: 2, 19: 1, 23: 2 }),
      ...stacks('dark', { 2: 1, 6: 1, 9: 1, 13: 4, 14: 2, 15: 3, 16: 1, 17: 1, 18: 1 }),
    },
    firstMoveDone: { white: true, dark: true },
  });
  const messages = workerMessages(state);
  assert.equal(messages.at(-1).stage, 'complete');
  assert.deepEqual(messages.at(-1).moves, [{ from: 8, die: 1 }, { from: 7, die: 4 }]);
});

test('client keeps the latest certified provisional move when the 12-second watchdog fires', async () => {
  const location = new URL('https://example.test/online-backgammon/ultrabot/');
  let worker;
  let timeout;
  let stopped = 0;
  const context = vm.createContext({
    URL, URLSearchParams, window: { location },
    document: { currentScript: { src: new URL('../experiments/ultrabot/player-test.js', location).href } },
    Worker: class {
      constructor() { worker = this; }
      postMessage() {}
      terminate() { stopped++; }
    },
    setTimeout(callback, ms) { assert.equal(ms, 12000); timeout = callback; return 1; },
    clearTimeout() {},
  });
  vm.runInContext(read('experiments/ultrabot/player-test.js'), context);
  const plan = context.window.NarduUltrabotTest.plan({});
  const reply = (stage, moves) => worker.onmessage({ data: { id: 'ultrabot-player-test-v1', ok: true, stage, moves } });
  reply('provisional', [{ from: 24, die: 3 }]);
  reply('provisional', [{ from: 24, die: 4 }]);
  timeout();
  assert.deepEqual(plain(await plan), [{ from: 24, die: 4 }]);
  assert.equal(stopped, 1);
  const noCertificate = context.window.NarduUltrabotTest.plan({});
  timeout();
  await assert.rejects(noCertificate, /не успел выбрать ход/);
});
