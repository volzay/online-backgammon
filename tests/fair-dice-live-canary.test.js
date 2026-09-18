'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCanary, fixturesOf, safeCode, readFixtureFile, parseArguments } = require('../scripts/fair-dice-live-canary.js');
const { SupabaseFairDiceStore } = require('../lib/fair-dice-supabase-store.js');
const { createFairDiceService } = require('../lib/fair-dice-service.js');
const { rules } = require('../lib/fair-dice-rules.js');
const FairDice = require('../fair-dice.js');

const clone = value => JSON.parse(JSON.stringify(value));
const KEY = '01'.repeat(32);
const CODE = 'SAFE-RQME';
const URL = 'https://coordinator.example/fair-dice/v1';
const BACKEND = 'https://backend.example';
const OWNER = { 'x-guest-id': 'canary-owner', 'x-guest-proof': 'canary-owner-private-proof' };
const OTHER = { 'x-guest-id': 'canary-other', 'x-guest-proof': 'canary-other-private-proof' };
const BEACON = { round: 1000,
  signature: 'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39',
  randomness: 'fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd' };

// Virtual HTTPS transport: exercise the actual HTTP service, actual Supabase
// store, published rules and real pinned BLS crypto without any production or
// internet requests. The small backend below models the SQL RPC contract only;
// SQL itself is separately checked by the deployment rollback canary.
function harness(t, kind = 'bot', botColor = 'dark') {
  let state = Object.assign(clone(rules.initialState('long')), { roomCode: CODE, mode: kind,
    startedAt: 1789689600000, ...(kind === 'bot' ? { analysis: { playerColor: botColor } } : {}) });
  let version = 0;
  let gameId = randomUUID();
  let nonce = 0;
  let pending = null;
  let status = 'joined';
  const records = new Map();
  const backendCalls = [];
  const presence = { white: { lastSeen: Date.now() }, dark: { lastSeen: Date.now() } };
  const hash = () => createHash('sha256').update(JSON.stringify(state)).digest('hex');
  function actor(headers) {
    const ownsHost = headers['x-guest-id'] === OWNER['x-guest-id'] && headers['x-guest-proof'] === OWNER['x-guest-proof'];
    const ownsGuest = headers['x-guest-id'] === OTHER['x-guest-id'] && headers['x-guest-proof'] === OTHER['x-guest-proof'];
    if (!ownsHost && !ownsGuest) throw Object.assign(new Error('No access'), { code: '42501' });
    return { ownsHost, seatColor: ownsHost ? 'white' : 'dark', guest: true, bot: kind === 'bot',
      actorColor: kind === 'bot' ? botColor : ownsHost ? 'white' : 'dark' };
  }
  function room(headers) {
    return { roomCode: CODE, variant: 'long', version, state: clone(state), gameId, fairDiceRequired: true,
      serverPositionHash: hash(), status, serverNowMs: Date.now(), joinedAt: new Date(Date.now()).toISOString(),
      presence: clone(presence), actor: actor(headers), pending: pending ? clone(records.get(pending)) : null };
  }
  async function backendFetch(url, init) {
    assert.ok(url.startsWith(BACKEND + '/rest/v1/rpc/'), 'The store may call only the fixed backend RPC prefix');
    const name = url.slice((BACKEND + '/rest/v1/rpc/').length);
    const body = JSON.parse(init.body);
    backendCalls.push({ name, authorization: init.headers.authorization });
    try {
      let result;
      if (name === 'get_fair_dice_room') result = room(init.headers);
      else if (name === 'touch_fair_dice_presence') {
        const who = actor(init.headers);
        presence[who.seatColor].lastSeen = Date.now();
        result = room(init.headers);
      } else if (name === 'reserve_fair_dice') {
        const who = actor(init.headers);
        const label = state.phase === 'opening' ? 'opening' : state.phase === 'roll' ? 'roll' : null;
        const color = label === 'opening' ? 'none' : state.turn;
        if (!label || body.p_label !== label || body.p_color !== color
          || label === 'opening' && !who.ownsHost || label === 'roll' && kind !== 'bot' && who.actorColor !== color) {
          throw Object.assign(new Error('Roll intent denied'), { code: '22023' });
        }
        if (!pending) {
          assert.equal(body.p_position_hash, hash());
          const request = { id: randomUUID(), roomCode: CODE, gameId, nonce: ++nonce,
            label, color, variant: 'long', round: 1000,
            createdAt: new Date(FairDice.roundTime(1000) - 6000).toISOString(), positionHash: hash() };
          pending = request.id;
          records.set(pending, { request, proof: null, cancelled: false, consumed: false });
        }
        result = records.get(pending).request;
      } else {
        assert.equal(init.headers.authorization, 'Bearer service.test', 'Only the real service store may use privileged RPCs');
        if (name === 'get_fair_dice_request') result = records.get(body.p_request_id);
        else if (name === 'commit_fair_dice_proof') {
          const record = records.get(body.p_request_id);
          assert.equal(record.cancelled, false);
          record.proof = clone(body.p_proof);
          result = record.proof;
        } else if (name === 'commit_fair_dice_state' || name === 'reset_fair_dice_game') {
          assert.equal(body.p_expected_version, version);
          const next = body.p_next_state || body.p_initial_state;
          if (pending) {
            const record = records.get(pending);
            if (next.history[0]?.fairDiceProof?.request.id === pending) record.consumed = true;
            else record.cancelled = true;
            pending = null;
          }
          if (name === 'reset_fair_dice_game') { gameId = randomUUID(); nonce = 0; }
          state = clone(next);
          version += 1;
          status = state.phase === 'over' ? 'over' : 'joined';
          result = { ok: true, state: clone(state), version, gameId };
        } else throw new Error('Unsupported test RPC');
      }
      return new Response(JSON.stringify(result), { status: 200 });
    } catch (error) {
      if (!error.code) throw error;
      return new Response(JSON.stringify({ code: error.code }), { status: 403 });
    }
  }
  const serviceStore = new SupabaseFairDiceStore({ url: BACKEND, anonKey: 'anon.test', serviceRoleKey: 'service.test', fetchImpl: backendFetch });
  const readStore = new SupabaseFairDiceStore({ url: BACKEND, anonKey: 'anon.test',
    serviceRoleKey: 'unused-client-canary-do-not-authorize', fetchImpl: backendFetch });
  const service = createFairDiceService({ store: serviceStore, signingKey: KEY, allowedOrigins: [],
    retryDelayMs: 1, jobDeadlineMs: 1000, fetchImpl: async url => {
      assert.match(url, /^https:\/\/api(?:2|3)?\.drand\.sh\/[0-9a-f]{64}\/public\/1000$/);
      return new Response(JSON.stringify(BEACON));
    } });
  t.after(() => service.close());
  async function virtualHttps(url, init) {
    assert.ok(url.startsWith(URL + '/'));
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    const request = Readable.from(init.body ? [Buffer.from(init.body)] : []);
    request.method = init.method;
    request.url = new globalThis.URL(url).pathname;
    request.headers = Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    request.socket = { remoteAddress: '127.0.0.1' };
    let answer;
    const headers = {};
    const response = { statusCode: 200, writableEnded: false, destroyed: false,
      setHeader: (name, value) => { headers[name] = value; },
      end: text => { response.writableEnded = true; answer = new Response(text, { status: response.statusCode, headers }); } };
    await service.handler(request, response);
    assert.ok(answer, 'The actual service handler must send a response');
    return answer;
  }
  return { service, backendCalls, records,
    readRoom: (code, headers) => readStore.getRoom(code, headers), fetchImpl: virtualHttps,
    fixture: { code: CODE, kind, headers: OWNER, ...(kind === 'remote' ? { opponentHeaders: OTHER } : {}) },
    current: () => ({ state: clone(state), status, gameId, version }) };
}

