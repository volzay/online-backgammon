const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const lobbyHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const roomHtml = fs.readFileSync(path.join(ROOT, 'room.html'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const loginHtml = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
const gateMatch = lobbyHtml.match(/<script>\s*(\/\* Keep the lobby private[\s\S]*?)<\/script>/);
const roomGateMatch = roomHtml.match(/<script>\s*(\/\* A direct room link[\s\S]*?)<\/script>/);
const TEST_GUEST_PROOF = `gproof:${'42'.repeat(32)}`;
const TEST_GUEST_ID = `guest:sha256:${createHash('sha256')
  .update(`nardu/guest/v1:${TEST_GUEST_PROOF}`)
  .digest('hex')}`;

function secureGuestStorage(name = 'Guest5678') {
  return {
    'narduh-user': JSON.stringify({ id: TEST_GUEST_ID, name, guest: true }),
    'narduh-guest-entry-v1': '1',
    'narduh-guest-credential-v1': JSON.stringify({
      version: 1,
      guestId: TEST_GUEST_ID,
      proof: TEST_GUEST_PROOF,
    }),
  };
}

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
    window: { addEventListener() {}, crypto: webcrypto },
    document,
    localStorage,
    sessionStorage,
    location: {
      href: '',
      search: '',
      replace(url) { redirects.push(url); },
    },
    console,
    Date,
    Math,
    JSON,
    setInterval() { return 1; },
    TextEncoder,
    Uint8Array,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(appSource, context, { filename: 'app.js' });
  return { app: context.window.NarduApp, localStorage, location: context.location, redirects };
}

test('a signed-in player keeps a valid room invitation when leaving an auth page', () => {
  const { app, location } = loadApp({
    'narduh-user': JSON.stringify({ id: 'user-1', name: 'tester1', guest: false }),
  });
  location.search = '?join=slwa-xwcq';

  app.requireGuest();

  assert.equal(location.href, 'index.html?join=SLWA-XWCQ');
});

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

  const placeholderAccount = runLobbyGate({
    'narduh-user': JSON.stringify({ id: '', name: 'A', guest: false }),
  });
  assert.deepEqual(placeholderAccount.redirects, ['login.html?invite=ROOM#join']);

  const unnumberedGuest = runLobbyGate({
    'narduh-user': JSON.stringify({ id: 'guest:broken', name: 'Guest', guest: true }),
    'narduh-guest-entry-v1': '1',
  });
  assert.deepEqual(unnumberedGuest.redirects, ['login.html?invite=ROOM#join']);
});

test('registered users and explicitly admitted guests may enter the lobby', () => {
  const registered = runLobbyGate({
    'narduh-user': JSON.stringify({ id: '14743530-785c-45ed-9632-c1d57fbcccd7', name: 'tester1', guest: false }),
    'narduh-guest-entry-v1': '1',
  });
  assert.deepEqual(registered.redirects, []);
  assert.equal(registered.localStorage.getItem('narduh-guest-entry-v1'), null);

  const guest = runLobbyGate(secureGuestStorage());
  assert.deepEqual(guest.redirects, []);
  assert.equal(guest.localStorage.getItem('narduh-user') !== null, true);

  const localServerAccount = runLobbyGate({
    'narduh-user': JSON.stringify({ id: 'usr_local-account-1', name: 'local-player', guest: false }),
  });
  assert.deepEqual(localServerAccount.redirects, []);
});

test('the shared auth fallback redirects instead of silently creating a guest', () => {
  const requireAuth = appSource.match(/function requireAuth\(\) \{([\s\S]*?)\n  \}/)?.[1] || '';

  assert.match(requireAuth, /location\.replace\('login\.html'\)/);
  assert.doesNotMatch(requireAuth, /createGuestUser|setUser/);
  assert.match(loginHtml, /id="guest-btn"/);
  assert.match(loginHtml, /NarduApp\.beginGuestSession\(\)/);
  assert.doesNotMatch(lobbyHtml, /function makeGuest|localStorage\.setItem\(key, JSON\.stringify\(makeGuest/);
  assert.match(lobbyHtml, /class="auth-pending"/);
  assert.match(lobbyHtml, /Never expose the lobby's placeholder identity/);
  assert.match(roomHtml, /Never expose a room's placeholder identity/);
});

test('guest access is persisted only by the explicit guest-session action', async () => {
  const { app, localStorage, redirects } = loadApp();

  assert.equal(app.requireAuth(), null);
  assert.deepEqual(redirects, ['login.html']);
  assert.equal(localStorage.getItem('narduh-user'), null);

  const guest = await app.beginGuestSession();
  assert.equal(guest?.guest, true);
  assert.match(guest.id, /^guest:sha256:[0-9a-f]{64}$/);
  assert.equal(localStorage.getItem('narduh-guest-entry-v1'), '1');
  const credential = JSON.parse(localStorage.getItem('narduh-guest-credential-v1'));
  assert.equal(credential.guestId, guest.id);
  assert.match(credential.proof, /^gproof:[0-9a-f]{64}$/);
  assert.equal(JSON.parse(localStorage.getItem('narduh-user')).proof, undefined);
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

test('an explicitly admitted guest can open auth pages to create a permanent account', () => {
  const { app, localStorage, location } = loadApp(secureGuestStorage());

  app.requireGuest();

  assert.ok(localStorage.getItem('narduh-user'));
  assert.equal(location.href, '');
});

test('a direct room link cannot bypass explicit guest entry', () => {
  const legacyGuest = runRoomGate({
    'narduh-user': JSON.stringify({ id: 'guest:old', name: 'Guest1234', guest: true }),
  });
  assert.deepEqual(legacyGuest.redirects, ['login.html']);
  assert.equal(legacyGuest.localStorage.getItem('narduh-user'), null);

  const explicitGuest = runRoomGate(secureGuestStorage());
  assert.deepEqual(explicitGuest.redirects, []);
});

test('a copied public guest id without its matching proof fails closed', () => {
  const copied = runLobbyGate({
    'narduh-user': JSON.stringify({ id: TEST_GUEST_ID, name: 'Guest5678', guest: true }),
    'narduh-guest-entry-v1': '1',
  });
  assert.deepEqual(copied.redirects, ['login.html?invite=ROOM#join']);
  assert.equal(copied.localStorage.getItem('narduh-user'), null);

  const wrongProof = runRoomGate({
    ...secureGuestStorage(),
    'narduh-guest-credential-v1': JSON.stringify({
      version: 1,
      guestId: TEST_GUEST_ID,
      proof: `gproof:${'99'.repeat(32)}`,
    }),
  });
  assert.deepEqual(wrongProof.redirects, [], 'shape-only entry gate defers cryptographic verification to RLS');
});
