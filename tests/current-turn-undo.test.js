'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const NOW = 1789732800000;
const clone = value => JSON.parse(JSON.stringify(value));
function storage() {
  const values = new Map();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] || null,
    getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key) };
}

function harness() {
  const pending = new Map();
  let timerId = 0;
  const setTimer = (callback, ms) => { const id = ++timerId; pending.set(id, { callback, ms }); return id; };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const math = Object.create(Math);
  math.random = () => { throw new Error('Undo must not generate any dice or random value'); };
  const undoButton = { disabled: true, title: '', addEventListener() {} };
  const calls = { published: [] };
  const window = { addEventListener() {}, setTimeout: setTimer,
    NarduApp: { getUser: () => ({ id: 'undo-user', name: 'Tester' }), paintUser() {}, formatRating: () => '1500' },
    NarduSound: { click() {} } };
  const context = { window, Date: FixedDate, Math: math, JSON, URL, Uint8Array, TextEncoder,
    console: { warn() {}, log() {} }, localStorage: storage(), sessionStorage: storage(),
    setTimeout: setTimer, clearTimeout: id => pending.delete(id), setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: callback => callback(),
    document: { hidden: false, visibilityState: 'visible', addEventListener() {},
      getElementById: id => id === 'undo-btn' ? undoButton : null,
      querySelector: () => null, querySelectorAll: () => [], body: { classList: { remove() {}, add() {} } } },
    location: { href: 'https://example.test/room.html?mode=bot&game=QM5N-CCQG&variant=long&difficulty=easy',
      pathname: '/room.html', search: '?mode=bot&game=QM5N-CCQG&variant=long&difficulty=easy', hostname: 'example.test' },
    history: { replaceState() {} } };
  window.window = window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context);
  context.NarduGame = window.NarduGame;
  context.NarduSound = window.NarduSound;
  const marker = '    preferredMoveAction,\n  };';
  const source = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8');
  assert.ok(source.includes(marker));
  vm.runInContext(source.replace(marker, `    preferredMoveAction,
    __undoTest: { restoreCurrentTurnUndo, cloneStateForUndo, undoLastMove, applyRemoteState,
      getUndo: () => undoStack, startup: () => botAnalysisStartupPromise,
      setState(next, ownColor = next.turn) { state = next; variant = next.variant; mode = 'hotseat';
        playerColor = ownColor; remoteCode = ''; botAnalysisRestorePending = false; },
      setUndo(next) { undoStack = next; } },
  };`), context);
  return { context, window, game: window.NarduGame, controller: window.NarduController,
    api: window.NarduController.__undoTest, pending, undoButton, calls };
}

function position(h, { variant = 'long', color = 'white', points, bar = { white: 0, dark: 0 },
  rolled = [1, 5], firstMoveDone = { white: true, dark: true }, historyLength = 1 } = {}) {
  const state = h.game.initialState(variant);
  Object.assign(state, { turn: color, phase: 'roll', points: points || state.points, bar,
    score: { white: 1000, dark: 1000 }, firstMoveDone,
    mode: 'bot', botDifficulty: 'easy', roomCode: 'QM5N-CCQG',
    startedAt: NOW - 60000, gameId: 'accepted-game-epoch', fairDiceGameId: 'accepted-game-epoch',
    fairDice: { protocol: 'system-csprng-v1', required: true, gameId: 'accepted-game-epoch', policyVersion: 1 },
    rollToken: 'roll:accepted-fixed-roll', openingRoll: { winnerColor: color, immutableMarker: 'opening-proof' },
    turnClock: { white: 1200, dark: 2300, active: color, startedAt: NOW },
    analysis: { retainedPrivateDecisions: [{ id: 'existing-analysis' }] } });
  h.game.applyRoll(state, rolled);
  const proof = { protocol: 'system-csprng-v1', request: { id: 'issued-roll', gameId: state.gameId,
    nonce: 73, roomCode: state.roomCode, color }, dice: rolled.slice(0, 2), sha256: 'a'.repeat(64),
    sha256Input: 'immutable-accepted-source' };
  state.history = [{ color, roll: rolled.slice(0, 2).join(':'), sha256: proof.sha256,
    sha256Input: proof.sha256Input, fairDiceProof: proof, at: '2026-09-18T10:00:00.000Z' },
  ...Array.from({ length: historyLength - 1 }, (_, index) => ({ previousTurn: index,
    ...(index === 0 ? { fairDiceProof: { request: { id: 'older-issued-roll', nonce: 72 } } } : {}) }))];
  return state;
}