for (const kind of ['bot', 'remote']) {
  test(`live canary ${kind}: actual service/store/crypto complete proof, tamper, two turns, rematch and own cleanup`, async t => {
    const h = harness(t, kind);
    const output = [];
    const result = await runCanary({ serviceUrl: URL, publicKey: h.service.publicKey, fixtures: [h.fixture],
      readRoom: h.readRoom, fetchImpl: h.fetchImpl, pollIntervalMs: 1, timeoutMs: 3000,
      report: entry => output.push(entry) });
    assert.equal(result.ok, true);
    const fixture = result.fixtures[0];
    assert.equal(fixture.rematch, true);
    assert.deepEqual(fixture.rolls.map(roll => roll.nonce), [1, 2, 3, 1]);
    assert.equal(fixture.rolls.every(roll => roll.sourceVerified && roll.reservationVerified && roll.dice.length === 2), true);
    assert.equal(fixture.rejected.length, 7);
    assert.notEqual(fixture.rolls[0].gameId, fixture.rolls.at(-1).gameId);
    assert.equal(h.records.size, 4, 'Parallel reservation retries must not allocate additional dice');
    const ended = h.current();
    assert.equal(ended.status, 'over');
    assert.equal(ended.state.phase, 'over');
    assert.equal(ended.state.history[0].leave, true);
    assert.equal(ended.state.history[0].color, kind === 'bot' ? 'dark' : 'white');
    assert.equal(ended.state.matchScore.recordedWinner, ended.state.winner);
    assert.equal(output.at(-1).ownLeave, true);
    const publicOutput = JSON.stringify(output);
    for (const secret of [OWNER['x-guest-proof'], OTHER['x-guest-proof'], 'service.test', 'anon.test']) assert.equal(publicOutput.includes(secret), false);
    assert.equal(h.backendCalls.some(call => call.authorization === 'Bearer unused-client-canary-do-not-authorize'), false);
    if (kind === 'remote') {
      assert.deepEqual([...h.records.values()].filter(record => record.request.label === 'roll').map(record => record.request.color).sort(), ['dark', 'white']);
    }
  });
}

