'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const FairDice = require('../fair-dice.js');
const { rules, validateTransition } = require('../lib/fair-dice-rules.js');
const { createFairDiceService } = require('../lib/fair-dice-service.js');
const { commitmentFor } = require('../experiments/system-dice/protocol.js');

const CODE = 'SAFE-RQME';
const GAME = 'eb9acac4-7621-4106-976f-08dd288b6585';
const REQUEST = 'ca2a6463-c2ba-4a9b-a0f0-000000000001';
const KEY = '01'.repeat(32);
const SEED = 'ab'.repeat(32);
const CLIENT = 'cd'.repeat(32);
const clone = value => JSON.parse(JSON.stringify(value));
const fault = (code = '42501', status = 403) => Object.assign(new Error('private credentials'), { code, status });

class MemoryStore {
  constructor() {
    this.state = Object.assign(clone(rules.initialState('long')), {
      mode: 'remote', roomCode: CODE, startedAt: 1789689600000,
      fairDice: { protocol: FairDice.SYSTEM_PROTOCOL, required: true, gameId: GAME },
    });
    this.version = 0;
    this.record = null;
    this.validated = new WeakSet();
    this.allocations = 0;
    this.accepts = 0;
    this.proofCommits = 0;
    this.bot = false;
    this.status = 'joined';
    this.protocol = FairDice.SYSTEM_PROTOCOL;
  }
  hash() { return createHash('sha256').update(JSON.stringify(this.state)).digest('hex'); }
  async getRoom(code, headers) {
    if (code !== CODE || headers.authorization === 'Bearer stranger.test') throw fault();
    if (!headers.authorization && headers['x-guest-proof'] !== 'guest-proof-valid') throw fault();
    this.validated.add(headers);
    const dark = headers.authorization === 'Bearer dark.test';
    return { roomCode: CODE, gameId: GAME, variant: 'long', version: this.version,
      fairDiceRequired: true, fairDiceProtocol: this.protocol, serverPositionHash: this.hash(),
      status: this.status, state: clone(this.state), serverNowMs: Date.now(),
      actor: { actorColor: dark ? 'dark' : 'white', ownsHost: !dark, bot: this.bot },
      pending: this.record && !this.record.cancelled && !this.record.consumed
        ? { request: clone(this.record.request), proof: clone(this.record.proof), clientSeed: this.record.clientSeed } : null };
  }
  async reserve(code, intent, headers) {
    assert.equal(this.validated.has(headers), true);
    if (this.record) return clone(this.record.request);
    this.allocations += 1;
    const context = { gameId: GAME, nonce: 1, roomCode: code, variant: 'long', label: intent.label,
      color: intent.color, positionHash: intent.positionHash };
    const request = { id: REQUEST, roomCode: code, gameId: GAME, nonce: 1,
      label: intent.label, color: intent.color, variant: 'long', commitment: commitmentFor(context, SEED),
      createdAt: '2026-09-18T00:00:00.000Z', positionHash: intent.positionHash };
    this.record = { request, protocol: FairDice.SYSTEM_PROTOCOL, privateSeed: SEED,
      clientSeed: null, proof: null, cancelled: false, consumed: false };
    return clone(request);
  }
  async getRequest(id) { if (id !== this.record?.request.id) throw fault('P0002', 404); return clone(this.record); }
  async acceptClientSeed(id, seed, headers) {
    assert.equal(this.validated.has(headers), true);
    assert.equal(id, this.record.request.id);
    this.accepts += 1;
    if (!this.record.clientSeed) this.record.clientSeed = seed;
    return clone(this.record);
  }
  async commitProof(id, proof) {
    assert.equal(id, this.record.request.id);
    assert.equal(this.record.clientSeed, proof.commitReveal.clientSeed, 'seed must be durable before reveal');
    if (!this.record.proof) { this.record.proof = clone(proof); this.proofCommits += 1; }
    else assert.deepEqual(this.record.proof, proof);
    return clone(this.record.proof);
  }
  async listPending() { return this.record ? [clone(this.record)] : []; }
  async commitState(code, state, version, headers) {
    assert.equal(this.validated.has(headers), true);
    assert.equal(version, this.version);
    this.record.consumed = true;
    this.state = clone(state);
    this.version += 1;
    return { ok: true, state: clone(state), version: this.version, gameId: GAME };
  }
  async resetFairGame() { throw new Error('not used'); }
}

