'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const FairDice = require('../fair-dice.js');
const { rules } = require('../lib/fair-dice-rules.js');
const { createFairDiceService, RELAYS } = require('../lib/fair-dice-service.js');

const CODE = 'SAFE-RQME';
const GAME_ID = 'eb9acac4-7621-4106-976f-08dd288b6585';
const KEY = '01'.repeat(32);
const ORIGIN = 'https://volzay.github.io';
// Public drand quicknet round 1000. Its real BLS signature is checked by every
// successful job/proof test, not replaced by a signature-validation mock.
const BEACON = Object.freeze({ round: 1000,
  signature: 'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39',
  randomness: 'fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd' });
const clone = value => JSON.parse(JSON.stringify(value));

function assertCompactStateAck(response, expected) {
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, {
    ok: true,
    version: expected.version,
    gameId: expected.gameId ?? GAME_ID,
    variant: 'long',
    protocol: expected.protocol ?? FairDice.PROTOCOL,
    ...(expected.unchanged ? { unchanged: true } : {}),
    ...(expected.deferred ? { deferred: true } : {}),
  });
  assert.equal(Object.hasOwn(response.data, 'state'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(response.data), 'utf8') < 256);
}

function fault(code = '42501', status = 403, message = 'private upstream details') {
  return Object.assign(new Error(message), { code, status });
}

function initial(mode = 'remote') {
  return Object.assign(clone(rules.initialState('long')), { mode, roomCode: CODE, startedAt: 1789689600000 });
}

class MemoryStore {
  constructor(state = initial()) {
    this.state = state;
    this.version = 0;
    this.gameId = GAME_ID;
    this.required = true;
    this.records = new Map();
    this.pendingId = null;
    this.validated = new WeakSet();
    this.commits = 0;
    this.proofCommits = 0;
    this.allocations = 0;
    this.presenceCalls = 0;
    this.bot = false;
    this.ownerColor = 'white';
    this.status = null;
    this.joinedAt = new Date(Date.now() - 300000).toISOString();
    this.presence = { white: { lastSeen: Date.now(), name: 'White' }, dark: { lastSeen: Date.now(), name: 'Dark' } };
  }
  hash() { return createHash('sha256').update(JSON.stringify(this.state)).digest('hex'); }
  async getRoom(code, headers) {
    assert.equal(code, CODE);
    if (headers.authorization === 'Bearer stranger.test') throw fault();
    if (!headers.authorization && headers['x-guest-proof'] !== 'guest-proof-valid') throw fault();
    this.validated.add(headers);
    const dark = headers.authorization === 'Bearer dark.test';
    return { roomCode: code, variant: 'long', version: this.version, state: clone(this.state),
      gameId: this.gameId, fairDiceRequired: this.required, serverPositionHash: this.hash(),
      status: this.status || (this.state?.winner ? 'over' : 'joined'), joinedAt: this.joinedAt, serverNowMs: Date.now(), presence: clone(this.presence),
      actor: { actorColor: this.bot ? this.ownerColor : dark ? 'dark' : 'white', seatColor: dark ? 'dark' : 'white', ownsHost: !dark, bot: this.bot },
      pending: this.pendingId ? clone(this.records.get(this.pendingId)) : null };
  }
  async reserve(code, intent, headers) {
    assert.equal(this.validated.has(headers), true, 'same authenticated headers must reach reserve');
    if (this.pendingId) return clone(this.records.get(this.pendingId).request);
    const label = this.state.phase === 'opening' ? 'opening' : this.state.phase === 'roll' ? 'roll' : null;
    const color = label === 'opening' ? 'none' : this.state.turn;
    if (!label || intent.label !== label || intent.color !== color) throw fault('22023', 422);
    if (label === 'opening' && headers.authorization === 'Bearer dark.test') throw fault();
    if (label === 'roll' && color !== (headers.authorization === 'Bearer dark.test' ? 'dark' : 'white') && !this.bot) throw fault();
    assert.equal(intent.positionHash, this.hash());
    this.allocations += 1;
    const request = { id: 'ca2a6463-c2ba-4a9b-a0f0-' + String(this.allocations).padStart(12, '0'),
      roomCode: code, gameId: this.gameId, nonce: this.allocations, label, color,
      variant: 'long', round: 1000, createdAt: new Date(FairDice.roundTime(1000) - 6000).toISOString(),
      positionHash: intent.positionHash };
    this.pendingId = request.id;
    this.records.set(request.id, { request, proof: null, cancelled: false, consumed: false });
    return clone(request);
  }
  async getRequest(id) {
    if (!this.records.has(id)) throw fault('P0002', 404);
    return clone(this.records.get(id));
  }
  async commitProof(id, proof) {
    const record = this.records.get(id);
    assert.equal(record.cancelled, false);
    if (record.proof) assert.deepEqual(record.proof, proof);
    else { record.proof = clone(proof); this.proofCommits += 1; }
    return clone(record.proof);
  }
  async commitState(code, state, version, headers) {
    assert.equal(code, CODE);
    assert.equal(this.validated.has(headers), true, 'same authenticated headers must reach commit');
    assert.equal(version, this.version);
    if (this.pendingId) {
      const pending = this.records.get(this.pendingId);
      if (state.history[0]?.fairDiceProof?.request?.id === this.pendingId) pending.consumed = true;
      else { assert.equal(state.phase, 'over'); pending.cancelled = true; }
      this.pendingId = null;
    }
    this.state = clone(state);
    this.version += 1;
    this.commits += 1;
    return { ok: true, state: clone(state), version: this.version, gameId: this.gameId };
  }
  async resetFairGame(code, state, version, headers) {
    assert.equal(this.validated.has(headers), true);
    assert.equal(version, this.version);
    this.gameId = '0afc83bb-98ec-4321-bdb7-493ed09f8ae0';
    return this.commitState(code, state, version, headers);
  }
  async closeFairWaitingRoom(code, headers) {
    assert.equal(code, CODE);
    assert.equal(this.validated.has(headers), true);
    assert.equal(this.status, 'waiting');
    this.status = 'closed';
    return { ok: true, removed: true, version: this.version, state: this.state };
  }
  async touchPresence(code, headers) {
    assert.equal(this.validated.has(headers), true);
    this.presenceCalls += 1;
    const color = headers.authorization === 'Bearer dark.test' ? 'dark' : 'white';
    this.presence[color].lastSeen = Date.now();
    return this.getRoom(code, headers);
  }
  async listPending() { return [...this.records.values()].filter(record => !record.proof && !record.consumed && !record.cancelled).map(clone); }
}