test('live canary refuses non-guest, duplicate, unrelated-header and incomplete remote fixture scopes', () => {
  for (const fixtures of [[], [{ code: CODE, kind: 'bot', headers: { authorization: 'Bearer account.token' } }],
    [{ code: CODE, kind: 'bot', headers: { ...OWNER, apikey: 'not-forwardable' } }],
    [{ code: CODE, kind: 'remote', headers: OWNER }],
    [{ code: CODE, kind: 'remote', headers: OWNER, opponentHeaders: OWNER }],
    [{ code: CODE, kind: 'bot', headers: OWNER }, { code: CODE, kind: 'bot', headers: OWNER }]]) {
    assert.throws(() => fixturesOf(fixtures));
  }
});

test('live canary explicitly permits the four-room matrix but refuses a fifth fixture', () => {
  const matrix = ['SAFE-RQME', 'TEST-RQME', 'PLAY-RQME', 'GAME-RQME'].map((code, index) => ({
    code, kind: 'bot', headers: { 'x-guest-id': `matrix-owner-${index}`, 'x-guest-proof': `matrix-proof-${index}` },
  }));
  assert.equal(fixturesOf(matrix).length, 4);
  assert.throws(() => fixturesOf([...matrix, { code: 'BETS-RQME', kind: 'bot', headers: OWNER }]),
    error => error.code === 'CANARY_FIXTURES_INVALID');
});

