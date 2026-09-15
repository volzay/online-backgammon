const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ROOM_URL = 'https://example.test/room.html?mode=bot&game=SAFE-BOT&variant=long&difficulty=hard';
const ROOM_SEARCH = '?mode=bot&game=SAFE-BOT&variant=long&difficulty=hard';
const SNAPSHOT_KEY = `narduh-room-state:/room.html${ROOM_SEARCH}`;

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function controllerHarness({
  localStorage = memoryStorage(),
  getGameState,
  ensureBotAnalysisRoom,
  finishRoomGame,
  restoreTimeoutMs = 10,
} = {}) {
  const sessionStorage = memoryStorage();
  const calls = { ensure: 0, put: 0, finish: 0, archive: 0, rating: 0 };
  let gameOverModal = null;
  const document = {
    hidden: false,
    visibilityState: 'visible',
    body: {
      appendChild(node) {
        if (node?.id === 'game-over') gameOverModal = node;
      },
    },
    addEventListener() {},
    getElementById(id) { return id === 'game-over' ? gameOverModal : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() {
      return {
        id: '',
        className: '',
        innerHTML: '',
        classList: { add() {}, remove() {} },
        addEventListener() {},
      };
    },
  };
  const boundedSetTimeout = (callback, ms) => {
    // Keep the deliberately shortened restore deadline, but suppress gameplay,
    // sound and automatic-publish timers that are unrelated to these tests.
    if (Number(ms) >= 100) return 1;
    return setTimeout(callback, ms);
  };
  const window = {
    addEventListener() {},
    setTimeout: boundedSetTimeout,
    NarduApp: {
      getUser() { return { id: 'user-1', name: 'Tester', guest: false }; },
      paintUser() {},
      formatRating() { return '1000'; },
    },
    NarduRating: {
      record() {
        calls.rating += 1;
        return { delta: 1, rating: 1001 };
      },
    },
    NarduSound: { click() {}, win() {}, lose() {} },
    NarduRooms: {
      getGameState: getGameState || (async () => {
        const error = new Error('not found');
        error.status = 404;
        throw error;
      }),
      async ensureBotAnalysisRoom(payload) {
        calls.ensure += 1;
        if (ensureBotAnalysisRoom) return ensureBotAnalysisRoom(payload);
        return { ok: true, existing: false, version: 0 };
      },
      async putGameState() {
        calls.put += 1;
        return { ok: true, version: 8 };
      },
      async finishRoomGame() {
        calls.finish += 1;
        if (finishRoomGame) return finishRoomGame();
        return { ok: true, version: 9, trainingArchived: true };
      },
      async archiveBotTrainingGame() {
        calls.archive += 1;
        return { ok: true, decisionCount: 0 };
      },
    },
  };
  const quietConsole = Object.create(console);
  quietConsole.warn = () => {};
  const context = {
    window,
    document,
    console: quietConsole,
    Date,
    Math,
    JSON,
    URL,
    Uint8Array,
    TextEncoder,
    setTimeout: boundedSetTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    requestAnimationFrame(callback) { callback(); return 1; },
    localStorage,
    sessionStorage,
    location: {
      href: ROOM_URL,
      pathname: '/room.html',
      search: ROOM_SEARCH,
      hostname: 'example.test',
    },
    history: { replaceState() {} },
  };
  window.window = window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context, {
    filename: 'game.js',
  });
  context.NarduGame = window.NarduGame;
  context.NarduRating = window.NarduRating;
  context.NarduSound = window.NarduSound;

  const source = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8')
    .replace(/const BOT_ANALYSIS_RESTORE_TIMEOUT_MS = \d+;/, `const BOT_ANALYSIS_RESTORE_TIMEOUT_MS = ${restoreTimeoutMs};`)
    .replace('const BOT_ANALYSIS_ENSURE_TIMEOUT_MS = 5000;', 'const BOT_ANALYSIS_ENSURE_TIMEOUT_MS = 10;')
    .replace('const BOT_ANALYSIS_WRITE_TIMEOUT_MS = 5000;', 'const BOT_ANALYSIS_WRITE_TIMEOUT_MS = 10;')
    .replace('const BOT_GAME_EXIT_WAIT_MS = 12500;', 'const BOT_GAME_EXIT_WAIT_MS = 15;')
    .replace(
      '    preferredMoveAction,\n  };',
      '    preferredMoveAction,\n    __restoreSafetyTest: { publishBotAnalysisState, ensureBotFinalStatePublished, archiveBotTrainingGame, waitForFinishedBotPersistence, onGameOver },\n  };',
    );
  vm.runInContext(source, context, { filename: 'game-controller.js' });

  return {
    calls,
    context,
    controller: window.NarduController,
    localStorage,
    window,
  };
}

