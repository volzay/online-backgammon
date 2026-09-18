'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'supabase-client.js'), 'utf8');
const API = 'https://supabase.example.test';
const MARKER = 'nardu-fair-dice-v36';
const GUEST_ID = `guest:sha256:${'41'.repeat(32)}`;
const GUEST_PROOF = `gproof:${'52'.repeat(32)}`;

async function loadClient({ guest = false, headersAvailable = true, urlAvailable = true,
  api = API, credential = { version: 1, guestId: GUEST_ID, proof: GUEST_PROOF } } = {}) {
  const values = new Map([
    ['narduh-user', JSON.stringify(guest ? { id: GUEST_ID, guest: true, name: 'Guest1234' }
      : { id: 'registered-player', guest: false })],
    ['narduh-guest-credential-v1', JSON.stringify(credential)],
  ]);
  const calls = [];
  let options;
  const context = { window: {
    NARDU_ENV: { supabaseUrl: api, supabaseAnonKey: 'test-public-anon' },
    supabase: { createClient(_url, _key, supplied) { options = supplied; return {}; } },
  }, document: { querySelector() { return null; }, createElement() { return {}; }, head: { appendChild() {} } },
  localStorage: { getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }, key(index) { return [...values.keys()][index] ?? null; },
    get length() { return values.size; } },
  Headers: headersAvailable ? Headers : undefined,
  URL: urlAvailable ? URL : undefined,
  AbortController, setTimeout, clearTimeout, console,
  fetch: async (input, init) => { calls.push({ input, init }); return { ok: true, status: 200 }; },
  };
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'supabase-client.js' });
  await context.window.NarduSupabase.client();
  return { calls, fetch: options.global.fetch, values };
}

function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) ?? undefined;
  const entries = Array.isArray(headers) ? headers : Object.entries(headers || {});
  return entries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function assertProtocol(headers, original = '') {
  const info = header(headers, 'X-Client-Info');
  assert.equal(info, `${original} ${MARKER} nardu-fair-dice-v37`.trim());
  assert.equal(info.split(/\s+/).filter(value => value === MARKER).length, 1);
  assert.equal(info.split(/\s+/).filter(value => value === 'nardu-fair-dice-v37').length, 1);
}

for (const guest of [false, true]) {
  test(`same-origin REST adds compatibility marker for ${guest ? 'guest' : 'registered'} without replacing Authorization`, async () => {
    const client = await loadClient({ guest });
    const original = { Authorization: 'Bearer existing-session', 'X-Client-Info': 'supabase-js-web/2.99.0' };
    await client.fetch(`${API}/rest/v1/rooms`, { method: 'POST', headers: original, body: '{"variant":"long"}' });
    const request = client.calls[0];
    assertProtocol(request.init.headers, 'supabase-js-web/2.99.0');
    assert.equal(header(request.init.headers, 'Authorization'), 'Bearer existing-session');
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.body, '{"variant":"long"}');
    assert.equal(header(request.init.headers, 'X-Guest-Id'), guest ? GUEST_ID : undefined);
    assert.equal(header(request.init.headers, 'X-Guest-Proof'), guest ? GUEST_PROOF : undefined);
    assert.deepEqual(original, { Authorization: 'Bearer existing-session', 'X-Client-Info': 'supabase-js-web/2.99.0' });
  });

  test(`Request.headers survive when init is absent for ${guest ? 'guest' : 'registered'}`, async () => {
    const client = await loadClient({ guest });
    const request = new Request(`${API}/rest/v1/rooms`, { headers: {
      Authorization: 'Bearer request-session', 'X-Client-Info': 'sdk/request', 'Prefer': 'return=representation',
    } });
    await client.fetch(request);
    const headers = client.calls[0].init.headers;
    assertProtocol(headers, 'sdk/request');
    assert.equal(header(headers, 'Authorization'), 'Bearer request-session');
    assert.equal(header(headers, 'Prefer'), 'return=representation');
    assert.equal(header(headers, 'X-Guest-Proof'), guest ? GUEST_PROOF : undefined);
    assert.equal(request.headers.get('X-Client-Info'), 'sdk/request');
  });
}

test('existing compatibility marker is preserved once, including case-insensitive Headers names', async () => {
  const client = await loadClient();
  const original = new Headers({ 'x-client-info': `sdk/v2\t${MARKER}  other-client`, authorization: 'Bearer unchanged' });
  await client.fetch(`${API}/rest/v1/rooms`, { headers: original });
  const headers = client.calls[0].init.headers;
  assert.equal(header(headers, 'x-client-info'), `sdk/v2\t${MARKER}  other-client nardu-fair-dice-v37`);
  assert.equal(header(headers, 'Authorization'), 'Bearer unchanged');
  assert.equal(header(headers, 'x-client-info').split(/\s+/).filter(value => value === MARKER).length, 1);
});

test('explicit init headers override Request headers just as normal Fetch semantics require', async () => {
  const client = await loadClient();
  const request = new Request(`${API}/rest/v1/rooms`, { headers: { Authorization: 'Bearer request-old', 'X-Client-Info': 'request-old' } });
  await client.fetch(request, { headers: { Authorization: 'Bearer init-current', 'X-Client-Info': 'init-current' } });
  assertProtocol(client.calls[0].init.headers, 'init-current');
  assert.equal(header(client.calls[0].init.headers, 'Authorization'), 'Bearer init-current');
});

