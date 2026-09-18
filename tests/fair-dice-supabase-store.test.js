const test = require('node:test');
const assert = require('node:assert/strict');
const { SupabaseFairDiceStore } = require('../lib/fair-dice-supabase-store');

const CODE = 'SAFE-RQME';
const ID = '6d437bef-6395-4b99-879b-1a6ecde7c52e';
const OLD_ID = '01af124a-c786-46a3-81be-1bb2c845b1c9';
const ANON = 'anon.key.test';
const SERVICE = 'service.key.private';
const PUBLISHABLE = 'sb_publishable_kWyPnUGXGMJ0afLvIdRNNr_j7tZjhXC';
const PLAYER = { authorization: 'Bearer player.key.test' };
const HASH = 'a'.repeat(64);

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function harness(replies, options = {}) {
  const calls = [];
  const queue = replies.slice();
  const store = new SupabaseFairDiceStore({
    url: 'https://backend.example/', anonKey: ANON, serviceRoleKey: SERVICE,
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, body: JSON.parse(init.body) });
      assert.ok(queue.length, 'an expected mock reply must be available');
      const item = queue.shift();
      return item instanceof Error ? Promise.reject(item) : item;
    },
  });
  return { store, calls };
}

function room(history = [], version = 7) {
  return {
    roomCode: CODE, version, state: { history }, fairDiceRequired: true,
    gameId: ID, serverPositionHash: HASH,
    actor: { ownsHost: true, actorColor: 'white', bot: true, guest: false },
  };
}

test('player getRoom forwards only explicit auth and guest proof using the anon key', async () => {
  const credentials = new Headers({
    Authorization: 'Bearer player.key.test', 'X-Guest-Id': 'guest:sha256:' + HASH,
    'X-Guest-Proof': 'gproof:' + HASH, apikey: 'evil-key', cookie: 'private-cookie',
  });
  const { store, calls } = harness([response(room())]);
  const result = await store.getRoom('safe-rqme', credentials);
  assert.equal(result.serverPositionHash, HASH);
  assert.equal(calls[0].url, 'https://backend.example/rest/v1/rpc/get_fair_dice_room');
  assert.deepEqual(calls[0].body, { p_room_code: CODE });
  assert.equal(calls[0].headers.authorization, 'Bearer player.key.test');
  assert.equal(calls[0].headers.apikey, ANON);
  assert.equal(calls[0].headers['x-guest-proof'], 'gproof:' + HASH);
  assert.equal(calls[0].headers.cookie, undefined);
  assert.equal(JSON.stringify(result).includes(SERVICE), false);
  assert.equal(JSON.stringify(store).includes(SERVICE), false);
});

test('only the configured publishable guest alias becomes the internal anon JWT without changing credentials', async () => {
  const credentials = new Headers({
    Authorization: `Bearer ${PUBLISHABLE}`, 'X-Guest-Id': 'guest:sha256:' + HASH,
    'X-Guest-Proof': 'gproof:' + HASH,
  });
  const original = [...credentials];
  const { store, calls } = harness([response({ ...room(), actor: { ...room().actor, guest: true } }), response({ ok: true })], { publishableKey: PUBLISHABLE });
  const result = await store.getRoom(CODE, credentials);
  assert.equal(calls[0].headers.authorization, `Bearer ${ANON}`);
  assert.equal(calls[0].headers.apikey, ANON);
  assert.equal(calls[0].headers['x-guest-id'], 'guest:sha256:' + HASH);
  assert.equal(calls[0].headers['x-guest-proof'], 'gproof:' + HASH);
  assert.deepEqual([...credentials], original);
  assert.equal(JSON.stringify(result).includes(SERVICE), false);
  assert.equal(JSON.stringify(store).includes(SERVICE), false);
  await assert.rejects(store.commitState(CODE, { history: [] }, 7, new Headers(credentials)), error => error.code === 'UNVALIDATED_ACTOR');
  await store.commitState(CODE, { history: [] }, 7, credentials);
  assert.equal(calls[1].headers.authorization, `Bearer ${SERVICE}`);
  assert.equal(calls[1].headers['x-guest-proof'], undefined);
  assert.deepEqual([...credentials], original);
});

test('registered JWTs stay unchanged even when the guest public alias is configured', async () => {
  const credentials = Object.freeze({ ...PLAYER, 'x-guest-id': 'guest:sha256:' + HASH, 'x-guest-proof': 'gproof:' + HASH });
  const { store, calls } = harness([response(room())], { publishableKey: PUBLISHABLE });
  await store.getRoom(CODE, credentials);
  assert.equal(calls[0].headers.authorization, PLAYER.authorization);
  assert.equal(calls[0].headers.apikey, ANON);
  assert.equal(JSON.stringify(calls[0].headers).includes(SERVICE), false);
  assert.equal(credentials.authorization, PLAYER.authorization);
});