function init(controller) {
  controller.init({
    mode: 'bot',
    roomCode: 'SAFE-BOT',
    variant: 'long',
    difficulty: 'hard',
    opponent: 'Hard bot',
    opponentRating: 1500,
    skipAutoStart: true,
  });
}

function finishLocally(controller) {
  const state = controller.getState();
  state.phase = 'over';
  state.winner = 'white';
  state.finishedAt = Date.now();
  state.off.white = 15;
  controller.__restoreSafetyTest.onGameOver();
}

test('a timed-out late restore cannot overwrite or rate its server room', async () => {
  let releaseRestore;
  const delayedRestore = new Promise(resolve => { releaseRestore = resolve; });
  const harness = controllerHarness({ getGameState: () => delayedRestore });
  init(harness.controller);

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await harness.controller.__restoreSafetyTest.publishBotAnalysisState(), false);

  const serverState = harness.window.NarduGame.initialState('long');
  serverState.mode = 'bot';
  serverState.botDifficulty = 'hard';
  serverState.roomCode = 'SAFE-BOT';
  releaseRestore({ state: serverState, version: 12 });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(await harness.controller.__restoreSafetyTest.publishBotAnalysisState(), false);
  finishLocally(harness.controller);
  assert.equal(await harness.controller.__restoreSafetyTest.ensureBotFinalStatePublished(), false);
  assert.equal(await harness.controller.__restoreSafetyTest.archiveBotTrainingGame({}), false);
  assert.deepEqual(harness.calls, { ensure: 0, put: 0, finish: 0, archive: 0, rating: 0 });
});

test('a local bot board stays read-only until its server restore is verified', async () => {
  const localStorage = memoryStorage();
  let releaseRestore;
  const delayedRestore = new Promise(resolve => { releaseRestore = resolve; });
  const harness = controllerHarness({
    localStorage,
    getGameState: () => delayedRestore,
  });
  const serverState = harness.window.NarduGame.initialState('long');
  Object.assign(serverState, {
    mode: 'bot',
    botDifficulty: 'hard',
    roomCode: 'SAFE-BOT',
    phase: 'move',
    turn: 'white',
    dice: [1, 2],
    rolled: [1, 2],
  });
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
    v: 1,
    at: Date.now(),
    signature: `/room.html${ROOM_SEARCH}`,
    mode: 'bot',
    playerColor: 'white',
    roomCode: 'SAFE-BOT',
    state: serverState,
  }));

  init(harness.controller);
  harness.controller.onPointClick(24);
  assert.equal(harness.controller.getState().selected, null, 'the local board must not accept a move during restore');
  assert.equal(await harness.controller.__restoreSafetyTest.publishBotAnalysisState(), false);
  assert.deepEqual(harness.calls, { ensure: 0, put: 0, finish: 0, archive: 0, rating: 0 });

  releaseRestore({ state: serverState, version: 12 });
  await new Promise(resolve => setImmediate(resolve));
  harness.controller.onPointClick(24);
  assert.equal(harness.controller.getState().selected, 24, 'the verified server board becomes interactive');
  assert.equal(await harness.controller.__restoreSafetyTest.publishBotAnalysisState(), true);
  assert.deepEqual(harness.calls, { ensure: 0, put: 1, finish: 0, archive: 0, rating: 0 });
});