function acceptedMoves(h, state, moves) {
  const snapshots = [];
  for (const move of moves) {
    snapshots.push(clone(h.api.cloneStateForUndo(state)));
    assert.equal(h.game.applyMove(state, move.from, move.die, { autoEnd: false }), true);
  }
  assert.equal(state.phase, 'move');
  assert.equal(state.winner, null);
  return snapshots;
}

test('QM5N-CCQG: authoritative 10→9 with 1:5 restores the first accepted checker undo, not a new roll', () => {
  const h = harness();
  const state = position(h, { points: { 24: { color: 'white', count: 14 }, 10: { color: 'white', count: 1 },
    12: { color: 'dark', count: 15 } }, historyLength: 216 });
  const expected = acceptedMoves(h, state, [{ from: 10, die: 1 }]);
  const before = clone(state);
  assert.equal(state.history.length, 217);
  assert.deepEqual(clone(state.dice), [5]);
  const actual = clone(h.api.restoreCurrentTurnUndo(state));
  assert.deepEqual(actual, expected);
  assert.deepEqual(clone(state), before, 'restoration is read-only even for proofs/private analysis');
  assert.equal(actual[0].history[0].fairDiceProof.request.nonce, 73);
  assert.equal(actual[0].fairDiceGameId, before.fairDiceGameId);
  assert.deepEqual(actual[0].firstMoveDone, { white: true, dark: true });
  assert.deepEqual(actual[0].headPlayedThisTurn, { white: false, dark: false });
});

test('JSONB-like reordering of nested counters, points, move fields and flags cannot discard valid undo', () => {
  const h = harness();
  const state = position(h, { rolled: [3, 3, 3, 3], firstMoveDone: { white: false, dark: true } });
  const expected = acceptedMoves(h, state, clone(h.game.bestMoveSequences(state)[0]));
  const reorder = value => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reorder(value[key])])) : value;
  const fromJsonb = reorder(clone(state));
  for (const field of ['bar', 'off', 'score', 'firstMoveDone', 'headPlayedThisTurn']) {
    fromJsonb[field] = { dark: fromJsonb[field].dark, white: fromJsonb[field].white };
    assert.deepEqual(Object.keys(fromJsonb[field]), ['dark', 'white']);
  }
  const before = clone(fromJsonb);
  assert.deepEqual(clone(h.api.restoreCurrentTurnUndo(fromJsonb)), expected);
  assert.deepEqual(fromJsonb, before);
});