for (const [name, credentials] of [
  ['unknown public alias', { authorization: 'Bearer sb_publishable_another_public_alias_key', 'x-guest-id': 'guest:sha256:' + HASH, 'x-guest-proof': 'gproof:' + HASH }],
  ['missing guest proof', { authorization: `Bearer ${PUBLISHABLE}`, 'x-guest-id': 'guest:sha256:' + HASH }],
  ['missing guest ID', { authorization: `Bearer ${PUBLISHABLE}`, 'x-guest-proof': 'gproof:' + HASH }],
  ['missing both guest headers', { authorization: `Bearer ${PUBLISHABLE}` }],
  ['empty guest proof', { authorization: `Bearer ${PUBLISHABLE}`, 'x-guest-id': 'guest:sha256:' + HASH, 'x-guest-proof': ' ' }],
]) {
  test(`guest alias ${name} is not mapped and failed persistence never authorizes a commit`, async () => {
    const { store, calls } = harness([response({ code: '42501', message: SERVICE }, 403)], { publishableKey: PUBLISHABLE });
    await assert.rejects(store.getRoom(CODE, credentials), error => error.code === '42501' && error.status === 403 && !error.message.includes(SERVICE));
    assert.equal(calls[0].headers.authorization, credentials.authorization);
    assert.equal(calls[0].headers.apikey, ANON);
    assert.equal(JSON.stringify(calls[0].headers).includes(SERVICE), false);
    await assert.rejects(store.commitState(CODE, { history: [] }, 7, credentials), error => error.code === 'UNVALIDATED_ACTOR');
    assert.equal(calls.length, 1);
  });
}

test('unconfigured public aliases remain unchanged, while paired proof without Authorization retains legacy anon authentication', async () => {
  const headers = { authorization: `Bearer ${PUBLISHABLE}`, 'x-guest-id': 'guest:sha256:' + HASH, 'x-guest-proof': 'gproof:' + HASH };
  const { store, calls } = harness([response(room()), response({ id: ID })]);
  await store.getRoom(CODE, headers);
  assert.equal(calls[0].headers.authorization, headers.authorization);
  await store.reserve(CODE, { label: 'opening', color: 'none' }, { 'x-guest-id': headers['x-guest-id'], 'x-guest-proof': headers['x-guest-proof'] });
  assert.equal(calls[1].headers.authorization, `Bearer ${ANON}`);
  assert.equal(headers.authorization, `Bearer ${PUBLISHABLE}`);
});

test('publishable alias configuration rejects secret keys, malformed names, whitespace and injection without echoing values', () => {
  for (const publishableKey of ['sb_secret_' + HASH, SERVICE, 'sb_publishable_', 'sb_publishable_abc', PUBLISHABLE + ' ', PUBLISHABLE + '\r\nInjected:value', 'sb_publishable_' + 'a'.repeat(129), 42, 'sb_publishable_' + 'é'.repeat(32)]) {
    assert.throws(() => new SupabaseFairDiceStore({ url: 'https://backend.example', anonKey: ANON, serviceRoleKey: SERVICE, publishableKey }), error => error instanceof TypeError && !error.message.includes(SERVICE) && !error.message.includes(String(publishableKey)));
  }
});

test('reserve passes intent only, never caller round, nonce, proof or beacon randomness', async () => {
  const { store, calls } = harness([response({ id: ID })]);
  const result = await store.reserve(CODE, {
    label: 'opening', color: 'none', positionHash: HASH,
    round: 1, nonce: 99, proof: {}, randomness: 'evil',
  }, { 'X-Guest-Id': 'guest:sha256:' + HASH, 'X-Guest-Proof': 'gproof:' + HASH });
  assert.equal(result.id, ID);
  assert.deepEqual(calls[0].body, {
    p_room_code: CODE, p_label: 'opening', p_color: 'none', p_position_hash: HASH,
  });
  assert.equal(calls[0].headers.authorization, `Bearer ${ANON}`);
  assert.equal(calls[0].headers.apikey, ANON);
  assert.equal(calls[0].headers['x-guest-proof'], 'gproof:' + HASH);
});

