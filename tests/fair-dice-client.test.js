const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const FairDice = require('../fair-dice.js');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'rooms-client.js'), 'utf8');
const CODE = 'ABCD-EFGH';
const GAME_ID = '22222222-2222-4222-8222-222222222222';
const KEY = '11'.repeat(32);
const PUBLIC_KEY = FairDice.receiptPublicKey(KEY);
const REGISTERED_TOKEN = 'test.registered.jwt';
const ANON_KEY = 'test.anon.jwt';
const GUEST_PROOF = `gproof:${'31'.repeat(32)}`;
const GUEST_ID = `guest:sha256:${createHash('sha256').update(`nardu/guest/v1:${GUEST_PROOF}`).digest('hex')}`;
const plain = value => JSON.parse(JSON.stringify(value));

function proofFixture({ nonce = 1, variant = 'long', label = 'opening', color = 'none', gameId = GAME_ID } = {}) {
  const request = { id: `${String(nonce).padStart(8, '0')}-1111-4111-8111-111111111111`, roomCode: CODE,
    gameId, nonce, label, color, variant, round: 1000,
    createdAt: new Date(FairDice.roundTime(1000) - 6000).toISOString(), positionHash: 'a'.repeat(64) };
  // Official immutable quicknet /public/1000 vector; no network is used.
  const beacon = { round: 1000,
    signature: 'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39',
    randomness: 'fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd' };
  const receipt = FairDice.signReservation(request, KEY);
  const derived = FairDice.deriveDice(request, beacon.randomness);
  return { protocol: FairDice.PROTOCOL, ...receipt, chainHash: FairDice.CHAIN.hash, beacon,
    dice: derived.dice, sha256: derived.hash, sha256Input: derived.input, rerolls: derived.rerolls };
}

function receiptOf(proof) {
  return { request: proof.request, requestHash: proof.requestHash, receiptSignature: proof.receiptSignature };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => plain(body) };
}