test('canary CLI accepts one optional public publishable alias without changing legacy defaults', () => {
  const required = ['--url', URL, '--public-key', FairDice.receiptPublicKey(KEY), '--fixture-file', '/tmp/controlled-fixtures.json'];
  const defaults = parseArguments(required);
  assert.equal(defaults['--publishable-key'], undefined);
  const alias = 'sb_publishable_kWyPnUGXGMJ0afLvIdRNNr_j7tZjhXC';
  assert.equal(parseArguments([...required, '--publishable-key', alias])['--publishable-key'], alias);
  for (const value of ['sb_secret_private_key', 'sb_publishable_short', alias + '\r\nInjected:value',
    'sb_publishable_' + 'a'.repeat(129), 'Bearer ' + alias]) {
    assert.throws(() => parseArguments([...required, '--publishable-key', value]),
      error => error.code === 'CANARY_PUBLISHABLE_KEY_INVALID');
  }
  assert.throws(() => parseArguments([...required, '--publishable-key', alias, '--publishable-key', alias]),
    error => error.code === 'CANARY_ARGUMENTS_INVALID');
  assert.throws(() => parseArguments([...required, '--service-role-key', 'private']),
    error => error.code === 'CANARY_ARGUMENTS_INVALID');
});

test('live canary rejects insecure/credentialed URLs before making any request and sanitizes failures', async () => {
  for (const url of ['http://coordinator.example/fair-dice/v1', 'https://user:secret@coordinator.example/fair-dice/v1',
    'https://coordinator.example/unrelated', URL + '?token=private']) {
    await assert.rejects(runCanary({ serviceUrl: url, publicKey: 'a'.repeat(64), fixtures: [],
      readRoom: () => { throw new Error('No request expected'); }, fetchImpl: () => { throw new Error('No request expected'); } }));
  }
  assert.equal(safeCode(new Error('private credential')), 'CANARY_FAILED');
  assert.equal(safeCode({ code: 'private\ncredential' }), 'CANARY_FAILED');
});

test('live canary refuses an existing live room without issuing play or cleanup writes', async t => {
  const h = harness(t);
  const room = await h.readRoom(CODE, OWNER);
  room.state.phase = 'move';
  await assert.rejects(runCanary({ serviceUrl: URL, publicKey: h.service.publicKey, fixtures: [h.fixture],
    readRoom: async () => room, fetchImpl: h.fetchImpl }), error => error.code === 'CANARY_NOT_DISPOSABLE_INITIAL_ROOM');
  assert.equal(h.backendCalls.some(call => !['get_fair_dice_room'].includes(call.name)), false);
  assert.equal(h.current().state.phase, 'opening');
});

test('live canary pin mismatch does not authenticate or mutate a controlled fixture', async t => {
  const h = harness(t);
  await assert.rejects(runCanary({ serviceUrl: URL, publicKey: 'a'.repeat(64), fixtures: [h.fixture],
    readRoom: h.readRoom, fetchImpl: h.fetchImpl }), error => error.code === 'CANARY_PIN_MISMATCH');
  assert.equal(h.backendCalls.length, 0);
});

test('canary fixture credentials are read only from an owned, protected regular file without symlink following', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fair-dice-canary-fixture-'));
  const file = path.join(directory, 'fixture.json');
  const symlink = path.join(directory, 'link.json');
  t.after(() => {
    if (fs.existsSync(symlink)) fs.unlinkSync(symlink);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  const payload = { backendUrl: BACKEND, anonKey: 'anon.test', fixtures: [{ code: CODE, kind: 'bot', headers: OWNER }] };
  // Generated test data only: these credentials never identify a real player.
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  assert.deepEqual(readFixtureFile(file), { ...payload, fixtures: [{ ...payload.fixtures[0], opponentHeaders: null }] });
  fs.chmodSync(file, 0o644);
  assert.throws(() => readFixtureFile(file), error => error.code === 'CANARY_FIXTURE_FILE_INVALID');
  fs.chmodSync(file, 0o600);
  fs.symlinkSync(file, symlink);
  assert.throws(() => readFixtureFile(symlink), error => error.code === 'CANARY_FIXTURE_FILE_INVALID');
  assert.throws(() => readFixtureFile('relative-fixture.json'), error => error.code === 'CANARY_FIXTURE_FILE_INVALID');
});
