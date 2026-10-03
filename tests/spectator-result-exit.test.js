const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const controller = fs.readFileSync(path.join(root, 'game-controller.js'), 'utf8');
const room = fs.readFileSync(path.join(root, 'room.html'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'settings.html'), 'utf8');

function sourceBetween(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `${start} must precede ${end}`);
  return source.slice(first, last);
}

test('Q3PL-JF26 spectator result skips player rating and modal and leaves for lobby', () => {
  const actions = [];
  const context = {
    state: { phase: 'over', winner: 'white' },
    spectatorMode: true,
    document: { getElementById: () => ({ remove: () => actions.push('remove-modal') }) },
    leaveRoomToLobby: closeRoom => actions.push(`lobby:${closeRoom}`),
    recordMatchGame: () => actions.push('match-point'),
    NarduRating: { record: () => actions.push('rating') },
    renderGameOverModal: () => actions.push('modal'),
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween(controller, '  function onGameOver() {', '  function gameResultKey() {'), context);
  vm.runInContext('onGameOver()', context);

  assert.deepEqual(actions, ['remove-modal', 'lobby:true']);
});

test('spectator receives a finished remote position without playing terminal animations', () => {
  const calls = [];
  const context = {
    state: { phase: 'move', startedAt: 10, finishedAt: null, turnClock: {}, matchScore: {} },
    spectatorMode: true,
    mode: 'remote',
    playerColor: 'white',
    viewColor: 'white',
    remoteCode: 'Q3PL-JF26',
    remoteVersion: 0,
    autoRollTimer: null,
    autoEndTimer: null,
    normalizedTurnClock: clock => clock,
    normalizedMatchScore: score => score,
    restoreCurrentTurnUndo: () => [],
    shouldAnimateIncomingRemoteOpeningRoll: () => true,
    shouldAnimateIncomingRemoteRoll: () => true,
    collectIncomingRemoteMoveSounds: () => [{ from: 1, to: 2 }],
    canAnimateIncomingRemoteMove: () => true,
    onGameOver: () => calls.push('spectator-exit'),
    render: () => calls.push('render'),
    playIncomingMoveSounds: () => calls.push('sound'),
    startNextGame: () => calls.push('rematch'),
    isRemoteHost: () => true,
    JSON,
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween(controller, '  function applyRemoteState(nextState, version) {', '  function receiveRemoteState(nextState, version) {'), context);
  vm.runInContext("applyRemoteState({ phase: 'over', winner: 'white', finishedAt: 20, rematch: { status: 'accepted' } }, 1)", context);

  assert.deepEqual(calls, ['spectator-exit']);
  assert.equal(context.state.winner, 'white');
  assert.equal(context.isApplyingRemote, false);
});

function spectatorExitHarness({ immediate = false, leavePromise = new Promise(() => {}) } = {}) {
  const calls = [];
  const context = {
    isSpectatorRoom: true,
    isWaitingHost: false,
    spectatorExitStarted: false,
    spectatorId: 'tester1-tab',
    roomCode: 'Q3PL-JF26',
    presenceTimer: 1,
    spectatorTimer: 2,
    SPECTATOR_LEAVE_TIMEOUT_MS: 5,
    location: { href: 'room.html?role=spectator&room=Q3PL-JF26' },
    clearInterval: id => calls.push(`clear:${id}`),
    setTimeout,
    clearTimeout,
    stopWaitingRoomWatchForExit: () => {},
    cancelPresenceHeartbeatRequest: () => calls.push('cancel-presence'),
    cancelSpectatorHeartbeatRequest: () => calls.push('cancel-watch'),
    NarduRooms: {
      leaveSpectator: (code, payload) => {
        calls.push(`leave:${code}:${payload.spectatorId}`);
        return leavePromise;
      },
    },
    NarduApp: { getUser: () => ({ name: 'tester1' }) },
    earlyRoomText: key => key,
    Promise,
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween(room, 'async function leaveToLobby({ immediate = false } = {}) {', 'window.NarduRoom = { leaveToLobby'), context);
  return { context, calls, leave: () => context.leaveToLobby({ immediate }) };
}

test('a spectator may leave at any time even if presence cleanup never answers', async () => {
  const harness = spectatorExitHarness();
  await harness.leave();
  assert.equal(harness.context.location.href, 'index.html');
  assert.ok(harness.calls.includes('cancel-watch'));
  assert.ok(harness.calls.includes('leave:Q3PL-JF26:tester1-tab'));
  assert.equal(harness.context.spectatorExitStarted, true);
});

test('automatic spectator exit does not wait for network and is idempotent', async () => {
  const harness = spectatorExitHarness({ immediate: true });
  await harness.leave();
  await harness.leave();
  assert.equal(harness.context.location.href, 'index.html');
  assert.equal(harness.calls.filter(item => item.startsWith('leave:')).length, 1);
});