function loadRooms({ guest = false, variant = 'long', required = true, env = {},
  session = guest ? null : { access_token: REGISTERED_TOKEN }, sessionError = null,
  readImpl, fetchImpl, fairApi = FairDice } = {}) {
  const operations = [];
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  let storageCalls = 0;
  let entropyCalls = 0;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const state = { roomCode: CODE, variant, phase: 'opening', history: [] };
  const row = { id: 'room-1', variant, status: 'joined', game_state: state, game_version: 7,
    fair_dice_required: required, fair_dice_game_id: GAME_ID };
  const client = {
    auth: {
      async getSession() { operations.push({ kind: 'session' }); return { data: { session }, error: sessionError }; },
      async signOut() { operations.push({ kind: 'signOut' }); return { error: null }; },
    },
    from(table) {
      assert.equal(table, 'rooms');
      const operation = { kind: 'read', table, filters: [] };
      operations.push(operation);
      const query = {
        select(columns) { operation.columns = columns; return query; },
        eq(column, value) { operation.filters.push(['eq', column, value]); return query; },
        neq(column, value) { operation.filters.push(['neq', column, value]); return query; },
        abortSignal(signal) { operation.signal = signal; return query; },
        update(payload) { operation.kind = 'update'; operation.payload = payload; throw new Error('unexpected raw Supabase mutation'); },
        delete() { operation.kind = 'delete'; throw new Error('unexpected raw Supabase deletion'); },
        async maybeSingle() {
          return readImpl ? readImpl(operation, operations.filter(item => item.kind === 'read').length)
            : { data: row, error: null };
        },
      };
      return query;
    },
    rpc(name, args) { operations.push({ kind: 'rpc', name, args }); throw new Error('unexpected legacy RPC'); },
  };
  const forbiddenStorage = new Proxy({}, { get() { storageCalls += 1; throw new Error('fair dice must not depend on browser storage'); } });
  const math = Object.create(Math);
  math.random = () => { entropyCalls += 1; throw new Error('fair dice must never select local random results'); };
  const context = {
    window: {
      NARDU_ENV: { supabaseAnonKey: ANON_KEY, fairDiceUrl: 'https://dice.example.test/fair-dice/v1', fairDicePublicKey: PUBLIC_KEY, ...env },
      NarduSupabase: { configured: () => true, client: async () => client },
      NarduFairDice: fairApi,
      NarduApp: {
        getUser: () => guest ? { guest: true, id: GUEST_ID, name: 'Гость1234' } : { guest: false, id: 'registered-player', name: 'Игрок' },
        guestRequestHeaders: () => guest ? { 'X-Guest-Id': GUEST_ID, 'X-Guest-Proof': GUEST_PROOF } : {},
      },
      crypto: { getRandomValues() { entropyCalls += 1; throw new Error('protected rolls must not consume browser entropy'); } },
      localStorage: forbiddenStorage,
      sessionStorage: forbiddenStorage,
      setTimeout(fn, ms) {
        const id = ++timerId;
        timers.set(id, { fn, ms });
        if (ms === 750) Promise.resolve().then(() => { if (timers.delete(id)) fn(); });
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
    },
    URL, AbortController, Error, Map, Set, TextEncoder, Uint8Array, Promise, Math: math,
    localStorage: forbiddenStorage,
    sessionStorage: forbiddenStorage,
    fetch: async (url, options = {}) => {
      const request = { url, options, body: options.body ? JSON.parse(options.body) : null };
      requests.push(request);
      markStarted(request);
      if (!fetchImpl) throw new Error('unexpected API request');
      return fetchImpl(request, requests.length);
    },
  };
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'rooms-client.js' });
  return {
    rooms: context.window.NarduRooms, requests, operations, state, row, timers, started,
    fireTimers() {
      const pending = [...timers];
      for (const [id, timer] of pending) if (timers.delete(id)) timer.fn();
    },
    assertProtected() {
      assert.equal(operations.some(item => ['update', 'delete', 'rpc'].includes(item.kind)), false);
      assert.equal(entropyCalls, 0);
      assert.equal(storageCalls, 0);
      assert.ok(requests.every(item => item.url.startsWith('https://dice.example.test/fair-dice/v1/')));
    },
  };
}

test('protected room policy is read independently of the service URL and receipt key instead of becoming legacy', async () => {
  for (const env of [{ fairDiceUrl: '' }, { fairDicePublicKey: '' }, { fairDicePublicKey: 'not-a-key' }, { fairDiceUrl: '', fairDicePublicKey: '' }]) {
    const client = loadRooms({ env });
    assert.equal(client.rooms.fairDiceConfigured(), false);
    assert.deepEqual(plain(await client.rooms.fairDicePolicy('abcd efgh')), { required: true, gameId: GAME_ID });
    assert.match(client.operations[0].columns, /fair_dice_required,fair_dice_game_id/);
    assert.equal(client.requests.length, 0);
    client.assertProtected();
  }
});

test('dice policy and reservation refresh only bounded metadata; recovery still returns the complete archive', async () => {
  const proof = proofFixture();
  const client = loadRooms({ fetchImpl: request => request.url.endsWith('/reserve')
    ? response({ receipt: receiptOf(proof) }, 202) : response({ proof }) });
  client.state.history = Array.from({ length: 1200 }, (_, index) => ({ index, retainedEvidence: 'x'.repeat(300) }));
  await client.rooms.fairDicePolicy(CODE);
  await client.rooms.fairDicePolicy(CODE);
  assert.equal(client.operations.filter(item => item.kind === 'read').length, 1, 'known policy is reused');
  await client.rooms.requestFairDice(CODE, { label: 'opening', color: 'none' });
  const metadataReads = client.operations.filter(item => item.kind === 'read');
  assert.equal(metadataReads.length, 2, 'reservation independently refreshes its epoch');
  for (const read of metadataReads) {
    assert.equal(read.columns.includes('game_state'), false);
    assert.match(read.columns, /^id,variant,game_version,status,fair_dice_required,fair_dice_game_id/);
    assert.ok(read.filters.some(filter => filter[1] === 'code' && filter[2] === CODE));
    assert.ok(read.filters.some(filter => filter[1] === 'status' && filter[2] === 'closed'));
  }
  const recovered = await client.rooms.getGameState(CODE);
  assert.equal(recovered.state.history.length, 1200);
  assert.equal(recovered.state.history[1199].retainedEvidence, 'x'.repeat(300));
  assert.match(client.operations.filter(item => item.kind === 'read').at(-1).columns, /^id,game_state,/);
  client.assertProtected();
});

