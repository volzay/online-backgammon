const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function quotaStorage(initial = {}, limit = 8000) {
  const values = new Map(Object.entries(initial));
  return {
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

function loadApp(storage) {
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
  return context.window.NarduApp;
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