function harness(t, store = new MemoryStore()) {
  let sourceCalls = 0;
  const service = createFairDiceService({ store, signingKey: KEY,
    fetchImpl: async () => { sourceCalls += 1; throw new Error('unexpected beacon'); } });
  async function request(route, body, auth = 'white', method = 'POST') {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.url = '/fair-dice/v1' + route;
    req.method = method;
    req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = { 'content-type': 'application/json', ...(auth === 'guest'
      ? { 'x-guest-id': 'guest-id-valid', 'x-guest-proof': 'guest-proof-valid' }
      : { authorization: 'Bearer ' + auth + '.test' }) };
    const headers = {};
    const response = { statusCode: 0, writableEnded: false, destroyed: false,
      setHeader(name, value) { headers[name] = value; },
      end(text) { this.body = text ? JSON.parse(text) : null; this.writableEnded = true; } };
    await service.handler(req, response);
    return { status: response.statusCode, data: response.body, headers };
  }
  t.after(() => service.close());
  return { service, store, request, get sourceCalls() { return sourceCalls; } };
}

async function reserve(h, label = 'opening', color = 'none') {
  const result = await h.request('/reserve', { code: CODE, label, color });
  assert.equal(result.status, 202, JSON.stringify(result.data));
  return result.data.receipt;
}
function challenge(receipt, clientSeed = CLIENT) {
  return { code: CODE, requestId: receipt.request.id, requestHash: receipt.requestHash, clientSeed };
}

test('system reservation signs commitment before a client challenge and never exposes the server seed', async t => {
  const h = harness(t);
  const receipt = await reserve(h);
  assert.equal(FairDice.verifyReservation(receipt, h.service.publicKey), true);
  assert.equal(JSON.stringify(receipt).includes(SEED), false);
  assert.equal(h.sourceCalls, 0);
  assert.equal(h.service.pendingJobs, 0);
  assert.equal(h.store.proofCommits, 0);
  const pending = await h.request('/result', { code: CODE, requestId: REQUEST });
  assert.equal(pending.status, 202);
  assert.equal(JSON.stringify(pending).includes(SEED), false);
  assert.equal(await h.service.resumePending(), 0);
});