for (const color of ['white', 'dark']) {
  test(`long ${color}: restoring an initial head move keeps the exact first-move/head allowance`, () => {
    const h = harness();
    const state = position(h, { color, rolled: [2, 4], firstMoveDone: { white: false, dark: false } });
    const head = h.game.headPoint(color, state);
    const expected = acceptedMoves(h, state, [{ from: head, die: 2 }]);
    assert.equal(state.headPlayedThisTurn[color], true);
    assert.deepEqual(clone(h.api.restoreCurrentTurnUndo(state)), expected);
  });

  test(`long ${color}: doubles restore all four accepted snapshots and exact remaining dice`, () => {
    const h = harness();
    const state = position(h, { color, rolled: [3, 3, 3, 3], firstMoveDone: { white: false, dark: false } });
    const moves = clone(h.game.bestMoveSequences(state, color)[0]);
    assert.equal(moves.length, 4);
    const expected = acceptedMoves(h, state, moves);
    assert.deepEqual(clone(h.api.restoreCurrentTurnUndo(state)), expected);
  });

  for (const variant of ['long', 'short']) {
    test(`${variant} ${color}: bearing off restores exact points/off/score and original issued roll`, () => {
      const h = harness();
      const near = color === 'white' ? 2 : variant === 'long' ? 14 : 23;
      const home = color === 'white' ? 1 : variant === 'long' ? 13 : 24;
      const opponent = color === 'white' ? 'dark' : 'white';
      const otherPoint = color === 'white' ? 19 : 6;
      const state = position(h, { variant, color, rolled: [2, 5], points: {
        [near]: { color, count: 2 }, [home]: { color, count: 13 }, [otherPoint]: { color: opponent, count: 15 } } });
      const expected = acceptedMoves(h, state, [{ from: near, die: 2 }]);
      assert.equal(state.off[color], 1);
      assert.deepEqual(clone(h.api.restoreCurrentTurnUndo(state)), expected);
    });
  }

  test(`short ${color}: bar entry plus a hit restores both bars and the captured blot`, () => {
    const h = harness();
    const opponent = color === 'white' ? 'dark' : 'white';
    const hitPoint = color === 'white' ? 23 : 2;
    const ownPoint = color === 'white' ? 1 : 24;
    const otherPoint = color === 'white' ? 18 : 7;
    const state = position(h, { variant: 'short', color, rolled: [2, 4],
      bar: { white: color === 'white' ? 1 : 0, dark: color === 'dark' ? 1 : 0 }, points: {
        [ownPoint]: { color, count: 14 }, [hitPoint]: { color: opponent, count: 1 },
        [otherPoint]: { color: opponent, count: 14 } } });
    const expected = acceptedMoves(h, state, [{ from: h.game.barPoint(color), die: 2 }]);
    assert.equal(state.bar[color], 0);
    assert.equal(state.bar[opponent], 1);
    assert.equal(state.history[0].hit, true);
    assert.deepEqual(clone(h.api.restoreCurrentTurnUndo(state)), expected);
  });

  test(`short ${color}: two normal moves after a hit recover the matching intermediate position`, () => {
    const h = harness();
    const opponent = color === 'white' ? 'dark' : 'white';
    const from = color === 'white' ? 8 : 17;
    const hitPoint = color === 'white' ? 5 : 20;
    const ownPoint = color === 'white' ? 6 : 19;
    const otherPoint = color === 'white' ? 19 : 6;
    const state = position(h, { variant: 'short', color, rolled: [3, 1], points: {
      [from]: { color, count: 1 }, [ownPoint]: { color, count: 14 },
      [hitPoint]: { color: opponent, count: 1 }, [otherPoint]: { color: opponent, count: 14 } } });
    const expected = acceptedMoves(h, state, [{ from, die: 3 }, { from: hitPoint, die: 1 }]);
    assert.deepEqual(clone(h.api.restoreCurrentTurnUndo(state)), expected);
  });
}

test('restored undo never rolls back elapsed clocks or unrelated analysis/evidence metadata', () => {
  const h = harness();
  const state = position(h, { rolled: [2, 4] });
  const expected = acceptedMoves(h, state, [{ from: 24, die: 2 }]);
  h.api.setState(state);
  h.api.setUndo(h.api.restoreCurrentTurnUndo(state));
  state.turnClock = { white: 45678, dark: 34567, active: 'white', startedAt: NOW - 1000 };
  h.api.undoLastMove();
  const actual = clone(h.controller.getState());
  assert.deepEqual(actual, { ...expected[0], turnClock: { white: 46678, dark: 34567, active: 'white', startedAt: NOW } });
  assert.equal(h.api.getUndo().length, 0);
  assert.equal(h.undoButton.disabled, true);
});

test('incomplete, illegal, mismatched or ended-turn states fail closed without partial undo snapshots', () => {
  const h = harness();
  const state = position(h, { rolled: [2, 4] });
  acceptedMoves(h, state, [{ from: 24, die: 2 }]);
  const cases = {
    'ended turn': value => { h.game.endTurn(value); },
    winner: value => { value.winner = 'white'; },
    'over phase': value => { value.phase = 'over'; },
    'too many moves': value => { value.turnMoves = Array(5).fill(value.turnMoves[0]); },
    'empty moves': value => { value.turnMoves = []; },
    'missing matching roll': value => { value.history = value.history.slice(0, 1); },
    'wrong roll': value => { value.history[1].roll = '2:5'; },
    'opponent roll': value => { value.history[1].color = 'dark'; },
    'proof dice mismatch': value => { value.history[1].fairDiceProof.dice = [3, 4]; },
    'wrong newest history move': value => { value.history[0].from = 23; },
    'wrong newest history color': value => { value.history[0].color = 'dark'; },
    'missing hit evidence': value => { delete value.history[0].hit; },
    'forged hit': value => { value.history[0].hit = true; value.history[0].hitColor = 'dark'; },
    'move bearing an issued proof': value => { value.history[0].fairDiceProof = value.history[1].fairDiceProof; },
    'remaining dice mismatch': value => { value.dice = [2]; },
    'invalid expanded doubles': value => { value.rolled = [2, 2]; },
    'missing first-move flag': value => { delete value.firstMoveDone.dark; },
    'wrong head allowance': value => { value.headPlayedThisTurn.white = false; },
    'wrong opponent head allowance': value => { value.headPlayedThisTurn.dark = true; },
    'impossible reverse score': value => { value.score.white = 1; },
    'invalid checker total': value => { value.points[12].count = 14; },
    'mismatching move destination': value => { value.turnMoves[0].to = 21; value.history[0].to = 21; },
  };
  for (const [name, corrupt] of Object.entries(cases)) {
    const invalid = clone(state); corrupt(invalid); const before = clone(invalid);
    assert.deepEqual(clone(h.api.restoreCurrentTurnUndo(invalid)), [], name);
    assert.deepEqual(clone(invalid), before, `${name}: input must stay unchanged`);
  }
});