test('metadata variant cannot be missing or taken from a stale archived state before reservation', async () => {
  for (const variant of [undefined, null, 'unknown']) {
    const client = loadRooms({ readImpl: () => ({ data: { id: 'room-1', variant,
      game_state: { variant: 'long' }, game_version: 7, fair_dice_required: true, fair_dice_game_id: GAME_ID }, error: null }) });
    await assert.rejects(client.rooms.requestFairDice(CODE, { label: 'opening', color: 'none' }), error => error.status === 422);
    assert.equal(client.requests.length, 0);
    client.assertProtected();
  }
});

test('missing protected configuration rejects state, roll, presence, leave and bot close without raw writes or local fallback', async () => {
  for (const method of ['state', 'roll', 'presence', 'leave', 'botClose']) {
    const client = loadRooms({ env: { fairDiceUrl: '', fairDicePublicKey: '' } });
    const work = method === 'state' ? client.rooms.putGameState(CODE, client.state, 7)
      : method === 'roll' ? client.rooms.requestFairDice(CODE, { label: 'opening', color: 'none' })
        : method === 'presence' ? client.rooms.updatePresence(CODE, { color: 'white' })
          : method === 'leave' ? client.rooms.leaveRoom(CODE) : client.rooms.closeBotRoom(CODE);
    await assert.rejects(work, error => error.status === 503);
    assert.equal(client.requests.length, 0);
    client.assertProtected();
  }
});

for (const code of ['42703', 'PGRST204']) {
  test(`only explicit missing v36 columns (${code}) permit a compatibility policy read`, async () => {
    const client = loadRooms({ readImpl: (operation, index) => index === 1
      ? { data: null, error: { code, message: 'column fair_dice_required does not exist' } }
      : { data: { id: 'room-1', game_version: 7, game_state: { variant: 'long' } }, error: null } });
    assert.equal((await client.rooms.fairDicePolicy(CODE)).required, false);
    const reads = client.operations.filter(item => item.kind === 'read');
    assert.equal(reads.length, 2);
    assert.equal(reads[1].columns, 'id,variant,game_version,status');
    client.assertProtected();
  });
}

test('network, authentication, unrelated-column and generic schema errors never trigger a compatibility read or raw state update', async () => {
  for (const error of [
    { code: 'PGRST301', status: 401, message: 'JWT expired; fair_dice_required' },
    { code: '42501', status: 403, message: 'permission denied fair_dice_required' },
    { code: '42703', message: 'column unrelated_column does not exist' },
    { code: 'PGRST204', message: 'another_column is absent from the cache' },
    { code: 'XX000', message: 'could not read fair_dice_required' },
  ]) {
    const client = loadRooms({ readImpl: () => ({ data: null, error }) });
    await assert.rejects(client.rooms.putGameState(CODE, client.state, 7), failure => failure.code === error.code);
    assert.equal(client.operations.filter(item => item.kind === 'read').length, 1);
    assert.equal(client.requests.length, 0);
    client.assertProtected();
  }
  const network = loadRooms({ readImpl: () => { throw new Error('network unavailable'); } });
  await assert.rejects(network.rooms.requestFairDice(CODE, { label: 'opening', color: 'none' }), /network unavailable/);
  assert.equal(network.operations.filter(item => item.kind === 'read').length, 1);
  network.assertProtected();
});