test('closed spectator admission routes to lobby instead of showing a network trap', () => {
  const heartbeat = sourceBetween(room, 'async function sendSpectatorHeartbeat() {', 'function cancelSpectatorHeartbeatRequest() {');
  assert.match(heartbeat, /includeState: false/);
  assert.match(heartbeat, /\[403, 404, 410\][\s\S]*leaveToLobby\(\{ immediate: true \}\)/);
  assert.match(room, /if \(chatRemote && !chatSpectator\) \{\s*pollChat\(\)/);
});

test('remote player rating waits for terminal room publication', async () => {
  let release;
  const published = new Promise(resolve => { release = resolve; });
  const calls = [];
  const context = {
    state: { phase: 'over', winner: 'white', finishedAt: 10, resultType: 'normal', score: { white: 0, dark: 15 }, off: {}, history: [] },
    spectatorMode: false,
    mode: 'remote',
    playerColor: 'white',
    opponentName: 'warlord',
    opponentRating: 1500,
    remoteCode: 'Q3PL-JF26',
    botAnalysisPublishQueue: Promise.resolve(),
    gameOverSoundKey: '10:white:normal',
    gameplaySoundBusyUntil: 0,
    GAME_OVER_SOUND_GAP_MS: 260,
    localRatingRecordedKey: null,
    ratingPendingKey: null,
    lastRatingResult: null,
    ratingRetryKey: null,
    ratingRetryCount: 0,
    gameResultKey: () => '10:white:normal',
    recordMatchGame: () => {},
    finalizeBotMemory: () => {},
    renderPlayerStats: () => {},
    ensureRemoteFinalStatePublished: () => published,
    remoteStatePayload: () => ({}),
    renderGameOverModal: () => calls.push('modal'),
    NarduRating: { record: () => { calls.push('rating'); return { delta: 1, rating: 1501 }; } },
    NarduApp: { getUser: () => ({ name: 'Наблюдатель', guest: false }) },
    Promise,
    console: { warn: () => {} },
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween(controller, '  function onGameOver() {', '  function gameResultKey() {'), context);
  vm.runInContext('onGameOver()', context);
  assert.deepEqual(calls, ['modal']);
  release(true);
  await published;
  await Promise.resolve();
  assert.ok(calls.includes('rating'));
});

test('a pending player result cannot credit a tab that reinitialized as spectator', async () => {
  let release;
  const published = new Promise(resolve => { release = resolve; });
  const calls = [];
  const context = {
    state: { phase: 'over', winner: 'white', finishedAt: 10, score: { white: 0, dark: 15 }, off: {}, history: [] },
    spectatorMode: false,
    mode: 'remote',
    playerColor: 'white',
    remoteCode: 'Q3PL-JF26',
    botAnalysisPublishQueue: Promise.resolve(),
    gameOverSoundKey: 'finished',
    ratingPendingKey: null,
    gameResultKey: () => 'finished',
    recordMatchGame: () => {},
    finalizeBotMemory: () => {},
    renderPlayerStats: () => {},
    ensureRemoteFinalStatePublished: () => published,
    renderGameOverModal: () => {},
    NarduRating: { record: () => { calls.push('rating'); return { delta: 1, rating: 1501 }; } },
    Promise,
    console: { warn: () => {} },
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween(controller, '  function onGameOver() {', '  function gameResultKey() {'), context);
  vm.runInContext('onGameOver()', context);
  context.spectatorMode = true;
  release(true);
  await published;
  await Promise.resolve();
  assert.deepEqual(calls, []);
});

test('a participant accepts the identical terminal room after another tab wins the write race', async () => {
  const conflict = new Error('version conflict');
  conflict.status = 409;
  const context = {
    mode: 'remote',
    remoteCode: 'Q3PL-JF26',
    remoteVersion: 1,
    state: { phase: 'over', winner: 'white', finishedAt: 20 },
    gameOverPublishPromise: null,
    remoteStatePayload: () => ({ phase: 'over', winner: 'white', finishedAt: 20 }),
    window: { NarduRooms: {
      finishRoomGame: async () => { throw conflict; },
      getGameState: async () => ({ version: 2, state: { phase: 'over', winner: 'white', finishedAt: 20 } }),
    } },
    wait: async () => {},
    console: { warn: () => {} },
    Promise,
    Date,
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween(controller, '  function ensureRemoteFinalStatePublished() {', '  async function publishRemoteState(options = {}) {'), context);
  const accepted = await vm.runInContext('ensureRemoteFinalStatePublished()', context);

  assert.equal(accepted, true);
  assert.equal(context.remoteVersion, 2);
  assert.ok(context.state.gameOverPublishedAt);
});

test('authoritative history removes only confirmed spectator-local results', async () => {
  const user = {
    id: 'tester1-id',
    rating: 1400,
    history: [
      { resultKey: 'false-win', mode: 'remote', score: { roomCode: 'Q3PL-JF26' }, didWin: true },
      { resultKey: 'pending-player', mode: 'remote', score: { roomCode: 'ABCD-EFGH' }, didWin: false },
      { resultKey: 'old-unresolved', mode: 'remote', score: { roomCode: 'WXYZ-2345' }, didWin: true },
      { resultKey: 'offline-bot', mode: 'bot', score: { roomCode: 'ZQBE-SM3L' }, didWin: true },
    ],
  };
  const context = {
    currentUser: () => user,
    client: { from: () => ({
      select: () => ({
        in: () => ({
          neq: async () => ({ data: [
            { code: 'Q3PL-JF26', host_user_id: 'observer-id', guest_user_id: 'warlord-id' },
            { code: 'ABCD-EFGH', host_user_id: 'tester1-id', guest_user_id: 'other-id' },
          ], error: null }),
        }),
      }),
    }) },
    Date,
    Map,
    Set,
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween(settings, 'function localGames() {', 'function fallbackProfile() {'), context);
  const rejected = await vm.runInContext('knownNonParticipantLocalResults(client, "tester1-id", [])', context);
  vm.runInContext('invalidLocalRemoteResults = { userId: "tester1-id", keys: globalThis.rejected }',
    Object.assign(context, { rejected }));
  const games = vm.runInContext('mergeGames([])', context);

  assert.deepEqual(Array.from(games, game => game.resultKey).sort(),
    ['pending-player', 'old-unresolved', 'offline-bot'].sort());
});