async function harness(t, options = {}) {
  const store = options.store || new MemoryStore();
  const calls = [];
  const fetchImpl = options.fetchImpl || (async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(BEACON), { status: 200 });
  });
  const service = createFairDiceService({ store, signingKey: KEY, allowedOrigins: [ORIGIN],
    fetchImpl, retryDelayMs: 5, jobDeadlineMs: 200, ...options });
  const server = http.createServer(service.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/fair-dice/v1';
  const request = async (route, body, init = {}) => {
    const response = await fetch(url + route, { method: 'POST',
      headers: { origin: ORIGIN, authorization: 'Bearer white.test', 'content-type': 'application/json', ...init.headers },
      body: typeof body === 'string' ? body : JSON.stringify(body), ...init,
    });
    let data;
    try { data = await response.json(); } catch { data = null; }
    return { status: response.status, data, headers: response.headers };
  };
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { store, service, calls, request, url };
}

function openingState(previous, proof) {
  const next = clone(previous);
  rules.decideOpeningRoll(next, { id: 'white', color: 'white', die: proof.dice[0] },
    { id: 'dark', color: 'dark', die: proof.dice[1] });
  Object.assign(next.openingRoll, { fairDiceProof: clone(proof), sha256: proof.sha256,
    sha256Input: proof.sha256Input, rerolls: proof.rerolls });
  Object.assign(next.history[0], { fairDiceProof: clone(proof), sha256: proof.sha256,
    sha256Input: proof.sha256Input, rerolls: proof.rerolls });
  return next;
}

async function issueOpening(h) {
  const reserved = await h.request('/reserve', { code: CODE, label: 'opening', color: 'none' });
  assert.equal(reserved.status, 202);
  await h.service.waitForIdle();
  const ready = await h.request('/result', { code: CODE, requestId: reserved.data.request.id });
  assert.equal(ready.status, 200);
  return ready.data.proof;
}

