const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const controller = fs.readFileSync(path.join(__dirname, '..', 'game-controller.js'), 'utf8');
const roomCode = 'TEST-RATE';
const terminal = {
  roomCode,
  phase: 'over',
  winner: 'dark',
  startedAt: 100,
  finishedAt: 150,
  resultType: 'koks',
};

function sourceBetween(start, end) {
  const first = controller.indexOf(start);
  const last = controller.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `${start} must precede ${end}`);
  return controller.slice(first, last);
}

function controllerHarness(options = {}) {
  const state = options.state ?? terminal;
  const context = vm.createContext({
    state: { ...state },
    mode: 'remote',
    remoteCode: roomCode,
    remoteVersion: 1,
    playerColor: 'dark',
    viewColor: 'dark',
    spectatorMode: false,
    pending: null,
    isApplyingRemote: false,
    remotePublishQueue: Promise.resolve(),
    gameOverPublishPromise: null,
    autoRollTimer: null,
    autoEndTimer: null,
    render: () => {},
    onGameOver: () => {},
    ensureAutoProgress: () => {},
    isRemoteHost: () => false,
    shouldAnimateIncomingRemoteOpeningRoll: () => false,
    shouldAnimateIncomingRemoteRoll: () => false,
    collectIncomingRemoteMoveSounds: () => [],
    canAnimateIncomingRemoteMove: () => false,
    playIncomingMoveSounds: () => {},
    restoreCurrentTurnUndo: () => [],
    normalizedTurnClock: value => value,
    normalizedMatchScore: value => value,
    wait: async () => {},
    console: { warn: () => {} },
    window: { NarduRooms: options.rooms },
  });
  vm.runInContext('function remoteStatePayload() { return { ...state }; }', context);
  vm.runInContext(sourceBetween('  function gameResultKey() {', '  function resultTypeLabel('), context);
  vm.runInContext(sourceBetween(
    '  function waitForFinishedBotPersistence() {',
    '  async function publishRemoteState(options = {}) {',
  ), context);
  vm.runInContext(sourceBetween(
    '  function applyRemoteState(nextState, version) {',
    '  function collectIncomingRemoteMoveSounds(',
  ), context);
  vm.runInContext(sourceBetween(
    '  function persistIntermediateMove() {',
    '  async function publishRemoteStateNow(',
  ), context);
  return context;
}

test('only an unfinished remote move goes through the intermediate-state publisher', () => {
  const context = controllerHarness();
  const phases = [];
  context.publishRemoteState = () => phases.push(context.state.phase);
  for (const state of [
    { phase: 'move', winner: null },
    { phase: 'over', winner: 'dark' },
    { phase: 'move', winner: 'dark' },
    { phase: 'over', winner: null },
  ]) {
    context.state = state;
    vm.runInContext('persistIntermediateMove()', context);
  }
  assert.deepEqual(phases, ['move']);
});

test('terminal update rejection adopts the saved timestamp of the same game and confirms it once', async () => {
  const rejection = Object.assign(new Error('Finish timestamp is immutable'), { status: 422 });
  let writes = 0;
  let reads = 0;
  const context = controllerHarness({
    rooms: {
      finishRoomGame: async () => { writes += 1; throw rejection; },
      getGameState: async () => {
        reads += 1;
        return { version: 2, state: { ...terminal, finishedAt: 147 } };
      },
    },
  });

  assert.equal(await vm.runInContext('ensureRemoteFinalStatePublished()', context), true);
  assert.equal(context.state.finishedAt, 147);
  assert.equal(context.remoteVersion, 2);
  assert.equal(await vm.runInContext('ensureRemoteFinalStatePublished()', context), true);
  assert.equal(writes, 1);
  assert.equal(reads, 1);
});

test('terminal update rejection cannot adopt a terminal snapshot from another game epoch', async () => {
  const rejection = Object.assign(new Error('Game has changed'), { status: 409 });
  const context = controllerHarness({
    rooms: {
      finishRoomGame: async () => { throw rejection; },
      getGameState: async () => ({
        version: 2,
        state: { ...terminal, startedAt: 101, finishedAt: 147 },
      }),
    },
  });

  assert.equal(await vm.runInContext('ensureRemoteFinalStatePublished()', context), false);
  assert.equal(context.state.finishedAt, 150);
});

