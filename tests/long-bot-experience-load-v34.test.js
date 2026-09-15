const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function memoryStorage() {
  const values = new Map();
  return {
    values,
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function loadRoomsClient({ localStorage, window }) {
  const context = {
    window,
    localStorage,
    console,
    Date,
    Math,
    JSON,
    Map,
    Uint8Array,
    TextEncoder,
    fetch,
  };
  window.window = window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'rooms-client.js'), 'utf8'), context, {
    filename: 'rooms-client.js',
  });
  return context.window.NarduRooms;
}

function loadController(loadLongBotExperience) {
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const document = {
    hidden: false,
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  let engineExperienceSize = 17;
  let enginePendingPatternCount = 0;
  let engineFrozen = false;
  const frozenSnapshots = [];
  const window = {
    addEventListener() {},
    setTimeout,
    NarduApp: {
      getUser() { return { name: 'Tester' }; },
      paintUser() {},
    },
    NarduRooms: { loadLongBotExperience },
    NarduLongBotEngine: {
      beginExperienceSession() {},
      experienceSize() { return engineExperienceSize; },
      experienceSnapshot() {
        return {
          frozen: engineFrozen,
          pendingPatternCount: enginePendingPatternCount,
        };
      },
      freezeExperience() {
        engineFrozen = true;
        const snapshot = {
          frozen: true,
          fingerprint: `test-${engineExperienceSize}`,
          size: engineExperienceSize,
        };
        frozenSnapshots.push(snapshot);
        return snapshot;
      },
      __setExperienceSize(size) { engineExperienceSize = Number(size) || 0; },
      __setPendingPatternCount(size) { enginePendingPatternCount = Number(size) || 0; },
      __setFrozen(value) { engineFrozen = value === true; },
      __frozenSnapshots: frozenSnapshots,
    },
    NarduStrongBot: { syncLocalExperience() {} },
  };
  const context = {
    window,
    document,
    console,
    Date,
    Math,
    JSON,
    URL,
    Uint8Array,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    localStorage,
    sessionStorage,
    location: {
      href: 'https://example.test/room.html?mode=bot&game=LOAD-V33&variant=long&difficulty=hard',
      pathname: '/room.html',
      search: '?mode=bot&game=LOAD-V33&variant=long&difficulty=hard',
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
  const source = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8')
    .replace(
      '    preferredMoveAction,\n  };',
      '    preferredMoveAction,\n    __test: { loadLongBotExperienceBeforeStart, ensureAutoProgressAfterExperience },\n  };',
    );
  vm.runInContext(source, context, { filename: 'game-controller.js' });
  window.NarduController.init({
    mode: 'bot',
    roomCode: 'LOAD-V33',
    variant: 'long',
    difficulty: 'hard',
    opponent: 'Hard bot',
    opponentRating: 1500,
    skipAutoStart: true,
  });
  return context;
}

test('lobby prefetch caches v34-compatible experience even before the long engine is loaded', async () => {
  const localStorage = memoryStorage();
  localStorage.setItem('narduh-long-bot-server-experience-v14', JSON.stringify({
    savedAt: Date.now(),
    playerKey: 'tester1',
    creditVersion: 7,
    patterns: [{ creditVersion: 7, contextKey: 'route|stale', actionKey: 'route:stale' }],
  }));
  const pattern = {
    creditVersion: 8,
    contextKey: 'route|prefetched',
    actionKey: 'route:safer',
  };
  const lobbyRooms = loadRoomsClient({
    localStorage,
    window: {
      NarduSupabase: {
        configured() { return true; },
        async client() {
          return { async rpc() { return { data: [pattern], error: null }; } };
        },
      },
    },
  });

  const prefetched = await lobbyRooms.loadLongBotExperience({ playerName: 'tester1' });
  assert.equal(prefetched[0].actionKey, pattern.actionKey);
  const cached = JSON.parse(localStorage.getItem('narduh-long-bot-server-experience-v15'));
  assert.equal(cached.creditVersion, 8);
  assert.equal(cached.patterns[0].contextKey, pattern.contextKey);
  assert.equal(localStorage.getItem('narduh-long-bot-server-experience-v14'), null);

  const applied = [];
  const roomRooms = loadRoomsClient({
    localStorage,
    window: {
      NarduSupabase: {
        configured() { return true; },
        async client() {
          return { rpc() { return new Promise(() => {}); } };
        },
      },
      NarduLongBotEngine: {
        setExperience(patterns, source) { applied.push({ patterns, source }); },
      },
    },
  });
  const loaded = await roomRooms.loadLongBotExperience({ playerName: 'tester1' });

  assert.equal(loaded[0].actionKey, pattern.actionKey);
  assert.ok(applied.some(item => (
    item.source === 'server-cache' && item.patterns[0]?.actionKey === pattern.actionKey
  )));
});

test('lobby cache quota recovery keeps the active room and seven newest recent snapshots', async () => {
  const localStorage = memoryStorage();
  const now = Date.now();
  localStorage.setItem('narduh-active-room', JSON.stringify({ code: 'ACTV-ROOM' }));
  localStorage.setItem('another-app-key', 'must survive');
  localStorage.setItem('narduh-room-state:/active-room', JSON.stringify({
    at: now - 97 * 60 * 60 * 1000,
    roomCode: 'ACTV-ROOM',
    state: { phase: 'move', roomCode: 'ACTV-ROOM' },
  }));
  for (let index = 0; index < 9; index += 1) {
    localStorage.setItem(`narduh-room-state:/room-${index}`, JSON.stringify({
      at: now - index * 1000,
      roomCode: `OLD-${String(index).padStart(4, '0')}`,
      state: { phase: 'over', winner: 'white', history: ['x'.repeat(200)] },
    }));
  }
  const setItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    const roomSnapshots = [...localStorage.values.keys()]
      .filter(item => item.startsWith('narduh-room-state:'));
    if (key === 'narduh-long-bot-server-experience-v15' && roomSnapshots.length > 8) {
      const error = new Error('quota exceeded');
      error.name = 'QuotaExceededError';
      throw error;
    }
    setItem(key, value);
  };
  const pattern = {
    creditVersion: 8,
    contextKey: 'route|quota-recovery',
    actionKey: 'route:remembered',
  };
  const rooms = loadRoomsClient({
    localStorage,
    window: {
      NarduSupabase: {
        configured() { return true; },
        async client() {
          return { async rpc() { return { data: [pattern], error: null }; } };
        },
      },
    },
  });

  await rooms.loadLongBotExperience({ playerName: 'quota-player' });

  const cached = JSON.parse(localStorage.getItem('narduh-long-bot-server-experience-v15'));
  assert.equal(cached.patterns[0].actionKey, pattern.actionKey);
  assert.equal(
    [...localStorage.values.keys()].filter(key => key.startsWith('narduh-room-state:')).length,
    8,
  );
  assert.equal(localStorage.getItem('narduh-room-state:/active-room') !== null, true);
  assert.equal(localStorage.getItem('narduh-room-state:/room-0') !== null, true);
  assert.equal(localStorage.getItem('narduh-room-state:/room-6') !== null, true);
  assert.equal(localStorage.getItem('narduh-room-state:/room-7'), null);
  assert.equal(localStorage.getItem('narduh-room-state:/room-8'), null);
  assert.equal(localStorage.getItem('another-app-key'), 'must survive');
  assert.equal(localStorage.getItem('narduh-active-room') !== null, true);
});

test('EGXA regression waits for a 6.951 s-equivalent load before freezing memory', async () => {
  let context;
  context = loadController(async () => {
    // Keep the test fast while preserving the production ordering which caused
    // EGXA: the old 4.5 s cutoff fired before a successful 6.951 s response.
    await new Promise(resolve => setTimeout(resolve, 35));
    context.window.NarduLongBotEngine.__setExperienceSize(576);
    return Array.from({ length: 576 }, (_, index) => ({
      creditVersion: 8,
      contextKey: `route|egxa-${index}`,
      actionKey: 'route:learned',
    }));
  });
  context.window.NarduController.getState().phase = 'waiting';

  context.window.NarduController.__test.ensureAutoProgressAfterExperience(0, 50);
  await new Promise(resolve => setTimeout(resolve, 65));

  const frozen = context.window.NarduLongBotEngine.__frozenSnapshots;
  const telemetry = context.window.NarduController.getState().analysis.botMemory.experienceLoad;
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0].size, 576);
  assert.equal(telemetry.status, 'ready');
  assert.equal(telemetry.patternCount, 576);
  assert.equal(telemetry.experienceSize, 576);
});

