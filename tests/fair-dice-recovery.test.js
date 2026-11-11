// Proposed ONLY new recovery regressions; no production code modified.
// Mock crypto result tests controller wiring; cryptographic primitives retain their separate suite.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rules } = require('../lib/fair-dice-rules.js');

const controller = fs.readFileSync(path.join(__dirname, '..', 'game-controller.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const PUBLIC_KEY = 'a'.repeat(64);
const GAME_ID = '33333333-3333-4333-8333-333333333333';
const POLICY = { required: true, gameId: GAME_ID, protocol: 'system-csprng-v1' };
const PROOF_ID = '14509c37-a2bf-4b2c-80c8-e72b2234c30b';
const proof = {
  protocol: 'system-csprng-v1', request: { id: PROOF_ID }, dice: [6, 1],
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
  'function visualAnimationWithDeadline(',
  'async function shaDiceRoll(', 'async function verifyRestoredFairDiceState(', 'async function handleFairDiceFailure(',
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
    mode, roomCode: 'ABCD-EFGH', startedAt: 1789689600000,
    fairDice: clone(POLICY),
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
    state, mode, remoteCode: 'ABCD-EFGH', playerColor: 'white', opponentName: 'Bot',
    botAnalysisStartupGeneration: 1, botAnalysisRestorePending: false,
    waitingForLongBotExperience: () => false,
    isRolling: false, isAnimating: false, isChainingMove: false,
    fairDiceError: '', fairDiceInFlight: false, undoStack: [],
    botAnalysisVersion: 1, remoteVersion: 1, Date, Math: math, URL,
    location: { href: 'https://volzay.github.io/online-backgammon/room.html?room=ABCD-EFGH' },
    console: { warn: () => calls.push('warning') }, setTimeout, clearTimeout,
    window: {
      setTimeout,
      NarduApp: { getUser: () => ({ name: 'Owner' }) },
      NARDU_ENV: { fairDicePublicKey: PUBLIC_KEY },
      NarduFairDice: { verifyProof: async (value, options) => {
        calls.push(['verify-proof', clone(value), clone(options)]);
        assert.equal(options.publicKey, PUBLIC_KEY);
        const expected = { roomCode: 'ABCD-EFGH', gameId: GAME_ID, variant: 'long',
          label: method === 'openingRoll' ? 'opening' : 'roll',
          color: method === 'openingRoll' ? 'none' : 'white' };
        for (const key of Object.keys(expected)) {
          assert.equal(options.context[key], expected[key], `Verifier must pin independent ${key}`);
          assert.equal(value.request[key], options.context[key], `Signed request must match ${key}`);
        }
        assert.equal(value.protocol, POLICY.protocol);
        return { protocol: value.protocol, request: clone(value.request), dice: value.dice.slice(),
          reservationVerified: true, commitmentVerified: true, sourceVerified: false,
          independentSourceVerified: false, entropyVerified: false, priorPublicationVerified: false };
      } },
      NarduRooms: {
        fairDicePolicy: async () => clone(POLICY),
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
    DICE_VISUAL_TIMEOUT_MS: 1600,
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

function issue(method, dice = [6, 1]) {
  return { ...clone(proof), protocol: 'system-csprng-v1', request: { id: PROOF_ID, roomCode: 'ABCD-EFGH', gameId: GAME_ID,
    nonce: 1, label: method === 'openingRoll' ? 'opening' : 'roll',
    color: method === 'openingRoll' ? 'none' : 'white', variant: 'long',
    commitment: 'b'.repeat(64), createdAt: '2026-11-05T12:00:00.000Z', positionHash: 'c'.repeat(64) },
    dice: dice.slice(), requestHash: 'd'.repeat(64), receiptSignature: 'e'.repeat(128),
    commitReveal: { clientSeed: '1'.repeat(64), serverSeed: '2'.repeat(64), counter: 0, blocks: ['3'.repeat(64)] } };
}
function recoverFrom(r, saved, version = 2) {
  r.context.window.NarduRooms.getGameState = async () => {
    r.calls.push('restore');
    return { state: clone(saved), version, fairDice: clone(POLICY) };
  };
}
function committedState(r, method, issued) {
  const value = clone(r.authoritative);
  if (method === 'openingRoll') {
    rules.decideOpeningRoll(value, { id: 'white', color: 'white', die: issued.dice[0] },
      { id: 'dark', color: 'dark', die: issued.dice[1] });
    Object.assign(value.openingRoll, { fairDiceProof: clone(issued), sha256: issued.sha256,
      sha256Input: issued.sha256Input, rerolls: issued.rerolls });
    Object.assign(value.history[0], { fairDiceProof: clone(issued), sha256: issued.sha256,
      sha256Input: issued.sha256Input });
  } else {
    const rolled = issued.dice[0] === issued.dice[1]
      ? Array(4).fill(issued.dice[0]) : issued.dice.slice();
    rules.applyRoll(value, rolled);
    value.history.unshift({ color: 'white', roll: issued.dice.join(':'),
      fairDiceProof: clone(issued), sha256: issued.sha256, sha256Input: issued.sha256Input, openingMove: true });
  }
  return value;
}
function transportFailure() { return new TypeError('Response lost after the server committed the proof'); }
function assertPaused(r) {
  assert.ok(r.context.fairDiceError, 'An unresolved/unverified protected state must stay paused');
  assert.equal(r.context.fairDiceInFlight, false);
  assertNoLegacy(r.calls);
}

for (const method of ['openingRoll', 'autoRoll']) for (const mode of ['bot', 'remote']) {
  test(`${method}/${mode}: committed proof survives a lost state ACK and unlocks the same board`, async () => {
    const issued = issue(method);
    let saved;
    const r = rig(method, { mode, persistProof(context) {
      saved = clone(context.state);
      recoverFrom(r, saved);
      throw transportFailure();
    } });
    const running = r.run();
    await flush();
    r.requested.resolve(issued);
    await running;
    await flush();
    assert.equal(r.context.fairDiceError, '', 'Verified authoritative dice must not remain behind the sticky pause');
    assert.equal(r.context.fairDiceInFlight, false);
    assert.equal(r.context.isRolling, false);
    assert.equal(r.context.state.phase, method === 'openingRoll' ? 'opening-result' : 'move');
    assert.equal(r.context.state.history.filter(event => event.fairDiceProof?.request?.id === PROOF_ID).length, 1);
    assert.equal(count(r.calls, method === 'openingRoll' ? 'apply-opening' : 'apply-roll'), 1);
    assert.equal(count(r.calls, 'request'), 1, 'Recovery must not obtain replacement dice');
    assert.equal(count(r.calls, 'verify-proof'), 1, 'Recovery must cryptographically verify the saved proof');
    assert.equal(r.context[mode === 'bot' ? 'botAnalysisVersion' : 'remoteVersion'], 2);
    assert.ok(r.calls.some(call => call === (method === 'openingRoll' ? 'progress-opening-result' : 'progress-move')),
      'After verified restoration the ordinary progression path must resume');
    assertNoLegacy(r.calls);
  });

  test(`${method}/${mode}: recovery of the old pre-roll state stays paused without replacement dice`, async () => {
    const r = rig(method, { mode, persistProof() { throw transportFailure(); } });
    const running = r.run();
    await flush();
    r.requested.resolve(issue(method));
    await running;
    assertPaused(r);
    assert.equal(count(r.calls, 'request'), 1);
    assert.equal(r.context.state.phase, method === 'openingRoll' ? 'opening' : 'roll');
  });

  test(`${method}/${mode}: an explicit 422 verification failure never automatically resumes`, async () => {
    const r = rig(method, { mode });
    const saved = committedState(r, method, issue(method));
    recoverFrom(r, saved);
    await r.context.handleFairDiceFailure(Object.assign(new Error('Invalid protected proof'),
      { status: 422, code: 'FAIR_DICE_MISMATCH' }));
    assertPaused(r);
    assert.equal(count(r.calls, 'request'), 0);
    assert.equal(count(r.calls, 'verify-proof'), 0);
  });
}

for (const variation of ['dice', 'version', 'epoch', 'roomCode', 'gameId', 'protocol', 'variant', 'label', 'color', 'signature']) {
  test(`autoRoll: restored ${variation} mismatch is not a valid recovery`, async () => {
    const r = rig('autoRoll');
    const saved = committedState(r, 'autoRoll', issue('autoRoll'));
    let version = 2;
    if (variation === 'dice') saved.rolled = [3, 4];
    if (variation === 'version') version = NaN;
    if (variation === 'epoch') saved.startedAt += 1;
    if (variation === 'roomCode') saved.history[0].fairDiceProof.request.roomCode = 'JKLM-NPQR';
    if (variation === 'gameId') saved.history[0].fairDiceProof.request.gameId = '44444444-4444-4444-8444-444444444444';
    if (variation === 'protocol') saved.history[0].fairDiceProof.protocol = 'drand-quicknet-v1';
    if (variation === 'variant') saved.history[0].fairDiceProof.request.variant = 'short';
    if (variation === 'label') saved.history[0].fairDiceProof.request.label = 'opening';
    if (variation === 'color') saved.history[0].fairDiceProof.request.color = 'dark';
    if (variation === 'signature') r.context.window.NarduFairDice.verifyProof = async () => {
      r.calls.push('verify-rejected'); throw Object.assign(new Error('Signature mismatch'), { code: 'FAIR_RECEIPT_INVALID' });
    };
    recoverFrom(r, saved, version);
    await r.context.handleFairDiceFailure(transportFailure());
    assertPaused(r);
    assert.equal(count(r.calls, 'request'), 0);
    assert.equal(r.calls.some(call => typeof call === 'string' && call.startsWith('progress-')), false);
  });
}

test('autoRoll: matching doubles recover the four expanded rolled dice, not just two dice', async () => {
  const r = rig('autoRoll');
  const saved = committedState(r, 'autoRoll', issue('autoRoll', [4, 4]));
  recoverFrom(r, saved);
  await r.context.handleFairDiceFailure(transportFailure());
  assert.equal(r.context.fairDiceError, '');
  assert.deepEqual(clone(r.context.state.rolled), [4, 4, 4, 4]);
  assert.equal(count(r.calls, 'request'), 0);
  assertNoLegacy(r.calls);
});

for (const delayedAt of ['get', 'verify']) test(`old asynchronous ${delayedAt} recovery cannot replace or pause a newer game`, async () => {
  const r = rig('autoRoll');
  const saved = committedState(r, 'autoRoll', issue('autoRoll'));
  const pending = deferred();
  if (delayedAt === 'get') r.context.window.NarduRooms.getGameState = async () => {
    r.calls.push('restore'); return pending.promise;
  };
  else {
    recoverFrom(r, saved);
    r.context.window.NarduFairDice.verifyProof = async () => {
      r.calls.push('verify-pending'); return pending.promise;
    };
  }
  const running = r.context.handleFairDiceFailure(transportFailure());
  await flush();
  assert.equal(count(r.calls, delayedAt === 'get' ? 'restore' : 'verify-pending'), 1, 'The delayed boundary must actually be reached');
  const fresh = clone(r.authoritative);
  fresh.startedAt += 10000;
  fresh.roomCode = 'JKLM-NPQR';
  r.context.state = fresh;
  r.context.remoteCode = fresh.roomCode;
  r.context.botAnalysisStartupGeneration += 1;
  r.context.fairDiceError = '';
  const untouched = clone(fresh);
  pending.resolve(delayedAt === 'get'
    ? { state: saved, version: 2, fairDice: clone(POLICY) }
    : { commitmentVerified: true, reservationVerified: true });
  await running;
  assert.deepEqual(clone(r.context.state), untouched, 'Stale recovery must not restore the old board');
  assert.equal(r.context.fairDiceError, '', 'Stale recovery must not poison the new game');
  assertNoLegacy(r.calls);
});

for (const method of ['openingRoll', 'autoRoll']) test(`${method}: old request rejection cannot poison the game opened before the handler starts`, async () => {
  const r = rig(method);
  const running = r.run();
  await flush();
  assert.equal(count(r.calls, 'request'), 1);
  const fresh = clone(r.authoritative);
  fresh.startedAt += 10000;
  fresh.roomCode = 'JKLM-NPQR';
  r.context.state = fresh;
  r.context.remoteCode = fresh.roomCode;
  r.context.botAnalysisStartupGeneration += 1;
  r.context.fairDiceError = '';
  r.context.isRolling = true;
  r.context.fairDiceInFlight = true;
  const untouched = clone(fresh);
  r.requested.reject(transportFailure());
  await running;
  assert.deepEqual(clone(r.context.state), untouched);
  assert.equal(r.context.fairDiceError, '', 'The rejection belongs to an old request, not the newly opened game');
  assert.equal(r.context.isRolling, true, 'Old cleanup cannot cancel the new game roll');
  assert.equal(r.context.fairDiceInFlight, true);
  assert.equal(count(r.calls, 'restore'), 0);
  assertNoLegacy(r.calls);
});


function startupEchoRig({ restored = true, rejectBackground = true, deferredRestore = null } = {}) {
  const r = rig('autoRoll');
  const c = r.context;
  const saved = committedState(r, 'autoRoll', issue('autoRoll'));
  recoverFrom(r, saved, 2);
  const timers = [];
  const writes = [];
  Object.assign(c, {
    state: clone(saved), botAnalysisStartupPromise: null,
    botAnalysisConflictRedirected: false, botAnalysisReady: false,
    botAnalysisDisabled: false, botAnalysisOwnershipUnknown: false,
    botAnalysisRestorePending: true, gameOverPublishPromise: null,
    variant: 'long', botDifficulty: 'hard', pending: {}, undoStack: [],
    BOT_ANALYSIS_RESTORE_TIMEOUT_MS: 5000, LONG_BOT_EXPERIENCE_STARTUP_WAIT_MS: 1000,
    promiseWithTimeout: value => Promise.resolve(value),
    restoreBotAnalysisState: async () => {
      if (deferredRestore) return deferredRestore.promise;
      c.botAnalysisReady = true;
      c.botAnalysisVersion = restored ? 2 : 0;
      return restored ? clone(saved) : null;
    },
    retainMatchedBotTelemetry: value => value,
    adoptBotIdentity: () => r.calls.push('startup-adopt-identity'),
    attachRuntimeStateFields: () => {},
    validateNeuralBotAvailability: () => true,
    longBotExperienceSessionKey: () => 'same-game',
    persistBotGameConfig: () => {},
    restoreCurrentTurnUndo: () => [],
    persistRoomSnapshot: () => r.calls.push('startup-snapshot'),
    ensureAutoProgressAfterExperience: () => r.calls.push('startup-progress'),
    invalidateBotAnalysisEnsureAttempt: () => {},
    canPublishBotAnalysis: () => true,
    ensureBotAnalysisRoomReady: async () => true,
  });
  c.window.setTimeout = (callback, ms) => { timers.push({ callback, ms }); return timers.length; };
  c.window.NarduRooms.putGameState = async () => {
    r.calls.push('startup-background-put');
    if (rejectBackground) throw Object.assign(new Error('Unneeded metadata checkpoint rejected'), { status: 422 });
    return { version: 3 };
  };
  c.publishBotAnalysisState = () => {
    const writing = c.writeBotAnalysisPayload({ payload: clone(c.state),
      generation: c.botAnalysisStartupGeneration, code: c.remoteCode });
    writes.push(writing); return writing;
  };
  vm.runInContext([
    'function runBotAnalysisStartup(', 'function queueBotAnalysisPublish(',
    'async function writeBotAnalysisPayload(',
  ].map(extractFunction).join('\n'), c);
  return { ...r, saved, timers,
    start: () => c.runBotAnalysisStartup({ url: new URL(c.location.href), roomCode: c.remoteCode,
      startupGeneration: c.botAnalysisStartupGeneration, publishDelay: 200, skipAutoStart: false }),
    drain: async () => {
      for (const timer of timers.splice(0)) timer.callback();
      await Promise.all(writes);
      await flush();
    } };
}

test('startup restored: a failed unnecessary metadata echo cannot pause an already authoritative move', async () => {
  const r = startupEchoRig();
  assert.equal(await r.start(), true);
  assert.deepEqual(clone(r.context.state), clone(r.saved));
  assert.equal(r.context.botAnalysisVersion, 2);
  await r.drain();
  assert.equal(r.context.fairDiceError, '', 'An accepted saved move must not be frozen by a startup echo');
  assert.equal(count(r.calls, 'startup-background-put'), 0, 'Authoritative restore needs no additional metadata PUT');
  assert.equal(count(r.calls, 'startup-snapshot'), 1);
  assert.equal(count(r.calls, 'startup-progress'), 1);
  assert.equal(count(r.calls, 'request'), 0);
  assert.equal(r.context.botAnalysisRestorePending, false);
  assert.equal(r.context.botAnalysisReady, true);
  assertNoLegacy(r.calls);
});

test('startup new room: an initial confirmed reservation still queues its initial state publication', async () => {
  const r = startupEchoRig({ restored: false, rejectBackground: false });
  assert.equal(await r.start(), true);
  assert.equal(r.timers.length, 1);
  await r.drain();
  assert.equal(count(r.calls, 'startup-background-put'), 1);
  assert.equal(count(r.calls, 'startup-progress'), 1);
  assert.equal(r.context.botAnalysisVersion, 3);
  assert.equal(r.context.fairDiceError, '');
  assertNoLegacy(r.calls);
});

test('startup old generation: a late restore cannot queue a publication or change the new game', async () => {
  const pendingRestore = deferred();
  const r = startupEchoRig({ deferredRestore: pendingRestore });
  const running = r.start();
  await flush();
  const fresh = clone(r.saved);
  fresh.startedAt += 10000;
  r.context.state = fresh;
  r.context.botAnalysisStartupGeneration += 1;
  const newerStartup = Promise.resolve('new startup owns this slot');
  r.context.botAnalysisStartupPromise = newerStartup;
  r.context.botAnalysisReady = true;
  r.context.botAnalysisRestorePending = false;
  pendingRestore.resolve(r.saved);
  assert.equal(await running, false);
  assert.deepEqual(clone(r.context.state), fresh);
  assert.equal(r.context.botAnalysisStartupPromise, newerStartup);
  assert.equal(r.timers.length, 0);
  assert.equal(count(r.calls, 'startup-progress'), 0);
  assert.equal(count(r.calls, 'startup-background-put'), 0);
  assert.equal(r.context.fairDiceError, '');
  assertNoLegacy(r.calls);
});