test('a delayed CDN fallback can still complete the authoritative restore', async () => {
  let releaseRestore;
  const delayedRestore = new Promise(resolve => { releaseRestore = resolve; });
  const harness = controllerHarness({
    getGameState: () => delayedRestore,
    restoreTimeoutMs: 40,
  });
  const serverState = harness.window.NarduGame.initialState('long');
  Object.assign(serverState, {
    mode: 'bot',
    botDifficulty: 'hard',
    roomCode: 'SAFE-BOT',
    phase: 'move',
    turn: 'white',
    dice: [1, 2],
    rolled: [1, 2],
  });

  init(harness.controller);
  await new Promise(resolve => setTimeout(resolve, 15));
  harness.controller.onPointClick(24);
  assert.equal(harness.controller.getState().selected, null, 'the board stays locked during a slow fallback');

  releaseRestore({ state: serverState, version: 12 });
  await new Promise(resolve => setImmediate(resolve));
  harness.controller.onPointClick(24);
  assert.equal(harness.controller.getState().selected, 24);
  assert.equal(await harness.controller.__restoreSafetyTest.publishBotAnalysisState(), true);
  assert.equal(harness.calls.put, 1);
});

test('production restore budget covers both Supabase CDN attempts', () => {
  const controllerSource = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8');
  const supabaseSource = fs.readFileSync(path.join(ROOT, 'supabase-client.js'), 'utf8');
  const restoreMs = Number(controllerSource.match(/BOT_ANALYSIS_RESTORE_TIMEOUT_MS = (\d+)/)?.[1]);
  const cdnAttemptMs = Number(supabaseSource.match(/SUPABASE_SDK_LOAD_TIMEOUT_MS = (\d+)/)?.[1]);

  assert.ok(restoreMs > cdnAttemptMs * 2, 'restore must outlive both sequential CDN attempts');
});

test('finished-game exit budget covers the first authoritative persistence path', () => {
  const source = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8');
  const value = name => Number(source.match(new RegExp(`${name} = (\\d+)`))?.[1]);
  const exitMs = value('BOT_GAME_EXIT_WAIT_MS');
  const firstPersistencePathMs = value('BOT_ANALYSIS_DRAIN_TIMEOUT_MS')
    + value('BOT_ANALYSIS_ENSURE_TIMEOUT_MS')
    + value('BOT_ANALYSIS_WRITE_TIMEOUT_MS');

  assert.ok(exitMs > firstPersistencePathMs, 'navigation must not cut off a valid first final write');
});

test('a failed ensure after a definitive restore 404 disables every server write', async () => {
  const harness = controllerHarness({
    ensureBotAnalysisRoom: async () => { throw new Error('response lost'); },
  });
  init(harness.controller);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(
    await harness.controller.__restoreSafetyTest.publishBotAnalysisState(),
    false,
    'the definitive 404 now reserves the server room before unlocking gameplay',
  );
  assert.equal(await harness.controller.__restoreSafetyTest.publishBotAnalysisState(), false);
  const state = harness.controller.getState();
  Object.assign(state, {
    phase: 'move',
    turn: 'white',
    dice: [1, 2],
    rolled: [1, 2],
  });
  harness.controller.onPointClick(24);
  assert.equal(state.selected, null, 'a failed reservation must keep the board locked');
  finishLocally(harness.controller);
  assert.equal(await harness.controller.__restoreSafetyTest.ensureBotFinalStatePublished(), false);
  assert.equal(await harness.controller.__restoreSafetyTest.archiveBotTrainingGame({}), false);
  assert.deepEqual(harness.calls, { ensure: 1, put: 0, finish: 0, archive: 0, rating: 0 });
});

test('a non-409 ensure failure stays locked and a successful retry unlocks safely', async () => {
  let ensureAttempts = 0;
  const harness = controllerHarness({
    ensureBotAnalysisRoom: async () => {
      ensureAttempts += 1;
      if (ensureAttempts === 1) {
        const error = new Error('temporary upstream failure');
        error.status = 503;
        throw error;
      }
      return { ok: true, existing: false, version: 4 };
    },
  });
  init(harness.controller);
  await new Promise(resolve => setImmediate(resolve));

  const state = harness.controller.getState();
  Object.assign(state, {
    phase: 'move',
    turn: 'white',
    dice: [1, 2],
    rolled: [1, 2],
  });
  harness.controller.onPointClick(24);
  assert.equal(state.selected, null, 'the first failed ensure must not release gameplay');
  assert.equal(await harness.controller.__restoreSafetyTest.publishBotAnalysisState(), false);
  assert.equal(harness.calls.ensure, 1);
  assert.equal(harness.calls.put, 0, 'the failed attempt must not publish local state');

  assert.equal(await harness.controller.retryBotAnalysisStartup(), true);
  assert.equal(harness.calls.ensure, 2);
  assert.equal(harness.calls.put, 0, 'reservation success precedes the first state publish');

  harness.controller.onPointClick(24);
  assert.equal(state.selected, 24, 'the board unlocks only after the retry reserves the room');
  assert.equal(await harness.controller.__restoreSafetyTest.publishBotAnalysisState(), true);
  assert.deepEqual(harness.calls, { ensure: 2, put: 1, finish: 0, archive: 0, rating: 0 });
});

