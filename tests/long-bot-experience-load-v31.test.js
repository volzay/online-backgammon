const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function memoryStorage() {
  const values = new Map();
  return {
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
      experienceSize() { return 17; },
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
      href: 'https://example.test/room.html?mode=bot&game=LOAD-V31&variant=long&difficulty=hard',
      pathname: '/room.html',
      search: '?mode=bot&game=LOAD-V31&variant=long&difficulty=hard',
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
      '    preferredMoveAction,\n    __test: { loadLongBotExperienceBeforeStart },\n  };',
    );
  vm.runInContext(source, context, { filename: 'game-controller.js' });
  window.NarduController.init({
    mode: 'bot',
    roomCode: 'LOAD-V31',
    variant: 'long',
    difficulty: 'hard',
    opponent: 'Hard bot',
    opponentRating: 1500,
    skipAutoStart: true,
  });
  return context;
}

test('lobby prefetch caches v31 experience even before the long engine is loaded', async () => {
  const localStorage = memoryStorage();
  const pattern = {
    creditVersion: 7,
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
  const cached = JSON.parse(localStorage.getItem('narduh-long-bot-server-experience-v13'));
  assert.equal(cached.creditVersion, 7);
  assert.equal(cached.patterns[0].contextKey, pattern.contextKey);

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

test('hard long game retries a failed memory load before freezing the session', async () => {
  const calls = [];
  const context = loadController(async ({ refresh = false } = {}) => {
    calls.push(refresh);
    if (calls.length === 1) throw new Error('temporary experience failure');
    return [{ creditVersion: 7, contextKey: 'route|retry', actionKey: 'route:ready' }];
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
