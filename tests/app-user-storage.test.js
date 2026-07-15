const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function quotaStorage(initial = {}, limit = 8000) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) {
      const next = new Map(values);
      next.set(key, String(value));
      const size = [...next.entries()].reduce((total, [name, item]) => total + name.length + item.length, 0);
      if (size > limit) {
        const error = new Error('The quota has been exceeded.');
        error.name = 'QuotaExceededError';
        throw error;
      }
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
  };
}

function loadApp(storage, { withContext = false } = {}) {
  const sessionValues = new Map();
  const sessionStorage = {
    getItem(key) { return sessionValues.get(key) || null; },
    setItem(key, value) { sessionValues.set(key, String(value)); },
    removeItem(key) { sessionValues.delete(key); },
  };
  const document = {
    readyState: 'loading',
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const context = {
    window: { addEventListener() {} },
    document,
    localStorage: storage,
    sessionStorage,
    location: { href: '' },
    console,
    Date,
    Math,
    JSON,
    setInterval() { return 1; },
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), context, { filename: 'app.js' });
  return withContext ? { app: context.window.NarduApp, context, sessionStorage } : context.window.NarduApp;
}

test('oversized match logs are compacted before a profile reaches localStorage quota', () => {
  const oversizedHistory = Array.from({ length: 60 }, (_, index) => ({
    resultKey: `room-${index}`,
    score: {
      white: 360,
      dark: 300,
      finalState: { analysis: { decisions: Array.from({ length: 60 }, () => 'x'.repeat(80)) } },
    },
    history: Array.from({ length: 240 }, () => ({ move: 'x'.repeat(80) })),
  }));
  const storage = quotaStorage({
    'narduh-user': JSON.stringify({ id: 'user-1', name: 'tester1', history: oversizedHistory }),
  });
  const app = loadApp(storage);

  assert.doesNotThrow(() => app.setUser({
    id: 'user-1',
    name: 'tester1',
    nickname: 'tester1',
    rating: 1200,
    registered: true,
    guest: false,
    history: oversizedHistory,
  }));

  const stored = JSON.parse(storage.getItem('narduh-user'));
  assert.equal(stored.history.length, 50);
  assert.equal(stored.history[0].history, undefined);
  assert.equal(stored.history[0].score.finalState, undefined);
  assert.equal(stored.history[0].historyCount, 240);
});

test('bot game creation survives quota errors and prunes stale bot settings', () => {
  const storage = quotaStorage({
    'narduh-bot-game:OLD1-ROOM': 'x'.repeat(500),
    'narduh-theme': 'night',
  }, 700);
  const app = loadApp(storage);

  assert.equal(app.persistBotGameConfig({
    game: 'NEW1-ROOM',
    opponent: 'bot',
    difficulty: 'hard',
    variant: 'long',
  }), true);

  assert.equal(storage.getItem('narduh-bot-game:OLD1-ROOM'), null);
  assert.equal(JSON.parse(storage.getItem('narduh-bot-game:NEW1-ROOM')).difficulty, 'hard');
  assert.equal(JSON.parse(storage.getItem('narduh-created-game')).game, 'NEW1-ROOM');
});

test('bot game persistence never throws when quota cannot be recovered', () => {
  const storage = quotaStorage({ 'narduh-user': 'x'.repeat(1000) }, 200);
  const app = loadApp(storage);

  assert.doesNotThrow(() => app.persistBotGameConfig({
    game: 'FULL-ROOM',
    opponent: 'bot',
    difficulty: 'hard',
    variant: 'long',
  }));
  assert.equal(app.persistBotGameConfig({ game: 'FULL-ROOM' }), false);
});

test('a missing Supabase session clears the false login and preserves the re-login identity', () => {
  const storage = quotaStorage({
    'narduh-user': JSON.stringify({
      id: 'user-1',
      name: 'warlord',
      nickname: 'warlord',
      rating: 1566,
      registered: true,
      guest: false,
    }),
  });
  const { app, context, sessionStorage } = loadApp(storage, { withContext: true });

  assert.equal(app.redirectForAuthError({ message: 'Auth session missing!', status: 401 }), true);
  assert.equal(storage.getItem('narduh-user'), null);
  assert.equal(JSON.parse(sessionStorage.getItem('narduh-reauth-context')).identifier, 'warlord');
  assert.equal(context.location.href, 'login.html?reason=session-expired');
});