test('presence refresh uses caller credentials and server-derived time, then authorizes a terminal commit', async () => {
  const headers = { ...PLAYER };
  const refreshed = { ...room(), presence: { white: { lastSeen: 1789712000000 } }, serverNowMs: 1789712000000, leftPlayers: {} };
  const { store, calls } = harness([response(refreshed), response({ ok: true, version: 8 })]);
  const result = await store.touchPresence(CODE, headers);
  assert.equal(result.serverNowMs, 1789712000000);
  assert.equal(calls[0].url.endsWith('/touch_fair_dice_presence'), true);
  assert.deepEqual(calls[0].body, { p_room_code: CODE });
  assert.equal(calls[0].headers.apikey, ANON);
  await store.commitState(CODE, { history: [] }, 7, headers);
  assert.equal(calls[1].headers.apikey, SERVICE);
});

test('background pending list uses service authority and is bounded to 100 entries', async () => {
  const pending = [{ request: { id: ID }, proof: null, consumed: false, cancelled: false }];
  const { store, calls } = harness([response(pending), response(Array(101).fill(pending[0]))]);
  assert.deepEqual(await store.listPending(), pending);
  assert.equal(calls[0].headers.apikey, SERVICE);
  assert.deepEqual(calls[0].body, {});
  await assert.rejects(store.listPending(), /Invalid pending dice response/);
});

test('clean waiting-room close is ownership-checked under caller credentials, never service authority', async () => {
  const result = { ok: true, removed: true, closed: true, version: 0, state: null, gameId: ID };
  const { store, calls } = harness([response(result)]);
  assert.deepEqual(await store.closeFairWaitingRoom(CODE, PLAYER), result);
  assert.equal(calls[0].url.endsWith('/close_fair_dice_waiting_room'), true);
  assert.deepEqual(calls[0].body, { p_room_code: CODE });
  assert.equal(calls[0].headers.apikey, ANON);
  assert.equal(calls[0].headers.authorization, PLAYER.authorization);
});

test('proof reads and immutable proof completion use server credentials, not player headers', async () => {
  const proof = { protocol: 'drand-quicknet-v1', request: { id: ID } };
  const { store, calls } = harness([response({ request: { id: ID } }), response(proof)]);
  await store.getRequest(ID);
  assert.deepEqual(await store.commitProof(ID, proof), proof);
  for (const call of calls) {
    assert.equal(call.headers.authorization, `Bearer ${SERVICE}`);
    assert.equal(call.headers.apikey, SERVICE);
    assert.equal(call.headers['x-guest-proof'], undefined);
  }
  assert.deepEqual(calls[1].body, { p_request_id: ID, p_proof: proof });
});

test('state cannot be committed without a successful auth-bound getRoom', async () => {
  const { store, calls } = harness([]);
  await assert.rejects(store.commitState(CODE, { history: [] }, 7, PLAYER), error => error.code === 'UNVALIDATED_ACTOR');
  assert.equal(calls.length, 0);
});

test('getRoom validation is bound to the same credentials object, room and version', async () => {
  const headers = { ...PLAYER };
  const { store, calls } = harness([response(room())]);
  await store.getRoom(CODE, headers);
  await assert.rejects(store.commitState(CODE, {}, 7, { ...headers }), error => error.status === 403);
  await assert.rejects(store.commitState('BEEF-BEEF', {}, 7, headers), error => error.status === 403);
  await assert.rejects(store.commitState(CODE, {}, 8, headers), error => error.status === 403);
  assert.equal(calls.length, 1);
});

test('new roll commit sends the new issued request and invalidates the validation stamp', async () => {
  const headers = { ...PLAYER };
  const state = { history: [{ fairDiceProof: { request: { id: ID } } }] };
  const { store, calls } = harness([response(room()), response({ ok: true, version: 8 })]);
  await store.getRoom(CODE, headers);
  const result = await store.commitState(CODE, state, 7, headers);
  assert.equal(result.version, 8);
  assert.equal(calls[1].headers.apikey, SERVICE);
  assert.deepEqual(calls[1].body, {
    p_room_code: CODE, p_next_state: state, p_expected_version: 7, p_request_id: ID,
  });
  await assert.rejects(store.commitState(CODE, state, 7, headers), error => error.code === 'UNVALIDATED_ACTOR');
});

test('move or opening-transition commit never tries to consume an old issued proof again', async () => {
  const headers = { ...PLAYER };
  const history = [{ fairDiceProof: { request: { id: OLD_ID } }, roll: '2:4' }];
  const { store, calls } = harness([response(room(history)), response({ ok: true })]);
  await store.getRoom(CODE, headers);
  await store.commitState(CODE, { history: [{ from: 18, to: 14, die: 4 }, ...history] }, 7, headers);
  assert.equal(calls[1].body.p_request_id, null);
});

