'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const FairDice = require('../fair-dice.js');
const SOURCE = fs.readFileSync(path.resolve(__dirname, '../rooms-client.js'), 'utf8');
const CODE = 'ABCD-EFGH';
const GAME_ID = '22222222-2222-4222-8222-222222222222';
const KEY = '11'.repeat(32), SEED = '31'.repeat(32), CLIENT_SEED = '42'.repeat(32);
const PUBLIC_KEY = FairDice.receiptPublicKey(KEY);
const plain = value => JSON.parse(JSON.stringify(value));

function receiptFixture({ nonce = 1, variant = 'long', label = 'roll', color = 'white' } = {}) {
  const request = { id: `${String(nonce).padStart(8, '0')}-1111-4111-8111-111111111111`, roomCode: CODE,
    gameId: GAME_ID, nonce, label, color, variant, commitment: '00'.repeat(32),
    createdAt: '2026-09-18T00:00:00.000Z', positionHash: 'ab'.repeat(32) };
  request.commitment = FairDice.systemCommitment(request, SEED);
  return FairDice.signReservation(request, KEY);
}

function load({ variant = 'long', guest = false, storage = new Map(), storageError = false,
  cryptoMissing = false, acceptedSeed = null, receipt = receiptFixture({ variant }),
  mutateProof, challengeError, readImpl, protocol = 'system-csprng-v1' } = {}) {
  const operations = [], requests = [], entropy = [], order = [];
  const state = { variant, roomCode: CODE, phase: receipt.request.label === 'opening' ? 'opening' : 'roll', history: [] };
  const row = { id: 'room-1', status: 'joined', game_state: state, game_version: 7,
    fair_dice_required: true, fair_dice_game_id: GAME_ID, fair_dice_protocol: protocol };
  const proof = async seed => {
    const value = await FairDice.createSystemProof(receipt, SEED, seed);
    return mutateProof ? mutateProof(value) : value;
  };
  const client = {
    auth: { async getSession() { return { data: { session: guest ? null : { access_token: 'registered.test.jwt' } }, error: null }; } },
    from(table) {
      assert.equal(table, 'rooms');
      const operation = { kind: 'read' }; operations.push(operation);
      const query = { select(columns) { operation.columns = columns; return query; }, eq() { return query; }, neq() { return query; },
        async maybeSingle() { return readImpl ? readImpl(operation, operations.length) : { data: plain(row), error: null }; },
        update() { throw new Error('raw mutation forbidden'); }, delete() { throw new Error('raw deletion forbidden'); } };
      return query;
    },
    rpc() { throw new Error('legacy RPC forbidden'); },
  };
  const timers = new Map(); let timerId = 0;
  const window = {
    NARDU_ENV: { supabaseAnonKey: 'anon.test.jwt', fairDiceUrl: 'https://dice.example.test/fair-dice/v1', fairDicePublicKey: PUBLIC_KEY },
    NarduSupabase: { configured: () => true, client: async () => client }, NarduFairDice: FairDice,
    NarduApp: { getUser: () => ({ guest, id: 'player' }), guestRequestHeaders: () => guest
      ? { 'X-Guest-Id': 'guest-fixture', 'X-Guest-Proof': 'proof-fixture' } : {} },
    localStorage: { getItem(key) { order.push('storage-read'); if (storageError) throw new Error('storage disabled'); return storage.get(key) || null; },
      setItem(key, value) { order.push('storage-write'); if (storageError) throw new Error('storage disabled'); storage.set(key, value); } },
    crypto: cryptoMissing ? undefined : { getRandomValues(bytes) { order.push('entropy'); entropy.push(bytes.length); bytes.fill(0x42); return bytes; } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
  };
  const math = Object.create(Math); math.random = () => { throw new Error('Math.random forbidden'); };
  const context = { window, URL, AbortController, Error, Map, Set, TextEncoder, Uint8Array, Promise, Math: math,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body), route = url.split('/').at(-1); requests.push({ route, body, options }); order.push(route);
      let result, status = 200;
      if (route === 'reserve') result = { status: 'pending', receipt: plain(receipt), clientSeed: acceptedSeed };
      else if (route === 'challenge') {
        if (challengeError) { result = { code: 'FAIR_DICE_UNAVAILABLE' }; status = 503; }
        else result = { status: 'ready', proof: await proof(body.clientSeed) };
      } else throw new Error('unexpected route ' + route);
      return { ok: status === 200, status, json: async () => plain(result) };
    } };
  vm.createContext(context); vm.runInContext(SOURCE, context, { filename: 'rooms-client.js' });
  return { rooms: window.NarduRooms, window, requests, entropy, order, storage, receipt, operations, row };
}