test('a restored frozen game resumes immediately and defers its server refresh without retrying', async () => {
  let releaseLoad;
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  const calls = [];
  let context;
  context = loadController(async ({ refresh = false } = {}) => {
    calls.push(refresh);
    await loadGate;
    context.window.NarduLongBotEngine.__setPendingPatternCount(576);
    return [{ creditVersion: 8, contextKey: 'route|deferred', actionKey: 'route:next-game' }];
  });
  context.window.NarduLongBotEngine.__setFrozen(true);
  context.window.NarduController.getState().phase = 'waiting';

  context.window.NarduController.__test.ensureAutoProgressAfterExperience(0, 50);

  assert.equal(
    context.window.NarduLongBotEngine.__frozenSnapshots.length,
    1,
    'an immutable restored game must not wait for a network refresh',
  );
  assert.deepEqual(calls, [false]);

  releaseLoad();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const telemetry = context.window.NarduController.getState().analysis.botMemory.experienceLoad;
  assert.equal(telemetry.status, 'deferred');
  assert.equal(telemetry.deferred, true);
  assert.equal(telemetry.patternCount, 1);
  assert.deepEqual(calls, [false], 'deferred application is expected and must not trigger a retry');
});

test('hard long game retries a failed memory load before freezing the session', async () => {
  const calls = [];
  const context = loadController(async ({ refresh = false } = {}) => {
    calls.push(refresh);
    if (calls.length === 1) throw new Error('temporary experience failure');
    return [{ creditVersion: 8, contextKey: 'route|retry', actionKey: 'route:ready' }];
  });

  const patterns = await context.window.NarduController.__test.loadLongBotExperienceBeforeStart();
  const telemetry = context.window.NarduController.getState().analysis.botMemory.experienceLoad;

  assert.deepEqual(calls, [false, true]);
  assert.equal(patterns[0].actionKey, 'route:ready');
  assert.equal(telemetry.status, 'ready');
  assert.equal(telemetry.attempts, 2);
  assert.equal(telemetry.patternCount, 1);
  assert.equal(telemetry.experienceSize, 17);
  assert.equal(telemetry.error, '');
});