for (const guest of [false, true]) {
  for (const style of ['plain', 'tuples', 'request']) {
    test(`without Headers constructor preserves ${style} headers for ${guest ? 'guest' : 'registered'}`, async () => {
      const client = await loadClient({ guest, headersAvailable: false });
      const original = { authorization: 'Bearer preserved-fallback', 'x-cLiEnT-iNfO': 'sdk/fallback', prefer: 'return=representation' };
      if (style === 'request') await client.fetch(new Request(`${API}/rest/v1/rooms`, { headers: original }));
      else await client.fetch(`${API}/rest/v1/rooms`, { headers: style === 'tuples' ? Object.entries(original) : original });
      const headers = client.calls[0].init.headers;
      assertProtocol(headers, 'sdk/fallback');
      assert.equal(header(headers, 'Authorization'), 'Bearer preserved-fallback');
      assert.equal(header(headers, 'Prefer'), 'return=representation');
      assert.equal(header(headers, 'X-Guest-Proof'), guest ? GUEST_PROOF : undefined);
      assert.equal(Object.keys(headers).filter(key => key.toLowerCase() === 'x-client-info').length, 1);
      assert.deepEqual(original, { authorization: 'Bearer preserved-fallback', 'x-cLiEnT-iNfO': 'sdk/fallback', prefer: 'return=representation' });
    });
  }
}

test('fallback without Headers does not duplicate an already present marker', async () => {
  const client = await loadClient({ headersAvailable: false });
  await client.fetch(`${API}/rest/v1/rooms`, { headers: [['authorization', 'Bearer intact'], ['x-client-info', `sdk ${MARKER}`]] });
  assertProtocol(client.calls[0].init.headers, 'sdk');
  assert.equal(header(client.calls[0].init.headers, 'Authorization'), 'Bearer intact');
});

test('foreign REST, auth, storage and origin lookalikes receive no marker or auto guest credentials', async () => {
  const client = await loadClient({ guest: true });
  const targets = [
    'https://foreign.example.test/rest/v1/rooms',
    'https://supabase.example.test.attacker.test/rest/v1/rooms',
    'https://supabase.example.test@foreign.example.test/rest/v1/rooms',
    'http://supabase.example.test/rest/v1/rooms',
    'https://supabase.example.test:8443/rest/v1/rooms',
    `${API}/auth/v1/user`, `${API}/storage/v1/object/public/asset`,
    `${API}/rest/v10/rooms`, `${API}/rest/v1evil/rooms`,
  ];
  const init = { method: 'GET', headers: { Authorization: 'Bearer caller-controlled', 'X-Client-Info': 'original-sdk' } };
  for (const target of targets) await client.fetch(target, init);
  assert.equal(client.calls.length, targets.length);
  for (const { init: forwarded } of client.calls) {
    assert.equal(forwarded.headers, init.headers);
    assert.equal(header(forwarded.headers, 'X-Client-Info'), 'original-sdk');
    assert.equal(header(forwarded.headers, 'Authorization'), 'Bearer caller-controlled');
    assert.equal(header(forwarded.headers, 'X-Guest-Id'), undefined);
    assert.equal(header(forwarded.headers, 'X-Guest-Proof'), undefined);
  }
});

test('foreign Request remains untouched when init headers are absent', async () => {
  const client = await loadClient({ guest: true });
  const request = new Request('https://foreign.example.test/rest/v1/rooms', { headers: { 'X-Client-Info': 'foreign-sdk' } });
  await client.fetch(request);
  assert.equal(client.calls[0].input, request);
  assert.equal(client.calls[0].init.headers, undefined);
  assert.equal(request.headers.get('X-Client-Info'), 'foreign-sdk');
  assert.equal(request.headers.get('X-Guest-Proof'), null);
});

test('REST scope respects configured path prefix rather than any same-origin endpoint', async () => {
  const client = await loadClient({ guest: true, api: `${API}/gateway/` });
  await client.fetch(`${API}/gateway/rest/v1/rooms`);
  await client.fetch(`${API}/rest/v1/rooms`);
  assertProtocol(client.calls[0].init.headers);
  assert.equal(header(client.calls[0].init.headers, 'X-Guest-Proof'), GUEST_PROOF);
  assert.equal(client.calls[1].init.headers, undefined);
});

test('missing URL constructor uses exact configured prefix and does not forward guest proof to foreign hosts', async () => {
  const client = await loadClient({ guest: true, urlAvailable: false, headersAvailable: false });
  await client.fetch(`${API}/rest/v1/rooms`);
  await client.fetch('https://foreign.example.test/rest/v1/rooms');
  await client.fetch('https://supabase.example.test.attacker.test/rest/v1/rooms');
  assertProtocol(client.calls[0].init.headers);
  assert.equal(header(client.calls[0].init.headers, 'X-Guest-Proof'), GUEST_PROOF);
  assert.equal(client.calls[1].init.headers, undefined);
  assert.equal(client.calls[2].init.headers, undefined);
});

test('compatibility marker neither authenticates an invalid guest nor invents Authorization', async () => {
  const client = await loadClient({ guest: true, credential: { version: 1, guestId: GUEST_ID, proof: 'invalid-proof' } });
  await client.fetch(`${API}/rest/v1/rooms`);
  const headers = client.calls[0].init.headers;
  assertProtocol(headers);
  assert.equal(header(headers, 'Authorization'), undefined);
  assert.equal(header(headers, 'X-Guest-Id'), undefined);
  assert.equal(header(headers, 'X-Guest-Proof'), undefined);
});