test('a failed Supabase session does not send anonymous requests or fall back to a legacy state write', async () => {
  const client = loadRooms({ sessionError: { status: 401, code: 'AUTH_FAILED', message: 'account session unavailable' } });
  await assert.rejects(client.rooms.putGameState(CODE, client.state, 7), error => error.status === 401 && error.code === 'AUTH_FAILED');
  assert.equal(client.requests.length, 0);
  client.assertProtected();
});

for (const variant of ['long', 'short']) {
  test(`the ${variant} protected client verifies actual BLS, the pinned receipt and the exact reserved result for players and guests`, async () => {
    for (const guest of [false, true]) {
      const proof = proofFixture({ variant });
      const original = JSON.stringify(proof);
      const client = loadRooms({ guest, variant, fetchImpl: request => request.url.endsWith('/reserve')
        ? response({ receipt: receiptOf(proof) }, 202) : response({ proof }) });
      assert.equal(client.rooms.fairDiceConfigured(), true);
      const result = await client.rooms.requestFairDice(CODE, { label: 'opening', color: 'none' });
      assert.deepEqual(plain(result), proof);
      assert.deepEqual(client.requests.map(item => item.body), [
        { code: CODE, label: 'opening', color: 'none' }, { code: CODE, requestId: proof.request.id },
      ]);
      for (const { options } of client.requests) {
        assert.equal(options.method, 'POST');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.headers.Authorization, `Bearer ${guest ? ANON_KEY : REGISTERED_TOKEN}`);
        assert.equal(options.headers['Content-Type'], 'application/json');
        if (guest) {
          assert.equal(options.headers['X-Guest-Id'], GUEST_ID);
          assert.equal(options.headers['X-Guest-Proof'], GUEST_PROOF);
        } else {
          assert.equal(Object.hasOwn(options.headers, 'X-Guest-Id'), false);
          assert.equal(Object.hasOwn(options.headers, 'X-Guest-Proof'), false);
        }
      }
      assert.equal(JSON.stringify(proof), original);
      assert.deepEqual(client.state.history, []);
      client.assertProtected();
    }
  });
}

test('a current guest never sends a lingering registered access token alongside guest ownership proof', async () => {
  const client = loadRooms({ guest: true, session: { access_token: REGISTERED_TOKEN }, fetchImpl: () => response({ ok: true, version: 8 }) });
  await client.rooms.putGameState(CODE, client.state, 7);
  assert.equal(client.requests[0].options.headers.Authorization, `Bearer ${ANON_KEY}`);
  assert.equal(client.requests[0].options.headers['X-Guest-Id'], GUEST_ID);
  assert.equal(client.requests[0].options.headers['X-Guest-Proof'], GUEST_PROOF);
  client.assertProtected();
});

test('a legitimately signed same-context result from another reservation cannot replace the receipt the client observed', async () => {
  const promised = proofFixture({ nonce: 1 });
  const substitute = proofFixture({ nonce: 2 });
  assert.equal((await FairDice.verifyProof(substitute, { publicKey: PUBLIC_KEY })).sourceVerified, true);
  const client = loadRooms({ fetchImpl: request => request.url.endsWith('/reserve')
    ? response({ receipt: receiptOf(promised) }, 202) : response({ proof: substitute }) });
  await assert.rejects(client.rooms.requestFairDice(CODE, { label: 'opening', color: 'none' }), error => error.status === 422
    && /не относится к зарезервированному броску/.test(error.message));
  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[1].body.requestId, promised.request.id);
  client.assertProtected();
});

test('changed receipt id, request hash or receipt signature fails before any positive signed result can be returned', async () => {
  const promised = proofFixture();
  for (const field of ['id', 'requestHash', 'receiptSignature']) {
    const corrupt = plain(promised);
    if (field === 'id') corrupt.request.id = '99999999-1111-4111-8111-111111111111';
    else corrupt[field] = field === 'requestHash' ? 'b'.repeat(64) : '00'.repeat(64);
    const client = loadRooms({ fetchImpl: request => request.url.endsWith('/reserve')
      ? response({ receipt: receiptOf(promised) }, 202) : response({ proof: corrupt }) });
    await assert.rejects(client.rooms.requestFairDice(CODE, { label: 'opening', color: 'none' }), error => error.status === 422);
    assert.equal(client.requests.length, 2);
    client.assertProtected();
  }
});