test('system coordinator accepts a first-checker undo without top-level policy metadata and preserves its issued dice', async t => {
  const serverSeed = 'ab'.repeat(32);
  const at = '2026-09-18T00:00:00.000Z';
  class SystemUndoStore extends MemoryStore {
    async getRoom(code, headers) {
      const room = await super.getRoom(code, headers);
      if (headers.authorization === 'Bearer dark.test') room.actor.actorColor = 'dark';
      return { ...room, fairDiceProtocol: FairDice.SYSTEM_PROTOCOL };
    }
    async reserve(code, intent, headers) {
      const request = await super.reserve(code, intent, headers);
      const record = this.records.get(request.id);
      if (record.protocol !== FairDice.SYSTEM_PROTOCOL) {
        delete request.round;
        request.commitment = '0'.repeat(64);
        request.commitment = FairDice.systemCommitment(request, serverSeed);
        Object.assign(record, { request, protocol: FairDice.SYSTEM_PROTOCOL,
          privateSeed: serverSeed, clientSeed: null });
      }
      return clone(record.request);
    }
    async acceptClientSeed(id, seed, headers) {
      assert.equal(this.validated.has(headers), true);
      const record = this.records.get(id);
      if (record.clientSeed === null) record.clientSeed = seed;
      return clone(record);
    }
  }
  const store = new SystemUndoStore(initial('bot'));
  store.bot = true;
  store.state.analysis = { playerColor: 'white', difficulty: 'hard-neuro' };
  const h = await harness(t, { store });
  async function issueSystem(label, color) {
    const reserved = await h.request('/reserve', { code: CODE, label, color });
    assert.equal(reserved.status, 202, JSON.stringify(reserved.data));
    const receipt = reserved.data.receipt;
    // Pick reproducible fixture dice; the actual service must still accept,
    // persist, derive and sign the challenge through its real system path.
    let clientSeed;
    for (let index = 0; index < 128; index += 1) {
      const seed = index.toString(16).padStart(64, '0');
      const fixture = FairDice.createSystemProof(receipt, serverSeed, seed);
      if (label === 'opening' ? fixture.dice[0] > fixture.dice[1]
        : fixture.dice[0] !== fixture.dice[1]) { clientSeed = seed; break; }
    }
    assert.ok(clientSeed, 'fixture must give the human the opening and a two-die turn');
    const challenged = await h.request('/challenge', { code: CODE, requestId: receipt.request.id,
      requestHash: receipt.requestHash, clientSeed });
    assert.equal(challenged.status, 200, JSON.stringify(challenged.data));
    const proof = challenged.data.proof;
    assert.equal((await FairDice.verifyProof(proof, { publicKey: h.service.publicKey })).protocol,
      FairDice.SYSTEM_PROTOCOL);
    return proof;
  }
  const save = state => h.request('/state', { code: CODE, state, version: store.version });
  const openingProof = await issueSystem('opening', 'none');
  const opened = openingState(store.state, openingProof);
  opened.openingRoll.at = at;
  opened.history[0].at = at;
  assert.equal((await save(opened)).status, 200);
  const ready = clone(store.state);
  rules.startOpeningTurn(ready);
  assert.equal((await save(ready)).status, 200);
  const turnProof = await issueSystem('roll', 'white');
  const rolled = clone(store.state);
  rules.applyRoll(rolled, turnProof.dice);
  rolled.history.unshift({ color: 'white', roll: turnProof.dice.join(':'), openingMove: true,
    sha256: turnProof.sha256, sha256Input: turnProof.sha256Input,
    fairDiceProof: clone(turnProof), at });
  assert.equal(rolled.fairDice, undefined, 'live neural rooms keep their policy on the room row');
  assert.equal((await save(rolled)).status, 200);
  const moved = clone(rolled);
  const firstMove = rules.legalNextMoves(clone(moved))[0];
  assert.equal(rules.applyMove(moved, firstMove.from, firstMove.die, { autoEnd: false }), true);
  assert.equal((await save(moved)).status, 200);
  const rejectedVersion = store.version;
  const wrongActor = await h.request('/state', { code: CODE, state: rolled, version: store.version }, {
    headers: { origin: ORIGIN, authorization: 'Bearer dark.test', 'content-type': 'application/json' },
  });
  assert.equal(wrongActor.status, 422);
  assert.equal(wrongActor.data.code, 'fair_actor_forbidden');
  const tampered = clone(rolled);
  tampered.history[0].fairDiceProof.dice[0] = (turnProof.dice[0] % 6) + 1;
  const forged = await save(tampered);
  assert.equal(forged.status, 422);
  assert.equal(forged.data.code, 'fair_roll_history_changed');
  assert.equal(store.version, rejectedVersion);
  const undone = await save(rolled);
  assertCompactStateAck(undone, { version: store.version, protocol: FairDice.SYSTEM_PROTOCOL });
  assert.deepEqual(store.state, clone(rolled));
  assert.deepEqual(store.state.history[0].fairDiceProof, turnProof);
  assert.deepEqual(store.state.rolled, turnProof.dice);
  assert.equal(store.allocations, 2);
  assert.equal(store.proofCommits, 2);
  assert.equal(h.calls.length, 0, 'system undo cannot fetch another random source');
  const completed = clone(store.state);
  for (const move of rules.bestMoveSequences(clone(completed), completed.turn)[0]) {
    assert.equal(rules.applyMove(completed, move.from, move.die, { autoEnd: false }), true);
  }
  rules.endTurn(completed);
  assert.equal((await save(completed)).status, 200);
  const completedVersion = store.version;
  const lateUndo = await save(rolled);
  assert.equal(lateUndo.status, 422);
  assert.equal(lateUndo.data.code, 'fair_undo_forbidden');
  assert.equal(store.version, completedVersion);
});