test('a local reload snapshot cannot enable undo until the authoritative bot-room restore confirms it', async () => {
  const h = harness();
  const state = position(h, { rolled: [2, 4] });
  acceptedMoves(h, state, [{ from: 24, die: 2 }]);
  let release;
  const confirmed = new Promise(resolve => { release = resolve; });
  h.window.NarduRooms = { getGameState: () => confirmed, ensureBotAnalysisRoom: async () => ({ ok: true }),
    putGameState: async (code, payload) => { h.calls.published.push(clone(payload)); return { version: 13 }; } };
  const signature = `${h.context.location.pathname}${h.context.location.search}`;
  h.context.localStorage.setItem(`narduh-room-state:${signature}`, JSON.stringify({
    v: 1, at: NOW, signature, mode: 'bot', playerColor: 'white', roomCode: state.roomCode, state }));
  h.controller.init({ mode: 'bot', roomCode: state.roomCode, variant: 'long', difficulty: 'easy', skipAutoStart: true });
  assert.equal(h.api.getUndo().length, 0);
  assert.equal(h.undoButton.disabled, true);
  h.api.undoLastMove();
  assert.equal(h.controller.getState().turnMoves.length, 1);
  release({ state: clone(state), version: 12 });
  await h.api.startup();
  assert.equal(h.api.getUndo().length, 1);
  assert.equal(h.undoButton.disabled, false);
  h.api.undoLastMove();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.controller.getState().turnMoves.length, 0);
  assert.deepEqual(clone(h.controller.getState().dice), [2, 4]);
  assert.equal(h.controller.getState().history[0].fairDiceProof.request.id, 'issued-roll');
});

test('authoritative remote state replaces stale undo; an ended turn and spectator remain non-undoable', () => {
  const h = harness();
  const state = position(h, { color: 'dark', rolled: [2, 4] });
  const expected = acceptedMoves(h, state, [{ from: 12, die: 2 }]);
  h.controller.init({ mode: 'remote', roomCode: state.roomCode, playerColor: 'dark',
    variant: 'long', skipAutoStart: true, skipRemoteSync: true });
  h.api.setUndo([{ stale: true }]);
  h.api.applyRemoteState(state, 12);
  assert.equal(h.api.getUndo().length, 1);
  assert.equal(h.undoButton.disabled, false);
  const restored = clone(h.api.getUndo()[0]);
  for (const key of ['points', 'bar', 'off', 'score', 'dice', 'turnMoves', 'firstMoveDone', 'headPlayedThisTurn', 'history', 'fairDice']) {
    assert.deepEqual(restored[key], expected[0][key], key);
  }
  const ended = clone(state); h.game.endTurn(ended);
  h.api.applyRemoteState(ended, 13);
  assert.equal(h.api.getUndo().length, 0);
  assert.equal(h.undoButton.disabled, true);
  h.controller.init({ mode: 'remote', roomCode: state.roomCode, playerColor: 'dark', spectator: true,
    variant: 'long', skipAutoStart: true, skipRemoteSync: true });
  h.api.applyRemoteState(state, 14);
  assert.equal(h.undoButton.disabled, true);
  h.api.undoLastMove();
  assert.equal(h.controller.getState().turnMoves.length, 1);
});