test('wrong epochs, server pins or missing verifier modules reject the receipt before polling a result', async () => {
  const proof = proofFixture();
  for (const options of [
    { env: { fairDicePublicKey: FairDice.receiptPublicKey('22'.repeat(32)) } },
    { readImpl: () => ({ data: { id: 'room-1', variant: 'long', game_version: 7, game_state: { variant: 'long' }, fair_dice_required: true,
      fair_dice_game_id: '99999999-1111-4111-8111-111111111111' }, error: null }) },
    { fairApi: null },
  ]) {
    const client = loadRooms({ ...options, fetchImpl: () => response({ receipt: receiptOf(proof) }, 202) });
    await assert.rejects(client.rooms.requestFairDice(CODE, { label: 'opening', color: 'none' }));
    assert.equal(client.requests.length, 1);
    assert.ok(client.requests[0].url.endsWith('/reserve'));
    client.assertProtected();
  }
});

test('source signature and derived-dice errors cannot return a roll or retry with another reservation', async () => {
  const proof = proofFixture({ nonce: 2, label: 'roll', color: 'dark' });
  for (const kind of ['source', 'dice']) {
    const corrupt = plain(proof);
    if (kind === 'source') {
      corrupt.beacon.signature = `a${corrupt.beacon.signature.slice(1)}`;
      corrupt.beacon.randomness = createHash('sha256').update(Buffer.from(corrupt.beacon.signature, 'hex')).digest('hex');
    } else corrupt.dice = [proof.dice[0] === 6 ? 1 : proof.dice[0] + 1, proof.dice[1]];
    const client = loadRooms({ fetchImpl: request => request.url.endsWith('/reserve')
      ? response({ receipt: receiptOf(proof) }, 202) : response({ proof: corrupt }) });
    await assert.rejects(client.rooms.requestFairDice(CODE, { label: 'roll', color: 'dark' }), error => error.code ===
      (kind === 'source' ? 'FAIR_BEACON_SIGNATURE_INVALID' : 'FAIR_DICE_MISMATCH'));
    assert.deepEqual(client.requests.map(item => item.url.split('/').at(-1)), ['reserve', 'result']);
    client.assertProtected();
  }
});

test('all pending polls address one immutable request and an unavailable service never allocates another roll', async () => {
  const proof = proofFixture();
  const client = loadRooms({ fetchImpl: (request, index) => request.url.endsWith('/reserve')
    ? response({ receipt: receiptOf(proof) }, 202) : index === 2 ? response({ status: 'pending' }, 202) : response({ proof }) });
  assert.deepEqual(plain(await client.rooms.requestFairDice(CODE, { label: 'opening', color: 'none' })), proof);
  assert.deepEqual(client.requests.map(item => item.url.split('/').at(-1)), ['reserve', 'result', 'result']);
  assert.ok(client.requests.slice(1).every(item => item.body.requestId === proof.request.id));
  client.assertProtected();
  const unavailable = loadRooms({ fetchImpl: () => response({ code: 'BEACON_WAIT' }, 503) });
  await assert.rejects(unavailable.rooms.requestFairDice(CODE, { label: 'opening', color: 'none' }), error => error.status === 503 && error.code === 'BEACON_WAIT');
  assert.equal(unavailable.requests.length, 1);
  unavailable.assertProtected();
});