test('health keeps the legacy protocol and advertises both supported verifiers without private material', async t => {
  const h = harness(t);
  const result = await h.request('/health', {}, 'white', 'GET');
  assert.equal(result.status, 200);
  assert.equal(result.data.protocol, FairDice.PROTOCOL);
  assert.deepEqual(result.data.supportedProtocols, [FairDice.PROTOCOL, FairDice.SYSTEM_PROTOCOL]);
  assert.equal(result.data.publicKey, h.service.publicKey);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('reserve exposes only the accepted first client seed for reconnect, never its private server contribution', async t => {
  const h = harness(t);
  const receipt = await reserve(h);
  await h.request('/challenge', challenge(receipt));
  const result = await h.request('/reserve', { code: CODE, label: 'opening', color: 'none' });
  assert.equal(result.data.clientSeed, CLIENT);
  assert.equal(JSON.stringify(result).includes(SEED), false);
  assert.equal(h.store.allocations, 1);
});

test('authenticated challenge returns a verified fixed-seed proof without external source calls', async t => {
  const h = harness(t);
  const receipt = await reserve(h);
  const result = await h.request('/challenge', challenge(receipt));
  assert.equal(result.status, 200);
  const verified = await FairDice.verifyProof(result.data.proof, { publicKey: h.service.publicKey, context: receipt.request });
  assert.equal(verified.protocol, FairDice.SYSTEM_PROTOCOL);
  assert.equal(result.data.proof.commitReveal.clientSeed, CLIENT);
  assert.equal(result.data.proof.commitReveal.serverSeed, SEED);
  assert.notEqual(result.data.proof.dice[0], result.data.proof.dice[1]);
  assert.equal(h.store.allocations, 1);
  assert.equal(h.store.proofCommits, 1);
  assert.equal(h.sourceCalls, 0);
});

test('parallel identical challenges share one proof and repeated challenge does not reroll', async t => {
  const h = harness(t);
  const receipt = await reserve(h);
  const results = await Promise.all(Array.from({ length: 12 }, () => h.request('/challenge', challenge(receipt))));
  assert.equal(results.every(result => result.status === 200), true);
  for (const result of results) assert.deepEqual(result.data.proof, results[0].data.proof);
  assert.equal(h.store.proofCommits, 1);
  assert.equal(h.store.allocations, 1);
  assert.deepEqual((await h.request('/challenge', challenge(receipt))).data.proof, results[0].data.proof);
});

test('first accepted client seed is immutable and a different seed cannot obtain alternate dice', async t => {
  const h = harness(t);
  const receipt = await reserve(h);
  const first = await h.request('/challenge', challenge(receipt));
  const changed = await h.request('/challenge', challenge(receipt, 'ef'.repeat(32)));
  assert.equal(changed.status, 409);
  assert.equal(changed.data.code, 'FAIR_CLIENT_SEED_MISMATCH');
  assert.equal(h.store.record.clientSeed, CLIENT);
  assert.deepEqual(h.store.record.proof, first.data.proof);
  assert.equal(h.store.proofCommits, 1);
});

test('competing different client seeds can produce only one accepted result', async t => {
  const h = harness(t);
  const receipt = await reserve(h);
  const results = await Promise.all([h.request('/challenge', challenge(receipt)),
    h.request('/challenge', challenge(receipt, 'ef'.repeat(32)))]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  assert.equal(h.store.proofCommits, 1);
});

test('guest with valid paired proof may challenge the same authoritative room', async t => {
  const h = harness(t);
  const receipt = await reserve(h);
  assert.equal((await h.request('/challenge', challenge(receipt), 'guest')).status, 200);
});

test('opponent and stranger cannot choose the room owner opening challenge', async t => {
  const h = harness(t);
  const receipt = await reserve(h);
  assert.equal((await h.request('/challenge', challenge(receipt), 'dark')).status, 403);
  assert.equal((await h.request('/challenge', challenge(receipt), 'stranger')).status, 403);
  assert.equal(h.store.accepts, 0);
  assert.equal(h.store.record.clientSeed, null);
});

test('ordinary roll belongs to the physical current actor, including the bot owner capability', async t => {
  const store = new MemoryStore();
  store.state.phase = 'roll';
  store.state.turn = 'dark';
  const h = harness(t, store);
  const receipt = await reserve(h, 'roll', 'dark');
  assert.equal((await h.request('/challenge', challenge(receipt), 'white')).status, 403);
  store.bot = true;
  assert.equal((await h.request('/challenge', challenge(receipt), 'white')).status, 200);
  assert.equal(store.record.request.color, 'dark');
  assert.equal(store.allocations, 1);
});

test('ordinary doubles remain fixed and never trigger an opening tie reroll', async t => {
  const store = new MemoryStore();
  store.state.phase = 'roll';
  store.state.turn = 'white';
  const h = harness(t, store);
  const receipt = await reserve(h, 'roll', 'white');
  let seed;
  for (let index = 0; index < 100; index += 1) {
    const candidate = index.toString(16).padStart(64, '0');
    const proof = FairDice.createSystemProof(receipt, SEED, candidate);
    if (proof.dice[0] === proof.dice[1]) { seed = candidate; break; }
  }
  assert.ok(seed, 'deterministic test fixture must contain a double');
  const result = await h.request('/challenge', challenge(receipt, seed));
  assert.equal(result.status, 200);
  assert.equal(result.data.proof.rerolls, 0);
  assert.equal(result.data.proof.commitReveal.counter, 0);
  assert.equal(result.data.proof.dice[0], result.data.proof.dice[1]);
});

for (const [name, mutate] of [
  ['wrong receipt hash', body => { body.requestHash = '0'.repeat(64); }],
  ['surplus dice', body => { body.dice = [6, 6]; }],
  ['surplus server seed', body => { body.serverSeed = SEED; }],
  ['missing hash', body => { delete body.requestHash; }],
  ['short seed', body => { body.clientSeed = 'a'; }],
  ['uppercase seed', body => { body.clientSeed = CLIENT.toUpperCase(); }],
  ['nonhex seed', body => { body.clientSeed = 'z'.repeat(64); }],
  ['array seed', body => { body.clientSeed = [CLIENT]; }],
]) {
  test('challenge rejects ' + name + ' without storing entropy or revealing a result', async t => {
    const h = harness(t);
    const receipt = await reserve(h);
    const body = challenge(receipt);
    mutate(body);
    const result = await h.request('/challenge', body);
    assert.ok([400, 409].includes(result.status));
    assert.equal(h.store.accepts, 0);
    assert.equal(h.store.record.clientSeed, null);
    assert.equal(JSON.stringify(result).includes(SEED), false);
  });
}

for (const [name, mutate] of [
  ['cancelled', store => { store.record.cancelled = true; }],
  ['consumed', store => { store.record.consumed = true; }],
  ['closed room', store => { store.status = 'closed'; }],
  ['changed position', store => { store.state.startedAt += 1; }],
  ['wrong epoch', store => { store.record.request.gameId = 'ca2a6463-c2ba-4a9b-a0f0-000000000002'; }],
  ['wrong protocol', store => { store.record.protocol = 'unknown'; }],
]) {
  test('challenge rejects ' + name + ' reservation without accepting a seed', async t => {
    const h = harness(t);
    const receipt = await reserve(h);
    mutate(h.store);
    const result = await h.request('/challenge', challenge(receipt));
    assert.ok([403, 409, 422].includes(result.status));
    assert.equal(h.store.accepts, 0);
  });
}

test('restart resumes already accepted seed only and exposes the same ready proof', async t => {
  const store = new MemoryStore();
  const before = harness(t, store);
  const receipt = await reserve(before);
  store.record.clientSeed = CLIENT;
  await before.service.close();
  const after = harness(t, store);
  assert.equal(await after.service.resumePending(), 1);
  await after.service.waitForIdle();
  const result = await after.request('/result', { code: CODE, requestId: REQUEST });
  assert.equal(result.status, 200);
  assert.equal(result.data.proof.requestHash, receipt.requestHash);
  assert.equal(result.data.proof.commitReveal.clientSeed, CLIENT);
  assert.equal(store.allocations, 1);
  assert.equal(store.proofCommits, 1);
});

test('lost proof commit reply is recovered by reading the same persisted proof', async t => {
  const h = harness(t);
  const receipt = await reserve(h);
  const original = h.store.commitProof.bind(h.store);
  h.store.commitProof = async (id, proof) => { await original(id, proof); throw fault('FAIR_DICE_STORE_ERROR', 502); };
  const result = await h.request('/challenge', challenge(receipt));
  assert.equal(result.status, 200);
  assert.equal(h.store.proofCommits, 1);
});

test('failed proof write preserves first seed and later result recovers without another reservation', async t => {
  const h = harness(t);
  const receipt = await reserve(h);
  const original = h.store.commitProof.bind(h.store);
  h.store.commitProof = async () => { throw fault('FAIR_DICE_STORE_ERROR', 502); };
  const result = await h.request('/challenge', challenge(receipt));
  assert.equal(result.status, 502);
  assert.equal(h.store.record.clientSeed, CLIENT);
  assert.equal(h.store.record.proof, null);
  h.store.commitProof = original;
  const recovered = await h.request('/result', { code: CODE, requestId: REQUEST });
  assert.equal(recovered.status, 200);
  assert.equal(h.store.allocations, 1);
  assert.equal(h.store.proofCommits, 1);
});

test('system opening proof passes authoritative transition and is consumed exactly once', async t => {
  const h = harness(t);
  const receipt = await reserve(h);
  const result = await h.request('/challenge', challenge(receipt));
  const proof = result.data.proof;
  const next = clone(h.store.state);
  rules.decideOpeningRoll(next, { id: 'white', color: 'white', die: proof.dice[0] },
    { id: 'dark', color: 'dark', die: proof.dice[1] });
  for (const entry of [next.history[0], next.openingRoll]) Object.assign(entry, {
    fairDiceProof: clone(proof), sha256: proof.sha256, sha256Input: proof.sha256Input, rerolls: proof.rerolls,
  });
  const applied = await h.request('/state', { code: CODE, state: next, version: 0 });
  assert.equal(applied.status, 200);
  assert.equal(h.store.record.consumed, true);
  assert.equal((await h.request('/challenge', challenge(receipt))).status, 409);
});

test('protected rules reject unknown or mixed room dice protocols', () => {
  const state = new MemoryStore().state;
  const unknown = clone(state);
  unknown.fairDice.protocol = 'unknown';
  assert.throws(() => validateTransition(state, unknown, { actorColor: 'white' }), error => error.code === 'fair_proof_required');
  assert.throws(() => validateTransition(state, state, { actorColor: 'white', fairDiceProtocol: FairDice.PROTOCOL }),
    error => error.code === 'fair_proof_required');
});