test('a fetched but unapplied experience snapshot is reported as a failure', async () => {
  const calls = [];
  const context = loadController(async ({ refresh = false } = {}) => {
    calls.push(refresh);
    return [{ creditVersion: 8, contextKey: 'route|ignored', actionKey: 'route:ignored' }];
  });
  context.window.NarduLongBotEngine.__setExperienceSize(0);

  await assert.rejects(
    context.window.NarduController.__test.loadLongBotExperienceBeforeStart(),
    /fetched but not applied/,
  );
  const telemetry = context.window.NarduController.getState().analysis.botMemory.experienceLoad;
  assert.deepEqual(calls, [false, true]);
  assert.equal(telemetry.status, 'failed');
  assert.equal(telemetry.attempts, 2);
  assert.match(telemetry.error, /fetched but not applied/);
});

test('late server memory cannot masquerade as applied local memory', async () => {
  let context;
  context = loadController(async () => {
    context.window.NarduLongBotEngine.__setPendingPatternCount(576);
    return [{ creditVersion: 8, contextKey: 'route|late-server', actionKey: 'route:late' }];
  });

  await assert.rejects(
    context.window.NarduController.__test.loadLongBotExperienceBeforeStart(),
    /fetched but not applied/,
  );
  const telemetry = context.window.NarduController.getState().analysis.botMemory.experienceLoad;
  assert.equal(context.window.NarduLongBotEngine.experienceSize(), 17);
  assert.equal(telemetry.status, 'failed');
});

test('v34 ignores server experience cached for longer than ten minutes', async () => {
  const localStorage = memoryStorage();
  localStorage.setItem('narduh-long-bot-server-experience-v15', JSON.stringify({
    savedAt: Date.now() - 10 * 60 * 1000 - 1,
    playerKey: 'tester1',
    creditVersion: 8,
    patterns: [{
      creditVersion: 8,
      contextKey: 'route|expired',
      actionKey: 'route:expired',
    }],
  }));
  const applied = [];
  const rooms = loadRoomsClient({
    localStorage,
    window: {
      NarduSupabase: {
        configured() { return true; },
        async client() {
          return { async rpc() { return { data: null, error: { message: 'offline' } }; } };
        },
      },
      NarduLongBotEngine: {
        setExperience(patterns, source) { applied.push({ patterns, source }); },
      },
    },
  });

  await assert.rejects(
    rooms.loadLongBotExperience({ playerName: 'tester1' }),
    /offline/,
  );
  assert.equal(localStorage.getItem('narduh-long-bot-server-experience-v15'), null);
  assert.equal(applied.some(item => (
    item.source === 'server-cache' && item.patterns[0]?.actionKey === 'route:expired'
  )), false);
});