for (const variant of ['long', 'short']) for (const guest of [false, true]) {
  test(`system ${variant} ${guest ? 'guest' : 'registered'} receives receipt before fresh CSPRNG challenge and persists before send`, async () => {
    const client = load({ variant, guest });
    const proof = await client.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' });
    assert.equal(proof.protocol, 'system-csprng-v1');
    assert.equal(proof.commitReveal.clientSeed, CLIENT_SEED);
    assert.deepEqual(client.entropy, [32]);
    assert.ok(client.order.indexOf('reserve') < client.order.indexOf('entropy'));
    assert.ok(client.order.indexOf('storage-write') < client.order.indexOf('challenge'));
    assert.deepEqual(client.requests.map(item => item.route), ['reserve', 'challenge']);
    assert.equal(client.requests[1].body.requestHash, client.receipt.requestHash);
    assert.equal(client.requests[1].options.headers.Authorization, `Bearer ${guest ? 'anon.test.jwt' : 'registered.test.jwt'}`);
    const saved = JSON.parse([...client.storage.values()][0]);
    assert.equal(saved.commitment, client.receipt.request.commitment);
    assert.equal(saved.clientSeed, CLIENT_SEED);
    assert.equal(Object.hasOwn(saved, 'serverSeed'), false);
    assert.equal((await FairDice.verifyProof(proof, { publicKey: PUBLIC_KEY, context: client.receipt.request, clientSeed: CLIENT_SEED })).commitmentVerified, true);
  });
}