test('a new proof may precede previously consumed proofs without confusing request IDs', async () => {
  const headers = { ...PLAYER };
  const old = { fairDiceProof: { request: { id: OLD_ID } } };
  const issued = { fairDiceProof: { request: { id: ID } } };
  const { store, calls } = harness([response(room([old])), response({ ok: true })]);
  await store.getRoom(CODE, headers);
  await store.commitState(CODE, { history: [issued, old] }, 7, headers);
  assert.equal(calls[1].body.p_request_id, ID);
});

test('rematch uses a separate server RPC and requires fresh player room access', async () => {
  const headers = { ...PLAYER };
  const initial = { history: [], phase: 'opening' };
  const { store, calls } = harness([response(room()), response({ ok: true, gameId: ID })]);
  await store.getRoom(CODE, headers);
  const result = await store.resetFairGame(CODE, initial, 7, headers);
  assert.equal(result.gameId, ID);
  assert.equal(calls[1].url.endsWith('/reset_fair_dice_game'), true);
  assert.deepEqual(calls[1].body, { p_room_code: CODE, p_initial_state: initial, p_expected_version: 7 });
  await assert.rejects(store.resetFairGame(CODE, initial, 7, headers), error => error.status === 403);
});

for (const [sqlCode, status] of [['40001', 409], ['23505', 409], ['42501', 403], ['P0002', 404], ['22023', 422], ['23514', 422], ['55000', 422]]) {
  test(`SQL ${sqlCode} translates to HTTP ${status} without echoing gateway secrets`, async () => {
    const { store } = harness([response({ code: sqlCode, message: `secret: ${SERVICE}` }, 400)]);
    await assert.rejects(store.getRoom(CODE, { ...PLAYER }), error => {
      assert.equal(error.status, status);
      assert.equal(error.code, sqlCode);
      assert.equal(error.message.includes(SERVICE), false);
      return true;
    });
  });
}

test('unavailable or malformed persistence fails closed with a redacted error', async () => {
  const { store } = harness([new Error(`private fetch URL/key ${SERVICE}`)]);
  await assert.rejects(store.getRoom(CODE, { ...PLAYER }), error => error.status === 502 && !error.message.includes(SERVICE));
  const malformed = harness([response({ roomCode: CODE, version: 7, actor: null })]);
  await assert.rejects(malformed.store.getRoom(CODE, { ...PLAYER }), /Invalid authoritative room/);
});

test('untrusted gateway codes and structured fetch errors cannot leak credentials', async () => {
  const first = harness([response({ code: SERVICE, message: SERVICE }, 502)]);
  await assert.rejects(first.store.getRoom(CODE, { ...PLAYER }), error => {
    assert.equal(error.code, 'FAIR_DICE_STORE_ERROR');
    assert.equal(error.message.includes(SERVICE), false);
    return true;
  });
  const fetchError = Object.assign(new Error(SERVICE), { code: SERVICE, status: 502 });
  const second = harness([fetchError]);
  await assert.rejects(second.store.getRoom(CODE, { ...PLAYER }), error => !error.message.includes(SERVICE) && !error.code.includes(SERVICE));
});

test('timeout aborts persistence requests and never falls back to a local/random roll', async () => {
  let signal;
  const store = new SupabaseFairDiceStore({
    url: 'https://backend.example', anonKey: ANON, serviceRoleKey: SERVICE, timeoutMs: 10,
    fetchImpl: (_url, init) => {
      signal = init.signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    },
  });
  await assert.rejects(store.getRoom(CODE, { ...PLAYER }), /timed out/);
  assert.equal(signal.aborted, true);
});

test('invalid room/request/intents never reach the persistence network', async () => {
  const { store, calls } = harness([]);
  await assert.rejects(store.getRoom('../../rooms', { ...PLAYER }), error => error.status === 400);
  await assert.rejects(store.getRequest('not-a-uuid'), error => error.status === 400);
  await assert.rejects(store.reserve(CODE, { label: 'roll', color: 'none', positionHash: 'evil' }, PLAYER), error => error.status === 400);
  await assert.rejects(store.getRoom(CODE, { authorization: 'secret\r\nInjected: value' }), error => error.status === 401);
  assert.equal(calls.length, 0);
});

test('backend configuration does not accept credentials, query strings or non-network URLs', () => {
  for (const url of ['file:///private/key', 'https://name:password@backend.example', 'https://backend.example?secret=1', 'https://backend.example#key']) {
    assert.throws(() => new SupabaseFairDiceStore({ url, anonKey: ANON, serviceRoleKey: SERVICE }), TypeError);
  }
});