test('protected state, presence, player leave and bot close use authorized service endpoints and bot close reports completion', async () => {
  for (const guest of [false, true]) {
    const client = loadRooms({ guest, fetchImpl: request => response({ ok: true, version: 8, state: request.body.state || null, removed: true }) });
    await client.rooms.putGameState(CODE, client.state, 7);
    await client.rooms.updatePresence(CODE, { color: 'dark', forgedPresence: true });
    await client.rooms.leaveRoom(CODE, { color: 'dark', forgedWinner: 'white' });
    const closed = await client.rooms.closeBotRoom(CODE);
    assert.deepEqual(client.requests.map(item => item.url.split('/').at(-1)), ['state', 'presence', 'leave', 'leave']);
    assert.deepEqual(client.requests.map(item => item.body), [
      { code: CODE, state: client.state, version: 7 }, { code: CODE }, { code: CODE }, { code: CODE },
    ]);
    assert.equal(closed.closed, true);
    assert.equal(closed.removed, true);
    assert.equal(closed.code, CODE);
    assert.ok(client.requests.every(item => item.options.headers.Authorization === `Bearer ${guest ? ANON_KEY : REGISTERED_TOKEN}`));
    client.assertProtected();
  }
});

test('insecure, credential-bearing, query and fragment service URLs never receive player credentials', async () => {
  for (const fairDiceUrl of ['http://dice.example.test/fair-dice/v1', 'https://user:pass@dice.example.test/fair-dice/v1',
    'https://dice.example.test/fair-dice/v1?token=bad', 'https://dice.example.test/fair-dice/v1#bad']) {
    const client = loadRooms({ env: { fairDiceUrl } });
    await assert.rejects(client.rooms.putGameState(CODE, client.state, 7), error => error.status === 503);
    assert.equal(client.requests.length, 0);
    client.assertProtected();
  }
});

test('pre-aborted protected presence and bot closing never start a read, request or mutation', async () => {
  const client = loadRooms();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.rooms.updatePresence(CODE, {}, { signal: controller.signal }), error => error.name === 'AbortError');
  await assert.rejects(client.rooms.closeBotRoom(CODE, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(client.operations.length, 0);
  assert.equal(client.requests.length, 0);
  client.assertProtected();
});

test('the protected client bounds a stalled HTTP request and returns a retryable timeout without a legacy write', async () => {
  const client = loadRooms({ fetchImpl: ({ options }) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  const work = client.rooms.putGameState(CODE, client.state, 7);
  const request = await client.started;
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(client.timers.size, 1);
  assert.equal([...client.timers.values()][0].ms, 12000);
  client.fireTimers();
  await assert.rejects(work, error => error.status === 503 && /не ответил вовремя/.test(error.message));
  assert.equal(request.options.signal.aborted, true);
  assert.equal(client.requests.length, 1);
  assert.equal(client.timers.size, 0);
  client.assertProtected();
});

test('a stalled success-response JSON body is also a timeout, never an empty successful state reply', async () => {
  let markBodyStarted;
  const bodyStarted = new Promise(resolve => { markBodyStarted = resolve; });
  const client = loadRooms({ fetchImpl: ({ options }) => ({ ok: true, status: 200,
    json: () => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      markBodyStarted();
    }),
  }) });
  const work = client.rooms.putGameState(CODE, client.state, 7);
  await bodyStarted;
  client.fireTimers();
  await assert.rejects(work, error => error.status === 503);
  assert.equal(client.requests.length, 1);
  assert.equal(client.timers.size, 0);
  client.assertProtected();
});

test('caller cancellation aborts a protected request without converting it into a timeout or using a legacy route', async () => {
  const caller = new AbortController();
  const client = loadRooms({ fetchImpl: ({ options }) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  const work = client.rooms.updatePresence(CODE, {}, { signal: caller.signal });
  const request = await client.started;
  assert.notEqual(request.options.signal, caller.signal);
  caller.abort();
  await assert.rejects(work, error => error.name === 'AbortError' && error.status !== 503);
  assert.equal(request.options.signal.aborted, true);
  assert.equal(client.timers.size, 0);
  client.assertProtected();
});

test('a service transport error never becomes a successful reply or direct database fallback', async () => {
  const client = loadRooms({ fetchImpl: () => { throw new Error('transport unavailable'); } });
  await assert.rejects(client.rooms.putGameState(CODE, client.state, 7), /transport unavailable/);
  assert.equal(client.requests.length, 1);
  assert.equal(client.timers.size, 0);
  client.assertProtected();
});
