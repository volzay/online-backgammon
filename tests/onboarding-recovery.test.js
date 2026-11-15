const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'onboarding.js'), 'utf8');
const accountKey = 'narduh-onboarding-v1:account';
const newDate = '2026-11-15T04:00:00Z';
const oldDate = '2026-10-21T00:00:00Z';
const flush = () => new Promise(resolve => setImmediate(resolve));

function openLobby({ createdAt, sessionUser, saved, search = '' } = {}) {
  const data = new Map();
  if (saved) data.set(accountKey, JSON.stringify(saved));
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const makeElement = () => ({ textContent: '', style: {}, hidden: false, addEventListener() {}, setAttribute() {}, focus() {} });
  const launcher = makeElement();
  const names = 'card spotlight progress title text skip back next'.split(' ');
  const parts = Object.fromEntries(names.map(name => [`.onboarding-${name}`, makeElement()]));
  const dialog = {
    ...makeElement(), open: false, showModal() { this.open = true; },
    querySelector: key => parts[key], querySelectorAll: () => Array.from({ length: 4 }, makeElement),
  };
  const document = {
    readyState: 'complete', body: { append() {} }, documentElement: { lang: 'ru', clientWidth: 1000, clientHeight: 800 },
    createElement: () => dialog, querySelector: () => null, querySelectorAll: () => [launcher],
  };
  parts['.onboarding-card'].getBoundingClientRect = () => ({ width: 360, height: 200 });
  let sessionChecks = 0;
  const window = {
    NarduApp: { getUser: () => ({ id: 'account', createdAt }) }, addEventListener() {},
    NarduSupabase: { configured: () => true, client: async () => ({ auth: {
      async getSession() { sessionChecks += 1; return { data: { session: { user: sessionUser } } }; },
    } }) },
  };
  vm.runInNewContext(source, { window, document, localStorage: storage, URLSearchParams,
    location: { pathname: '/index.html', search }, requestAnimationFrame: () => 1 });
  return { dialog, launcher, data, get sessionChecks() { return sessionChecks; } };
}

test('a new account gets the welcome on a fresh browser after password login', () => {
  const lobby = openLobby({ createdAt: newDate });
  assert.equal(lobby.dialog.open, true);
  assert.equal(lobby.sessionChecks, 0);
  assert.equal(JSON.parse(lobby.data.get(accountKey)).status, 'pending');
});

test('an existing session recovers the welcome for the same new account only', async () => {
  const matching = openLobby({ sessionUser: { id: 'account', created_at: newDate } });
  const mismatched = openLobby({ sessionUser: { id: 'other', created_at: newDate } });
  await flush();
  assert.equal(matching.dialog.open, true);
  assert.equal(mismatched.dialog.open, false);
  assert.equal(mismatched.data.has(accountKey), false);
});

test('old accounts, invitation links and saved decisions keep ordinary lobby access', async () => {
  for (const options of [{ createdAt: oldDate }, { createdAt: newDate, search: '?join=ABCD-EFGH' },
    { createdAt: newDate, saved: { status: 'skipped' } }, { createdAt: newDate, saved: { status: 'completed' } }]) {
    const lobby = openLobby(options);
    await flush();
    assert.equal(lobby.dialog.open, false);
    assert.equal(lobby.launcher.hidden, false);
    assert.equal(lobby.sessionChecks, 0);
  }
});
