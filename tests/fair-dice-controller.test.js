'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rules } = require('../lib/fair-dice-rules.js');

const controller = fs.readFileSync(path.join(__dirname, '..', 'game-controller.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const PROOF_ID = '14509c37-a2bf-4b2c-80c8-e72b2234c30b';
const proof = {
  protocol: 'drand-quicknet-v1', request: { id: PROOF_ID }, dice: [6, 1],
  sha256: 'a'.repeat(64), sha256Input: 'canonical-independent-beacon', rerolls: 0,
};

function extractFunction(signature) {
  const start = controller.indexOf(signature);
  assert.notEqual(start, -1, `Production ${signature} must exist`);
  // shaDiceRoll destructures its argument; the first brace is not its body.
  let parameterDepth = 0;
  let parameterEnd = -1;
  for (let index = controller.indexOf('(', start); index < controller.length; index += 1) {
    if (controller[index] === '(') parameterDepth += 1;
    if (controller[index] === ')') parameterDepth -= 1;
    if (parameterDepth === 0) { parameterEnd = index; break; }
  }
  assert.notEqual(parameterEnd, -1, `Production ${signature} parameter list must close`);
  const bodyStart = controller.indexOf('{', parameterEnd + 1);
  let depth = 0;
  for (let index = bodyStart; index < controller.length; index += 1) {
    if (controller[index] === '{') depth += 1;
    if (controller[index] === '}') depth -= 1;
    if (depth === 0) return controller.slice(start, index + 1);
  }
  throw new Error(`Cannot extract ${signature}`);
}

const sources = [
  'function compactRollText(', 'function expandRollValues(', 'function boardDiceFaces(',
  'async function shaDiceRoll(', 'async function handleFairDiceFailure(',
  'function ensureAutoProgress(', 'async function openingRoll(', 'async function autoRoll(',
].map(extractFunction).join('\n');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, failed) => { resolve = ok; reject = failed; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

function rig(method, { mode = 'bot', persistProof = () => true } = {}) {
  const state = Object.assign(clone(rules.initialState('long')), {
    mode, roomCode: 'TEST-ROOM', startedAt: 1789689600000,
    analysis: mode === 'bot' ? { playerColor: 'white' } : undefined,
  });
  if (method === 'autoRoll') {
    rules.decideOpeningRoll(state, { id: 'white', color: 'white', die: 6 }, { id: 'dark', color: 'dark', die: 1 });
    rules.startOpeningTurn(state);
  }
  const authoritative = clone(state);
  const requested = deferred();
  const calls = [];
  const layer = { dataset: {} };
  const legacy = name => () => { calls.push(name); throw new Error('Protected rolls must not enter a legacy RNG path'); };
  const math = Object.create(Math);
  math.random = legacy('legacy-random');
  const context = {
    state, mode, remoteCode: 'TEST-ROOM', playerColor: 'white', opponentName: 'Bot',
    botAnalysisStartupGeneration: 1, botAnalysisRestorePending: false,
    isRolling: false, isAnimating: false, isChainingMove: false,
    fairDiceError: '', fairDiceInFlight: false, undoStack: [],
    botAnalysisVersion: 1, remoteVersion: 1, Date, Math: math, URL,
    location: { href: 'https://volzay.github.io/online-backgammon/room.html' },
    console: { warn: () => calls.push('warning') },
    window: {
      NarduApp: { getUser: () => ({ name: 'Owner' }) },
      NarduRooms: {
        fairDicePolicy: async () => ({ required: true }),
        requestFairDice: (code, request) => { calls.push(['request', code, clone(request)]); return requested.promise; },
        getGameState: async () => { calls.push('restore'); return { state: clone(authoritative), version: 2 }; },
      },
    },
    lang: () => 'ru', sideName: color => color, localizedName: name => name,
    isRemoteHost: () => true, isMyTurn: () => true,
    normalizeRestoredState: source => clone(source),
    cancelBotTurnActivity: () => calls.push('cancel-bot'),
    render: () => calls.push('render'),
    scheduleOpeningRoll: () => calls.push('progress-opening'),
    scheduleOpeningTurnRoll: () => calls.push('progress-opening-result'),
    scheduleAutoRoll: () => calls.push('progress-roll'),
    maybeScheduleAutoEndTurn: () => calls.push('progress-move'),
    schedule: () => calls.push('progress-bot'), playBotTurn: () => {},
    NarduSound: { prime: () => {}, dice: () => {} },
    NarduGame: {
      decideOpeningRoll: (...args) => { calls.push('apply-opening'); return rules.decideOpeningRoll(...args); },
      applyRoll: (...args) => { calls.push('apply-roll'); return rules.applyRoll(...args); },
      hasAnyMoves: source => rules.hasAnyMoves(source),
    },
    publishRemoteState: async () => {
      const hasProof = context.state.history.some(event => event.fairDiceProof?.request?.id === PROOF_ID);
      calls.push(hasProof ? 'persist-proof' : 'persist-checkpoint');
      return hasProof ? persistProof(context) : true;
    },
    document: { getElementById: id => id === 'board-dice-layer' ? layer : null },
    NarduBoardEngine: {
      animateOpeningRoll: async () => calls.push('animate-opening'),
      animateDiceRoll: async () => calls.push('animate-roll'),
    },
    trayRollAnimation: async () => calls.push('animate-tray'),
    finishOpeningRollAnimation: () => { context.isRolling = false; calls.push('finish-animation'); },
    finishTurnRollAnimation: () => { context.isRolling = false; calls.push('finish-animation'); },
    randomHex: legacy('legacy-seed'), sha256Hex: legacy('legacy-hash'),
    diceValuesFromHash: legacy('legacy-dice'),
  };
  vm.createContext(context);
  vm.runInContext(sources, context, { filename: 'game-controller.js extracted live dice functions' });
  return { context, calls, layer, authoritative, requested, run: () => context[method]() };
}

function count(calls, name) { return calls.filter(call => call === name || call?.[0] === name).length; }

function assertNoLegacy(calls) {
  assert.equal(calls.some(call => typeof call === 'string' && call.startsWith('legacy-')), false);
}

function applyAlreadyCommitted(rigged, method) {
  const state = rigged.context.state;
  if (method === 'openingRoll') {
    rules.decideOpeningRoll(state, { id: 'white', color: 'white', die: 6 }, { id: 'dark', color: 'dark', die: 1 });
    state.history[0].fairDiceProof = clone(proof);
    state.openingRoll.fairDiceProof = clone(proof);
  } else {
    rules.applyRoll(state, proof.dice.slice());
    state.history.unshift({ color: 'white', roll: '6:1', fairDiceProof: clone(proof), openingMove: true });
  }
}

for (const method of ['openingRoll', 'autoRoll']) {
  const application = method === 'openingRoll' ? 'apply-opening' : 'apply-roll';
  const animation = method === 'openingRoll' ? 'animate-opening' : 'animate-roll';

  test(`${method}: an authoritative proof applied during the await is never applied twice`, async () => {
    const r = rig(method);
    const running = r.run();
    await flush();
    assert.equal(count(r.calls, 'request'), 1);
    assert.equal(r.context.fairDiceInFlight, true);
    applyAlreadyCommitted(r, method);
    r.requested.resolve(clone(proof));
    await running;
    await flush();
    assert.equal(count(r.calls, application), 0);
    assert.equal(count(r.calls, 'persist-proof'), 0);
    assert.equal(count(r.calls, animation), 0);
    assert.equal(r.context.state.history.filter(event => event.fairDiceProof?.request?.id === PROOF_ID).length, 1);
    assert.equal(r.context.isRolling, false);
    assert.equal(r.context.fairDiceInFlight, false);
    assert.equal(count(r.calls, method === 'openingRoll' ? 'progress-opening-result' : 'progress-move'), 1);
    assertNoLegacy(r.calls);
  });

  test(`${method}: a phase advanced during the await discards the stale callback`, async () => {
    const r = rig(method);
    const running = r.run();
    await flush();
    r.context.state.phase = method === 'openingRoll' ? 'opening-result' : 'move';
    const snapshot = clone(r.context.state);
    r.requested.resolve(clone(proof));
    await running;
    assert.deepEqual(clone(r.context.state), snapshot);
    assert.equal(count(r.calls, application), 0);
    assert.equal(count(r.calls, 'persist-proof'), 0);
    assert.equal(count(r.calls, animation), 0);
    assert.equal(r.context.isRolling, false);
    assertNoLegacy(r.calls);
  });

  test(`${method}: a new startedAt epoch cannot receive the old proof`, async () => {
    const r = rig(method);
    const running = r.run();
    await flush();
    r.context.state = clone(r.authoritative);
    r.context.state.startedAt += 10000;
    const snapshot = clone(r.context.state);
    r.requested.resolve(clone(proof));
    await running;
    assert.deepEqual(clone(r.context.state), snapshot);
    assert.equal(count(r.calls, application), 0);
    assert.equal(count(r.calls, animation), 0);
    assert.equal(r.context.isRolling, false);
    assertNoLegacy(r.calls);
  });

  test(`${method}: normal proof publication is awaited before any dice animation`, async () => {
    const saved = deferred();
    const r = rig(method, { persistProof: () => saved.promise });
    const running = r.run();
    await flush();
    r.requested.resolve(clone(proof));
    await flush();
    assert.equal(count(r.calls, application), 1);
    assert.equal(count(r.calls, 'persist-proof'), 1);
    assert.equal(count(r.calls, animation), 0);
    assert.equal(count(r.calls, 'animate-tray'), 0);
    assert.equal(r.context.isRolling, true);
    saved.resolve(true);
    await running;
    await flush();
    assert.equal(count(r.calls, animation), 1);
    assert.equal(count(r.calls, 'animate-tray'), 1);
    assert.equal(count(r.calls, 'finish-animation'), 1);
    assert.equal(r.layer.dataset.boardDiceCount, '2');
    assert.ok(r.calls.indexOf('persist-proof') < r.calls.indexOf(animation));
    assert.equal(r.context.state.history.filter(event => event.fairDiceProof?.request?.id === PROOF_ID).length, 1);
    assertNoLegacy(r.calls);
  });

  test(`${method}: rejected protected persistence restores the authoritative board and stays paused`, async () => {
    const r = rig(method, { persistProof: () => false });
    const running = r.run();
    await flush();
    r.requested.resolve(clone(proof));
    await running;
    await flush();
    assert.equal(count(r.calls, application), 1);
    assert.equal(count(r.calls, 'request'), 1);
    assert.equal(count(r.calls, 'restore'), 1);
    assert.equal(count(r.calls, 'cancel-bot'), 1);
    assert.deepEqual(clone(r.context.state), r.authoritative);
    assert.match(r.context.fairDiceError, /этот же бросок сохранён/);
    assert.equal(r.context.isRolling, false);
    assert.equal(r.context.fairDiceInFlight, false);
    assert.equal(count(r.calls, animation), 0);
    assert.equal(count(r.calls, 'animate-tray'), 0);
    assert.equal(r.calls.some(call => typeof call === 'string' && call.startsWith('progress-')), false);
    assertNoLegacy(r.calls);
  });

  test(`${method}: unavailable beacon never falls through to local hash or RNG dice`, async () => {
    const r = rig(method);
    const running = r.run();
    await flush();
    r.requested.reject(new Error('Beacon unavailable'));
    await running;
    assert.equal(count(r.calls, application), 0);
    assert.equal(count(r.calls, 'request'), 1);
    assert.equal(count(r.calls, 'persist-proof'), 0);
    assert.equal(count(r.calls, animation), 0);
    assert.match(r.context.fairDiceError, /этот же бросок сохранён/);
    assert.equal(r.context.fairDiceInFlight, false);
    assertNoLegacy(r.calls);
  });

  test(`${method}: a protected remote publish failure is honored even without a boolean return`, async () => {
    const r = rig(method, { mode: 'remote', persistProof: async context => {
      await context.handleFairDiceFailure(new Error('Server rejected state'));
      return undefined;
    } });
    const running = r.run();
    await flush();
    r.requested.resolve(clone(proof));
    await running;
    assert.equal(count(r.calls, animation), 0);
    assert.equal(r.context.isRolling, false);
    assert.match(r.context.fairDiceError, /этот же бросок сохранён/);
    assert.deepEqual(clone(r.context.state), r.authoritative);
    assertNoLegacy(r.calls);
  });
}

test('autoRoll: a turn advanced while waiting cannot receive the previous color dice', async () => {
  const r = rig('autoRoll');
  const running = r.run();
  await flush();
  r.context.state.turn = 'dark';
  const snapshot = clone(r.context.state);
  r.requested.resolve(clone(proof));
  await running;
  assert.deepEqual(clone(r.context.state), snapshot);
  assert.equal(count(r.calls, 'apply-roll'), 0);
  assert.equal(count(r.calls, 'persist-proof'), 0);
  assert.equal(count(r.calls, 'animate-roll'), 0);
  assert.equal(r.context.isRolling, false);
  assertNoLegacy(r.calls);
});