test('a timestamped terminal state received from the server does not require another final write', async () => {
  let writes = 0;
  const context = controllerHarness({
    state: { ...terminal, phase: 'move', winner: null, finishedAt: null, resultType: null },
    rooms: { finishRoomGame: async () => { writes += 1; } },
  });
  context.savedState = { ...terminal };
  assert.equal(vm.runInContext('receiveRemoteState(savedState, 2)', context), true);
  assert.equal(await vm.runInContext('ensureRemoteFinalStatePublished()', context), true);
  assert.equal(context.state.finishedAt, 150);
  assert.equal(writes, 0);
});

test('a remote rematch never inherits a finish timestamp from the previous game', () => {
  const context = controllerHarness();
  context.savedState = {
    ...terminal, phase: 'opening', startedAt: 200, winner: null, finishedAt: null, resultType: null,
  };

  assert.equal(vm.runInContext('receiveRemoteState(savedState, 2)', context), true);
  assert.equal(context.state.startedAt, 200);
  assert.equal(context.state.finishedAt, null);
  assert.equal(context.state.gameOverPublishedAt, undefined);
});

test('the result window recovers its server-confirmed rating after a transient sync failure', async () => {
  const scheduled = [];
  const results = [];
  const ratingRequests = [];
  let soundSchedules = 0;
  const context = controllerHarness({
    state: { ...terminal, score: { white: 208, dark: 360 } },
    rooms: {
      finishRoomGame: async () => {
        throw Object.assign(new Error('Finish timestamp is immutable'), { status: 422 });
      },
      getGameState: async () => ({ version: 2, state: { ...terminal, finishedAt: 147 } }),
    },
  });
  Object.assign(context, {
    opponentName: 'Opponent',
    opponentRating: 1662,
    gameOverSoundKey: null,
    localRatingRecordedKey: null,
    lastRatingResult: null,
    ratingPendingKey: null,
    ratingRetryKey: null,
    ratingRetryCount: 0,
    ratingRetryScheduled: false,
    botAnalysisPublishQueue: Promise.resolve(),
    NarduApp: { getUser: () => ({ id: 'registered' }), isRatedUser: () => true },
    NarduRating: { record: (_opponent, _rating, won, _mode, resultKey, details) => {
      ratingRequests.push({ won, resultKey, finishedAt: details.score.finalState.finishedAt });
      return {
        authoritativePending: true,
        syncPromise: Promise.resolve(ratingRequests.length === 1 ? null : { delta: 23, rating: 1111 }),
      };
    } },
    recordMatchGame: () => {},
    finalizeBotMemory: () => {},
    renderPlayerStats: () => {},
    renderGameOverModal: () => results.push(context.lastRatingResult?.delta),
    schedule: (callback, milliseconds) => {
      if (milliseconds === 350) soundSchedules += 1;
      else scheduled.push(callback);
    },
    GAME_OVER_SOUND_GAP_MS: 350,
    gameplaySoundBusyUntil: 0,
  });
  vm.runInContext(sourceBetween('  function onGameOver() {', '  function gameResultKey() {'), context);

  vm.runInContext('onGameOver()', context);
  await new Promise(resolve => setImmediate(resolve));
  const canonicalRequest = { won: true, resultKey: '147:dark:koks', finishedAt: 147 };
  assert.deepEqual(ratingRequests, [canonicalRequest]);
  assert.equal(scheduled.length, 1);
  assert.equal(context.lastRatingResult, null, 'a local guess must never be shown');

  scheduled.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ratingRequests, [canonicalRequest, canonicalRequest]);
  assert.equal(context.lastRatingResult.delta, 23);
  assert.equal(context.lastRatingResult.rating, 1111);
  assert.equal(results.at(-1), 23);
  assert.equal(scheduled.length, 0);
  assert.equal(soundSchedules, 1);
});
