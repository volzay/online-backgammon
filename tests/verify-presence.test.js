const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const bundle = buildSync({
  entryPoints: [path.join(__dirname, '../lib/verify-presence.mjs')],
  bundle: true, platform: 'browser', target: 'es2022', write: false,
}).outputFiles[0].text;
const api = 'https://api.example.test';
const rpcUrl = `${api}/rest/v1/rpc/touch_lobby_presence`;
const tokenUrl = `${api}/auth/v1/token?grant_type=refresh_token`;
const player = { id: 'player-1', guest: false };
const guest = { id: `guest:sha256:${'a'.repeat(64)}`, guest: true };
const proof = `gproof:${'b'.repeat(64)}`;
const flush = () => new Promise(resolve => setImmediate(resolve));

function session(user = player, expiresIn = 3600) {
  return {
    access_token: 'fixture-access', refresh_token: 'fixture-refresh',
    expires_at: Math.floor(Date.now() / 1000) + expiresIn, expires_in: expiresIn,
    user: { id: user.id },
  };
}

function fixture({ user, storedSession, guestProof, hidden = false, reply } = {}) {
  const storage = new Map();
  if (user) storage.set('narduh-user', JSON.stringify(user));
  if (storedSession) storage.set('sb-api-auth-token', JSON.stringify(storedSession));
  if (guestProof) storage.set('narduh-guest-credential-v1', JSON.stringify({ version: 1, guestId: user.id, proof: guestProof }));
  const windowEvents = new Map();
  const documentEvents = new Map();
  const requests = [];
  const timers = new Map();
  let timeoutId = 0;
  const window = {
    NARDU_ENV: { supabaseUrl: api, supabaseAnonKey: 'fixture-publishable-key' },
    addEventListener: (name, fn) => windowEvents.set(name, fn),
    get location() { assert.fail('Presence must not read the verifier URL.'); },
  };
  const document = {
    hidden,
    addEventListener: (name, fn) => documentEvents.set(name, fn),
    querySelector() { assert.fail('Presence must not read verifier inputs.'); },
  };
  const localStorage = {
    getItem(key) {
      assert.match(key, /^(?:narduh-user|narduh-guest-credential-v1|sb-api-auth-token(?:-user)?|supabase\.gotrue-js\.locks\.debug|lswt)$/);
      return storage.get(key) || null;
    },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); },
  };
  vm.runInNewContext(bundle, {
    window, document, localStorage, URL, URLSearchParams, AbortController, console,
    async fetch(url, options) {
      requests.push({ url, ...options });
      return reply?.(url, options) || new Response('true');
    },
    setTimeout(fn, ms) { timers.set(++timeoutId, { fn, ms }); return timeoutId; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { requests, timers, document, documentEvents, windowEvents, storage };
}

function assertHeartbeat(request) {
  assert.equal(request.url, rpcUrl);
  assert.equal(request.method, 'POST');
  assert.equal(request.body, '{}');
  assert.equal(request.referrerPolicy, 'no-referrer');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'error');
}

test('the verifier sends an empty heartbeat for an existing registered session and resumes after navigation', async () => {
  const f = fixture({ user: player, storedSession: session(), hidden: true });
  await flush();
  assert.equal(f.requests.length, 0);
  f.document.hidden = false;
  await f.documentEvents.get('visibilitychange')();
  assert.equal(f.requests.length, 1);
  assertHeartbeat(f.requests[0]);
  assert.equal(f.requests[0].headers.Authorization, 'Bearer fixture-access');
  assert.equal([...f.timers.values()][0].ms, 30000);
  await f.windowEvents.get('pageshow')();
  assert.equal(f.requests.length, 2);
  f.storage.delete('narduh-user');
  await f.windowEvents.get('online')();
  assert.equal(f.requests.length, 2);
});

test('an expired existing session renews only through the configured auth endpoint', async () => {
  const f = fixture({ user: player, storedSession: session(player, -60), reply(url) {
    if (url === tokenUrl) return Response.json({ ...session(), access_token: 'fixture-renewed' });
  } });
  await flush();
  assert.deepEqual(f.requests.map(({ url }) => url), [tokenUrl, rpcUrl]);
  assert.deepEqual(JSON.parse(f.requests[0].body), { refresh_token: 'fixture-refresh' });
  assertHeartbeat(f.requests[1]);
  assert.equal(f.requests[1].headers.Authorization, 'Bearer fixture-renewed');
});

test('guest presence uses its existing proof and retries a transient heartbeat failure', async () => {
  let fail = true;
  const f = fixture({ user: guest, guestProof: proof, reply() {
    return fail ? new Response('false', { status: 503 }) : new Response('true');
  } });
  await flush();
  assert.equal(f.requests.length, 1);
  assertHeartbeat(f.requests[0]);
  assert.equal(f.requests[0].headers['X-Guest-Id'], guest.id);
  assert.equal(f.requests[0].headers['X-Guest-Proof'], proof);
  assert.equal(f.requests[0].headers.Authorization, undefined);
  const [retry] = f.timers.values();
  assert.equal(retry.ms, 5000);
  fail = false;
  await retry.fn();
  assert.equal(f.requests.length, 2);
  assert.equal([...f.timers.values()][0].ms, 30000);
});

test('anonymous visitors, mismatched accounts and guests without proof send no presence', async () => {
  const trials = [fixture(), fixture({ user: guest }), fixture({ user: player,
    storedSession: session({ id: 'other-player' }, -60) })];
  await flush();
  for (const f of trials) assert.equal(f.requests.length, 0);
});