test('a cross-tab active-room conflict redirects before the bot board unlocks', async () => {
  const harness = controllerHarness({
    ensureBotAnalysisRoom: async () => {
      const error = new Error('active room conflict');
      error.status = 409;
      error.data = {
        room: {
          code: 'WAIT-ROOM',
          status: 'waiting',
          opponent: 'player',
        },
      };
      throw error;
    },
  });
  init(harness.controller);
  await new Promise(resolve => setImmediate(resolve));

  const state = harness.controller.getState();
  state.phase = 'move';
  state.turn = 'white';
  state.dice = [1];
  state.rolled = [1];
  harness.controller.onPointClick(24);

  assert.equal(state.selected, null, 'a rejected second room must never become interactive');
  assert.match(harness.context.location.href, /index\.html\?roomConflict=1$/);
  assert.deepEqual(harness.calls, { ensure: 1, put: 0, finish: 0, archive: 0, rating: 0 });
});

test('rating waits for a pending room confirmation and a timeout fails closed', async () => {
  const pendingEnsure = new Promise(() => {});
  const harness = controllerHarness({
    ensureBotAnalysisRoom: () => pendingEnsure,
  });
  init(harness.controller);
  await new Promise(resolve => setImmediate(resolve));

  finishLocally(harness.controller);
  assert.equal(harness.calls.rating, 0, 'rating must not race an unresolved ownership check');
  assert.equal(await harness.controller.__restoreSafetyTest.waitForFinishedBotPersistence(), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.calls, { ensure: 1, put: 0, finish: 0, archive: 0, rating: 0 });
});

test('a hung final write cannot trap finished-game navigation or record rating', async () => {
  const neverFinishes = new Promise(() => {});
  let serverState;
  const harness = controllerHarness({
    getGameState: async () => ({ state: serverState, version: 7 }),
    finishRoomGame: () => neverFinishes,
  });
  serverState = harness.window.NarduGame.initialState('long');
  serverState.mode = 'bot';
  serverState.botDifficulty = 'hard';
  serverState.roomCode = 'SAFE-BOT';
  init(harness.controller);
  await new Promise(resolve => setImmediate(resolve));

  finishLocally(harness.controller);
  assert.equal(await harness.controller.__restoreSafetyTest.waitForFinishedBotPersistence(), false);
  assert.equal(harness.calls.finish, 1);
  assert.equal(harness.calls.rating, 0);
});

test('a local reload snapshot remains writable after the server room is restored', async () => {
  const localStorage = memoryStorage();
  let serverState;
  const harness = controllerHarness({
    localStorage,
    getGameState: async () => ({ state: serverState, version: 7 }),
  });
  serverState = harness.window.NarduGame.initialState('long');
  serverState.mode = 'bot';
  serverState.botDifficulty = 'hard';
  serverState.roomCode = 'SAFE-BOT';
  const localState = JSON.parse(JSON.stringify(serverState));
  localState.history.push({ message: 'local reload marker' });
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
    v: 1,
    at: Date.now(),
    signature: `/room.html${ROOM_SEARCH}`,
    mode: 'bot',
    playerColor: 'white',
    roomCode: 'SAFE-BOT',
    state: localState,
  }));

  init(harness.controller);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.controller.getState().history.length, 0, 'the verified server snapshot is authoritative');
  assert.equal(await harness.controller.__restoreSafetyTest.publishBotAnalysisState(), true);
  assert.deepEqual(harness.calls, { ensure: 0, put: 1, finish: 0, archive: 0, rating: 0 });

  finishLocally(harness.controller);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.calls.finish, 1);
  assert.equal(harness.calls.rating, 1);
});
