const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const lobbyHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const roomHtml = fs.readFileSync(path.join(ROOT, 'room.html'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const loginHtml = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
const gateMatch = lobbyHtml.match(/<script>\s*(\/\* Keep the lobby private[\s\S]*?)<\/script>/);
const roomGateMatch = roomHtml.match(/<script>\s*(\/\* A direct room link[\s\S]*?)<\/script>/);

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function runLobbyGate(initial = {}) {
  assert.ok(gateMatch, 'lobby auth gate is present');
  const localStorage = storage(initial);
  const redirects = [];
  const context = {
    localStorage,
    location: {
      search: '?invite=ROOM',
      hash: '#join',
      replace(url) { redirects.push(url); },
    },
    JSON,
    String,
    Boolean,
  };
  vm.createContext(context);
  vm.runInContext(gateMatch[1], context, { filename: 'index-auth-gate.js' });
  return { localStorage, redirects };
}

function runRoomGate(initial = {}) {
  assert.ok(roomGateMatch, 'room auth gate is present');
  const localStorage = storage(initial);
  const redirects = [];
  const context = {
    localStorage,
    location: { replace(url) { redirects.push(url); } },
    JSON,
    String,
    Boolean,
  };
  vm.createContext(context);
  vm.runInContext(roomGateMatch[1], context, { filename: 'room-auth-gate.js' });
  return { localStorage, redirects };
}

function loadApp(initial = {}) {
  const localStorage = storage(initial);
  const sessionStorage = storage();
  const redirects = [];
  const document = {
    readyState: 'loading',
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const context = {
    window: { addEventListener() {} },
    document,
    localStorage,
    sessionStorage,
    location: {
      href: '',
      replace(url) { redirects.push(url); },
    },
    console,
    Date,
    Math,
    JSON,
    setInterval() { return 1; },
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(appSource, context, { filename: 'app.js' });
  return { app: context.window.NarduApp, localStorage, location: context.location, redirects };
}

test('a first-time visitor is sent to sign-in without creating an implicit guest', () => {
  const result = runLobbyGate();

  assert.deepEqual(result.redirects, ['login.html?invite=ROOM#join']);
  assert.equal(result.localStorage.getItem('narduh-user'), null);
  assert.equal(result.localStorage.getItem('narduh-guest-entry-v1'), null);
});

test('a malformed profile and a legacy automatic guest are both migrated to sign-in', () => {
  const malformed = runLobbyGate({
    'narduh-user': '{bad json',
    'narduh-guest-entry-v1': '1',
  });
  assert.deepEqual(malformed.redirects, ['login.html?invite=ROOM#join']);
  assert.equal(malformed.localStorage.getItem('narduh-user'), null);

  const legacyGuest = runLobbyGate({
    'narduh-user': JSON.stringify({ id: 'guest:old', name: 'Guest1234', guest: true }),
  });
  assert.deepEqual(legacyGuest.redirects, ['login.html?invite=ROOM#join']);
  assert.equal(legacyGuest.localStorage.getItem('narduh-user'), null);
});

test('registered users and explicitly admitted guests may enter the lobby', () => {
  const registered = runLobbyGate({
    'narduh-user': JSON.stringify({ id: 'user-1', name: 'tester1', guest: false }),
    'narduh-guest-entry-v1': '1',
  });
  assert.deepEqual(registered.redirects, []);
  assert.equal(registered.localStorage.getItem('narduh-guest-entry-v1'), null);

  const guest = runLobbyGate({
    'narduh-user': JSON.stringify({ id: 'guest:new', name: 'Guest5678', guest: true }),
    'narduh-guest-entry-v1': '1',
  });
  assert.deepEqual(guest.redirects, []);
  assert.equal(guest.localStorage.getItem('narduh-user') !== null, true);
});

test('the shared auth fallback redirects instead of silently creating a guest', () => {
  const requireAuth = appSource.match(/function requireAuth\(\) \{([\s\S]*?)\n  \}/)?.[1] || '';

  assert.match(requireAuth, /location\.replace\('login\.html'\)/);
  assert.doesNotMatch(requireAuth, /createGuestUser|setUser/);
  assert.match(loginHtml, /id="guest-btn"/);
  assert.match(loginHtml, /NarduApp\.beginGuestSession\(\)/);
  assert.doesNotMatch(lobbyHtml, /function makeGuest|localStorage\.setItem\(key, JSON\.stringify\(makeGuest/);
});

test('guest access is persisted only by the explicit guest-session action', () => {
  const { app, localStorage, redirects } = loadApp();

  assert.equal(app.requireAuth(), null);
  assert.deepEqual(redirects, ['login.html']);
  assert.equal(localStorage.getItem('narduh-user'), null);

  const guest = app.beginGuestSession();
  assert.equal(guest?.guest, true);
  assert.equal(localStorage.getItem('narduh-guest-entry-v1'), '1');
  assert.equal(app.requireAuth()?.id, guest.id);
  assert.deepEqual(redirects, ['login.html']);
});

test('the sign-in page clears a legacy guest instead of bouncing back to the lobby', () => {
  const { app, localStorage, location } = loadApp({
    'narduh-user': JSON.stringify({ id: 'guest:old', name: 'Guest1234', guest: true }),
  });

  app.requireGuest();

  assert.equal(localStorage.getItem('narduh-user'), null);
  assert.equal(location.href, '');
});

test('a direct room link cannot bypass explicit guest entry', () => {
  const legacyGuest = runRoomGate({
    'narduh-user': JSON.stringify({ id: 'guest:old', name: 'Guest1234', guest: true }),
  });
  assert.deepEqual(legacyGuest.redirects, ['login.html']);
  assert.equal(legacyGuest.localStorage.getItem('narduh-user'), null);

  const explicitGuest = runRoomGate({
    'narduh-user': JSON.stringify({ id: 'guest:new', name: 'Guest5678', guest: true }),
    'narduh-guest-entry-v1': '1',
  });
  assert.deepEqual(explicitGuest.redirects, []);
});