test('reservation returns signed future intent before source completion, no client-supplied round', async t => {
  let release;
  let called;
  const began = new Promise(resolve => { called = resolve; });
  const h = await harness(t, { fetchImpl: async () => {
    called();
    await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify(BEACON));
  } });
  const reserved = await h.request('/reserve', { code: CODE, label: 'opening', color: 'none' });
  assert.equal(reserved.status, 202);
  assert.equal(FairDice.verifyReservation(reserved.data.receipt, h.service.publicKey, { roomCode: CODE, gameId: GAME_ID }), true);
  await began;
  assert.equal(h.store.proofCommits, 0);
  const pending = await h.request('/result', { code: CODE, requestId: reserved.data.request.id });
  assert.equal(pending.status, 202);
  release();
  await h.service.waitForIdle();
  assert.equal(h.store.proofCommits, 1);
  const malicious = await h.request('/reserve', { code: CODE, label: 'opening', color: 'none', round: 1 });
  assert.equal(malicious.status, 400);
});

test('real pinned BLS beacon yields fully independently verified physical dice', async t => {
  const h = await harness(t);
  const proof = await issueOpening(h);
  const verified = await FairDice.verifyProof(proof, { publicKey: h.service.publicKey });
  assert.equal(verified.sourceVerified, true);
  assert.equal(verified.reservationVerified, true);
  assert.equal(proof.dice.length, 2);
  assert.notEqual(proof.dice[0], proof.dice[1]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, RELAYS[0] + '/' + FairDice.CHAIN.hash + '/public/1000');
  assert.deepEqual(h.calls[0].init.headers, { accept: 'application/json' });
  assert.equal(h.calls[0].init.redirect, 'error');
});

test('parallel reserve/result retries allocate one nonce and one source job', async t => {
  const h = await harness(t);
  const replies = await Promise.all(Array.from({ length: 6 }, () => h.request('/reserve', { code: CODE, label: 'opening', color: 'none' })));
  assert.equal(new Set(replies.map(reply => reply.data.request.id)).size, 1);
  await h.service.waitForIdle();
  assert.equal(h.store.allocations, 1);
  assert.equal(h.store.proofCommits, 1);
  assert.equal(h.calls.length, 1);
  const results = await Promise.all(Array.from({ length: 3 }, () => h.request('/result', { code: CODE, requestId: replies[0].data.request.id })));
  assert.equal(results.every(reply => reply.status === 200), true);
  assert.deepEqual(results[0].data.proof, results[2].data.proof);
});

test('invalid relay signature never yields dice and retries the same intent', async t => {
  let broken = true;
  const h = await harness(t, { jobDeadlineMs: 40, fetchImpl: async () => new Response(JSON.stringify(broken
    ? { ...BEACON, signature: 'a'.repeat(96) } : BEACON)) });
  const reserved = await h.request('/reserve', { code: CODE, label: 'opening', color: 'none' });
  await h.service.waitForIdle();
  assert.equal(h.store.proofCommits, 0);
  assert.equal(h.store.allocations, 1);
  broken = false;
  const retry = await h.request('/result', { code: CODE, requestId: reserved.data.request.id });
  assert.equal(retry.status, 202);
  await h.service.waitForIdle();
  const ready = await h.request('/result', { code: CODE, requestId: reserved.data.request.id });
  assert.equal(ready.status, 200);
  assert.equal(h.store.allocations, 1);
});