test('same browser retry after uncertain challenge and reload uses the identical stored challenge', async () => {
  const storage = new Map();
  const failed = load({ storage, challengeError: true });
  await assert.rejects(failed.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' }));
  assert.deepEqual(failed.entropy, [32]);
  const resumed = load({ storage });
  const proof = await resumed.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' });
  assert.deepEqual(resumed.entropy, []);
  assert.equal(proof.commitReveal.clientSeed, failed.requests[1].body.clientSeed);
});

test('reconnect to another tab accepted challenge recovers it without generating new entropy or claiming ownership', async () => {
  const seed = '56'.repeat(32);
  const client = load({ acceptedSeed: seed });
  const proof = await client.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' });
  assert.equal(proof.commitReveal.clientSeed, seed);
  assert.deepEqual(client.entropy, []);
  assert.equal(JSON.parse([...client.storage.values()][0]).ownContribution, false);
  const resumed = load({ acceptedSeed: seed, storage: client.storage });
  await resumed.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' });
  assert.equal(JSON.parse([...client.storage.values()][0]).ownContribution, false);
});

test('retry cannot replace an independently stored challenge with another accepted seed', async () => {
  const storage = new Map();
  const failed = load({ storage, challengeError: true });
  await assert.rejects(failed.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' }));
  const before = [...storage.entries()];
  const resumed = load({ storage, acceptedSeed: '56'.repeat(32) });
  await assert.rejects(resumed.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' }), /не совпадает/);
  assert.deepEqual([...storage.entries()], before);
  assert.deepEqual(resumed.entropy, []);
  assert.deepEqual(resumed.requests.map(item => item.route), ['reserve']);
});

test('wrong epoch or invalid receipt fails before browser entropy, storage or challenge', async () => {
  for (const mutate of [receipt => { receipt.receiptSignature = '00'.repeat(64); },
    receipt => { receipt.request.gameId = '33333333-3333-4333-8333-333333333333'; }]) {
    const receipt = receiptFixture(); mutate(receipt);
    const client = load({ receipt });
    await assert.rejects(client.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' }));
    assert.deepEqual(client.entropy, []); assert.equal(client.storage.size, 0);
    assert.deepEqual(client.requests.map(item => item.route), ['reserve']);
  }
});

test('absence of browser CSPRNG or storage fails closed without server fallback', async () => {
  for (const options of [{ cryptoMissing: true }, { storageError: true }]) {
    const client = load(options);
    await assert.rejects(client.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' }));
    assert.deepEqual(client.requests.map(item => item.route), ['reserve']); assert.deepEqual(client.entropy, []);
  }
});

test('a stored reservation cannot be replaced, and stored input is bounded before parsing', async () => {
  const receipt = receiptFixture();
  for (const saved of [JSON.stringify({ requestId: receipt.request.id, requestHash: '00'.repeat(32),
    commitment: receipt.request.commitment, clientSeed: CLIENT_SEED }), 'x'.repeat(5000)]) {
    const client = load({ receipt, storage: new Map([['narduh-system-dice-current:' + CODE, saved]]) });
    await assert.rejects(client.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' }));
    assert.deepEqual(client.entropy, []); assert.equal(client.requests.length, 1);
  }
});

test('proof client contribution, context, signature, protocol and dice cannot be replaced', async () => {
  for (const mutateProof of [proof => { proof.commitReveal.clientSeed = '57'.repeat(32); return proof; },
    proof => { proof.dice[0] = proof.dice[0] % 6 + 1; return proof; },
    proof => { proof.protocol = 'drand-quicknet-v1'; return proof; },
    proof => { proof.request.id = '33333333-3333-4333-8333-333333333333'; return proof; },
    proof => { proof.receiptSignature = '00'.repeat(64); return proof; }]) {
    const client = load({ mutateProof });
    await assert.rejects(client.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' }));
    assert.deepEqual(client.requests.map(item => item.route), ['reserve', 'challenge']);
  }
});

test('invalid accepted seeds, unknown room protocols and downgraded system reservations never poll legacy', async () => {
  for (const options of [{ acceptedSeed: 'invalid' }, { protocol: 'unknown-v1' },
    { protocol: 'drand-quicknet-v1' }]) {
    const client = load(options);
    await assert.rejects(client.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' }));
    assert.equal(client.requests.some(item => item.route === 'result'), false);
    assert.deepEqual(client.entropy, []);
  }
});

test('missing v37 protocol column preserves protected v36 policy, not legacy RNG', async () => {
  const client = load({ readImpl: (operation, index) => index === 1
    ? { data: null, error: { code: '42703', message: 'column fair_dice_protocol does not exist' } }
    : { data: { id: 'room-1', status: 'joined', game_version: 7, game_state: { variant: 'long' },
      fair_dice_required: true, fair_dice_game_id: GAME_ID }, error: null } });
  assert.deepEqual(plain(await client.rooms.fairDicePolicy(CODE)), { required: true, gameId: GAME_ID });
  assert.equal(client.operations.length, 2);
  assert.match(client.operations[1].columns, /fair_dice_required,fair_dice_game_id$/);
});

test('new nonce replaces only current protocol witness after receiving a new immutable receipt', async () => {
  const storage = new Map();
  const first = load({ storage });
  await first.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' });
  const second = load({ storage, receipt: receiptFixture({ nonce: 2 }) });
  const proof = await second.rooms.requestFairDice(CODE, { label: 'roll', color: 'white' });
  assert.equal(proof.request.nonce, 2); assert.deepEqual(second.entropy, [32]);
  assert.equal(storage.size, 1);
});