test('bad relay is skipped only for another relay serving the same fixed round', async t => {
  const calls = [];
  const h = await harness(t, { fetchImpl: async url => {
    calls.push(url);
    return new Response(JSON.stringify(calls.length === 1 ? { ...BEACON, round: 999 } : BEACON));
  } });
  await issueOpening(h);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].endsWith('/public/1000'), true);
  assert.equal(calls[1].endsWith('/public/1000'), true);
});

test('restart resumes durable reservations without browser participation or another nonce', async t => {
  const store = new MemoryStore();
  const headers = { authorization: 'Bearer white.test' };
  await store.getRoom(CODE, headers);
  const reserved = await store.reserve(CODE, { label: 'opening', color: 'none', positionHash: store.hash() }, headers);
  const h = await harness(t, { store });
  assert.equal(await h.service.resumePending(), 1);
  await h.service.waitForIdle();
  const result = await h.request('/result', { code: CODE, requestId: reserved.id });
  assert.equal(result.status, 200);
  assert.equal(store.allocations, 1);
});

test('only authenticated current-room actors can read a request; old/foreign epochs are rejected', async t => {
  const h = await harness(t);
  const proof = await issueOpening(h);
  const stranger = await h.request('/result', { code: CODE, requestId: proof.request.id }, {
    headers: { origin: ORIGIN, authorization: 'Bearer stranger.test', 'content-type': 'application/json' },
  });
  assert.equal(stranger.status, 403);
  const record = h.store.records.get(proof.request.id);
  record.request.gameId = '91b5a742-eaac-4490-ac95-1049f510955c';
  const foreign = await h.request('/result', { code: CODE, requestId: proof.request.id });
  assert.equal(foreign.status, 403);
});

test('state applies exactly the ledger proof, protects CAS and does not trust submitted dice', async t => {
  const h = await harness(t);
  const proof = await issueOpening(h);
  const next = openingState(h.store.state, proof);
  const tampered = clone(next);
  tampered.history[0].fairDiceProof.dice = [6, 6];
  const forged = await h.request('/state', { code: CODE, state: tampered, version: 0 });
  assert.equal(forged.status, 409);
  assert.equal(h.store.commits, 0);
  const committed = await h.request('/state', { code: CODE, state: next, version: 0 });
  assertCompactStateAck(committed, { version: 1 });
  assert.equal(h.store.records.get(proof.request.id).consumed, true);
  const conflict = await h.request('/state', { code: CODE, state: next, version: 0 });
  assert.equal(conflict.status, 409);
});

test('full turn path forbids opponent moves, premature end and new dice while current dice remain', async t => {
  const h = await harness(t);
  const openingProof = await issueOpening(h);
  const opened = openingState(h.store.state, openingProof);
  assert.equal((await h.request('/state', { code: CODE, state: opened, version: 0 })).status, 200);
  const ready = clone(h.store.state);
  rules.startOpeningTurn(ready);
  assert.equal((await h.request('/state', { code: CODE, state: ready, version: 1 })).status, 200);
  const color = h.store.state.turn;
  const headers = { origin: ORIGIN, authorization: 'Bearer ' + color + '.test', 'content-type': 'application/json' };
  const reserved = await h.request('/reserve', { code: CODE, label: 'roll', color }, { headers });
  assert.equal(reserved.status, 202);
  await h.service.waitForIdle();
  const result = await h.request('/result', { code: CODE, requestId: reserved.data.request.id }, { headers });
  const proof = result.data.proof;
  const rolled = clone(h.store.state);
  rules.applyRoll(rolled, proof.dice[0] === proof.dice[1] ? Array(4).fill(proof.dice[0]) : proof.dice);
  rolled.history.unshift({ color, roll: proof.dice.join(':'), openingMove: true,
    sha256: proof.sha256, sha256Input: proof.sha256Input, fairDiceProof: clone(proof), at: new Date().toISOString() });
  assert.equal((await h.request('/state', { code: CODE, state: rolled, version: 2 }, { headers })).status, 200);
  const premature = clone(rolled);
  assert.equal(rules.hasAnyMoves(clone(premature)), true);
  rules.endTurn(premature);
  assert.equal((await h.request('/state', { code: CODE, state: premature, version: 3 }, { headers })).status, 422);
  const another = await h.request('/reserve', { code: CODE, label: 'roll', color }, { headers });
  assert.equal(another.status, 422);
  assert.equal(h.store.allocations, 2);
  const move = rules.legalNextMoves(clone(rolled))[0];
  const moved = clone(rolled);
  rules.applyMove(moved, move.from, move.die, { autoEnd: false });
  const opponentHeaders = { ...headers, authorization: 'Bearer ' + (color === 'white' ? 'dark' : 'white') + '.test' };
  assert.equal((await h.request('/state', { code: CODE, state: moved, version: 3 }, { headers: opponentHeaders })).status, 422);
  assert.equal((await h.request('/state', { code: CODE, state: moved, version: 3 }, { headers })).status, 200);
});

test('pending metadata is validated then deferred, never mutating its SQL snapshot', async t => {
  let release;
  const h = await harness(t, { fetchImpl: async () => {
    await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify(BEACON));
  } });
  await h.request('/reserve', { code: CODE, label: 'opening', color: 'none' });
  const snapshot = clone(h.store.state);
  snapshot.turnClock.white = 50;
  snapshot.analysis = { deferred: true };
  const checkpoint = await h.request('/state', { code: CODE, state: snapshot, version: 0 });
  assertCompactStateAck(checkpoint, { version: 0, deferred: true });
  assert.equal(h.store.commits, 0);
  assert.equal(h.store.state.turnClock.white, 0);
  release();
  await h.service.waitForIdle();
});

test('own pending resignation cancels its ledger; fake opponent disconnect never does', async t => {
  const h = await harness(t, { fetchImpl: async (_url, init) => new Promise((_, reject) =>
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  const reserved = await h.request('/reserve', { code: CODE, label: 'opening', color: 'none' });
  const next = clone(h.store.state);
  next.winner = 'dark';
  next.phase = 'over';
  next.finishedAt = next.startedAt + 1000;
  next.history.unshift({ resign: true, color: 'white', winnerColor: 'dark', at: new Date().toISOString() });
  const fake = clone(next);
  delete fake.history[0].resign;
  fake.history[0].networkLoss = true;
  fake.history[0].color = 'dark';
  fake.history[0].winnerColor = 'white';
  fake.winner = 'white';
  const rejected = await h.request('/state', { code: CODE, state: fake, version: 0 });
  assert.equal(rejected.status, 422);
  const committed = await h.request('/state', { code: CODE, state: next, version: 0 });
  assert.equal(committed.status, 200);
  assert.equal(h.store.records.get(reserved.data.request.id).cancelled, true);
  const result = await h.request('/result', { code: CODE, requestId: reserved.data.request.id });
  assert.equal(result.status, 409);
});

test('leave derives own actor and server time, cancels pending and completed retry is a no-op', async t => {
  const h = await harness(t, { fetchImpl: async (_url, init) => new Promise((_, reject) =>
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  const reserved = await h.request('/reserve', { code: CODE, label: 'opening', color: 'none' });
  const invalid = await h.request('/leave', { code: CODE, loser: 'dark' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, 'INVALID_FIELDS');
  const left = await h.request('/leave', { code: CODE });
  assert.equal(left.status, 200);
  assert.equal(left.data.removed, true);
  assert.equal(left.data.state.winner, 'dark');
  assert.equal(left.data.state.history[0].color, 'white');
  assert.equal(left.data.state.history[0].leave, true);
  assert.equal(left.data.state.matchScore.dark, 1);
  assert.equal(h.store.records.get(reserved.data.request.id).cancelled, true);
  const again = await h.request('/leave', { code: CODE });
  assert.equal(again.status, 200);
  assert.equal(again.data.unchanged, true);
  assert.equal(h.store.commits, 1);
});

test('waiting room closes through own-seat authority without a fabricated game result', async t => {
  const store = new MemoryStore(null);
  store.status = 'waiting';
  const h = await harness(t, { store });
  const stranger = await h.request('/leave', { code: CODE }, { headers: {
    origin: ORIGIN, authorization: 'Bearer dark.test', 'content-type': 'application/json',
  } });
  assert.equal(stranger.status, 403);
  assert.equal(store.status, 'waiting');
  const closed = await h.request('/leave', { code: CODE });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.removed, true);
  assert.equal(closed.data.state, null);
  assert.equal(store.status, 'closed');
  assert.equal(store.commits, 0);
});

test('completed state retries ignore benign publish markers and stale CAS but reject result mutations', async t => {
  const h = await harness(t);
  const left = await h.request('/leave', { code: CODE });
  assert.equal(left.status, 200);
  const finished = clone(h.store.state);
  finished.gameOverPublishedAt = Date.now();
  finished.turnClock.white += 100;
  const repeated = await h.request('/state', { code: CODE, state: finished, version: 0 });
  assertCompactStateAck(repeated, { version: 1, unchanged: true });
  assert.equal(h.store.commits, 1);
  const altered = clone(finished);
  altered.winner = 'white';
  const forged = await h.request('/state', { code: CODE, state: altered, version: 1 });
  assert.equal(forged.status, 422);
  assert.equal(h.store.commits, 1);
});

test('match restart capability is derived from recorded server result, never a client privilege flag', async t => {
  const store = new MemoryStore();
  store.state.matchScore.dark = 4;
  const h = await harness(t, { store });
  const left = await h.request('/leave', { code: CODE });
  assert.equal(left.status, 200);
  assert.equal(left.data.state.matchScore.dark, 5);
  const fresh = initial();
  fresh.startedAt = store.state.startedAt + 10000;
  const restarted = await h.request('/state', { code: CODE, state: fresh, version: 1 });
  assertCompactStateAck(restarted, { version: 2, gameId: h.store.gameId });
  assert.equal(h.store.state.matchScore.dark, 0);
  assert.notEqual(restarted.data.gameId, GAME_ID);
  const unfinished = new MemoryStore();
  const u = await harness(t, { store: unfinished });
  assert.equal((await u.request('/leave', { code: CODE })).status, 200);
  const next = initial();
  next.startedAt += 10000;
  const dropped = await u.request('/state', { code: CODE, state: next, version: 1 });
  assert.equal(dropped.status, 422);
});

test('presence RPC authenticates the seat; clients cannot submit playerColor or time', async t => {
  const h = await harness(t);
  const presence = await h.request('/presence', { code: CODE });
  assert.equal(presence.status, 200);
  assert.equal(presence.data.presence.viewerColor, 'white');
  assert.equal(presence.data.presence.opponent.online, true);
  assert.equal(h.store.presenceCalls, 1);
  const spoof = await h.request('/presence', { code: CODE, color: 'dark', now: 0 });
  assert.equal(spoof.status, 400);
  assert.equal(h.store.presenceCalls, 1);
});

test('server heartbeat expires a truly stale opponent, preserves proof ledger and records winner', async t => {
  const store = new MemoryStore();
  store.presence.dark.lastSeen = Date.now() - 160000;
  const h = await harness(t, { store });
  const reply = await h.request('/presence', { code: CODE });
  assert.equal(reply.status, 200);
  assert.equal(reply.data.state.winner, 'white');
  assert.equal(reply.data.state.history[0].networkLoss, true);
  assert.equal(reply.data.state.matchScore.white, 1);
  assert.equal(reply.data.state.matchScore.recordedWinner, 'white');
  assert.equal(store.commits, 1);
});

test('joining resets expiry baseline; bots never lose on synthetic seat inactivity', async t => {
  const store = new MemoryStore();
  store.presence.dark.lastSeen = Date.now() - 3600000;
  store.joinedAt = new Date(Date.now() - 2000).toISOString();
  const h = await harness(t, { store });
  const joined = await h.request('/presence', { code: CODE });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.state.winner, null);
  assert.equal(joined.data.presence.opponent.online, true);
  const bot = new MemoryStore(initial('bot'));
  bot.bot = true;
  bot.ownerColor = 'dark';
  bot.presence.dark.lastSeen = Date.now() - 3600000;
  const b = await harness(t, { store: bot });
  const heartbeat = await b.request('/presence', { code: CODE });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.data.presence.viewerColor, 'dark');
  assert.equal(heartbeat.data.presence.opponent.online, true);
  assert.equal(bot.commits, 0);
});

test('opponent reconnect race rejected by SQL is recovered, not falsely declared a loss', async t => {
  const store = new MemoryStore();
  store.presence.dark.lastSeen = Date.now() - 160000;
  store.commitState = async () => {
    store.presence.dark.lastSeen = Date.now();
    throw fault('40001', 409);
  };
  const h = await harness(t, { store });
  const reply = await h.request('/presence', { code: CODE });
  assert.equal(reply.status, 200);
  assert.equal(reply.data.state.winner, null);
  assert.equal(reply.data.presence.opponent.online, true);
});

test('legacy rooms cannot silently claim or consume the new protocol', async t => {
  const store = new MemoryStore();
  store.required = false;
  const h = await harness(t, { store });
  const reply = await h.request('/reserve', { code: CODE, label: 'opening', color: 'none' });
  assert.equal(reply.status, 422);
  assert.equal(store.allocations, 0);
});

test('CORS permits only exact configured origins and explicit allowed headers', async t => {
  const h = await harness(t);
  const bad = await h.request('/reserve', { code: CODE, label: 'opening', color: 'none' }, {
    headers: { origin: 'https://evil.example', authorization: 'Bearer white.test', 'content-type': 'application/json' },
  });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const good = await fetch(h.url + '/state', { method: 'OPTIONS', headers: {
    origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-guest-proof',
  } });
  assert.equal(good.status, 204);
  assert.equal(good.headers.get('access-control-allow-origin'), ORIGIN);
  const forbidden = await fetch(h.url + '/state', { method: 'OPTIONS', headers: {
    origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'cookie',
  } });
  assert.equal(forbidden.status, 403);
});

test('strict body, methods, credentials, rate and error redaction fail closed', async t => {
  const h = await harness(t, { bodyLimit: 256, rateLimit: 3 });
  const large = await h.request('/state', { code: CODE, state: 'x'.repeat(300), version: 0 });
  assert.equal(large.status, 413);
  const malformed = await h.request('/state', '{');
  assert.equal(malformed.status, 400);
  const wrong = await h.request('/reserve', { code: CODE, label: 'opening', color: 'none', beaconUrl: 'https://evil.example' });
  assert.equal(wrong.status, 400);
  const rate = await h.request('/reserve', { code: CODE, label: 'opening', color: 'none' });
  assert.equal(rate.status, 429);
  assert.equal(h.store.allocations, 0);
  const empty = await fetch(h.url + '/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(empty.status, 401);
  const get = await fetch(h.url + '/result');
  assert.equal(get.status, 405);
  const secretStore = new MemoryStore();
  secretStore.getRoom = async () => { throw fault(KEY, 502, 'password=' + KEY); };
  const redacted = await harness(t, { store: secretStore });
  const reply = await redacted.request('/reserve', { code: CODE, label: 'opening', color: 'none' });
  assert.equal(reply.status, 502);
  assert.equal(JSON.stringify(reply.data).includes(KEY), false);
  assert.equal(reply.data.error, 'FAIR_DICE_UNAVAILABLE');
});

test('health exposes no keys except pinned public key and guest proof forwarding is explicit', async t => {
  const h = await harness(t);
  const response = await fetch(h.url + '/health');
  const health = await response.json();
  assert.equal(response.status, 200);
  assert.equal(health.publicKey, FairDice.receiptPublicKey(KEY));
  assert.equal(JSON.stringify(health).includes(KEY), false);
  const guest = await h.request('/presence', { code: CODE }, { headers: {
    origin: ORIGIN, 'content-type': 'application/json', 'x-guest-id': 'guest-player', 'x-guest-proof': 'guest-proof-valid',
    cookie: 'not-forwarded', apikey: 'not-forwarded',
  } });
  assert.equal(guest.status, 200);
});

test('service configuration rejects unsafe origins, signing keys and arbitrary relays', () => {
  const store = new MemoryStore();
  for (const allowedOrigins of [['*'], ['https://volzay.github.io/path'], ['file://local']]) {
    assert.throws(() => createFairDiceService({ store, signingKey: KEY, allowedOrigins }));
  }
  assert.throws(() => createFairDiceService({ store, signingKey: 'wrong' }));
  assert.equal(Object.isFrozen(RELAYS), true);
});

test('global admission cap rejects excess concurrent HTTP work before buffering state bodies', async t => {
  let release;
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const store = new MemoryStore();
  const getRoom = store.getRoom.bind(store);
  store.getRoom = async (...args) => {
    entered();
    await new Promise(resolve => { release = resolve; });
    return getRoom(...args);
  };
  const h = await harness(t, { store, maxRequests: 1 });
  const first = h.request('/presence', { code: CODE });
  await began;
  const busy = await h.request('/presence', { code: CODE });
  assert.equal(busy.status, 503);
  store.getRoom = getRoom;
  release();
  assert.equal((await first).status, 200);
});
