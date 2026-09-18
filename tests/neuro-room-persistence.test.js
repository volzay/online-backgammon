const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createHash, webcrypto } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PORT = 42149;
const BASE = `http://127.0.0.1:${PORT}`;
const NAME = 'Сложный бот-нейро';
const MODEL_FP = 'sha256:4254bfa9f4afccbeb73657f11e37ff39a7fcd9162e7887f1aae28eaa7fbe0155';
const OWNER = 'neuro-test-owner-token-32-characters-long';
const copy = value => JSON.parse(JSON.stringify(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');
let server;
let dataDir;
let childOutput = '';

function loadGame() {
  const context = vm.createContext({ window: {}, console, Date, Math, JSON });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context);
  return context.window.NarduGame;
}
const game = loadGame();

function initialState(difficulty = 'hard-neuro', variant = 'long') {
  const state = copy(game.initialState(variant));
  state.mode = 'bot';
  state.botDifficulty = difficulty;
  state.analysis = { mode: 'bot', difficulty, playerColor: 'white' };
  return state;
}

function mockSupabase() {
  const calls = [];
  const inserts = [];
  const updates = [];
  const user = { id: 'test-neural-user', nickname: 'NeuralTester' };
  let room = null;
  function from(table) {
    let fields = '';
    let operation = 'read';
    const query = {
      select(value) { fields = value; return query; },
      insert(value) { operation = 'insert'; inserts.push(copy(value)); room = value; return query; },
      update(value) { operation = 'update'; updates.push({ table, value: copy(value) }); return query; },
      eq() { return query; }, neq() { return query; }, or() { return query; },
      in() { return query; }, order() { return query; }, limit() { return query; },
      async maybeSingle() {
        if (table === 'profiles') return { data: { id: user.id, nickname: user.nickname, rating: 1400 }, error: null };
        if (operation === 'insert') return { data: { id: 'neural-room-id', game_version: 0 }, error: null };
        if (operation === 'update') return { data: { game_version: 1 }, error: null };
        if (fields.includes('fair_dice_required')) return { data: {
          id: 'neural-room-id', game_state: room?.game_state || initialState(),
          game_version: 0, status: 'joined', fair_dice_required: false,
        }, error: null };
        return { data: null, error: null };
      },
      then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); },
    };
    calls.push({ table });
    return query;
  }
  return {
    calls, inserts, updates,
    rpcCalls: [],
    from,
    auth: {
      getUser: async () => ({ data: { user }, error: null }),
      getSession: async () => ({ data: { session: { user } }, error: null }),
    },
    async rpc(name, args) {
      this.rpcCalls.push({ name, args: copy(args) });
      return { data: { ok: true, trainingArchived: false }, error: null };
    },
  };
}

function loadRooms({ configured = false, client = mockSupabase() } = {}) {
  const requests = [];
  let clientLoads = 0;
  const storage = new Map();
  const context = {
    window: {
      NarduSupabase: { configured: () => configured, client: async () => { clientLoads += 1; return client; } },
      NarduApp: {
        getUser: () => ({ id: 'test-neural-user', name: 'NeuralTester', guest: false, rating: 1400, ratingEligible: true }),
        shouldShowRatingToOthers: () => true, ratingTierFor: () => 'Silver', guestRequestHeaders: () => ({}),
      },
      crypto: webcrypto,
    },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    console, Date, Math, JSON, Map, Set, TextEncoder, Uint8Array,
    fetch: async (url, options) => {
      requests.push({ url, body: options?.body && JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, version: 1 }) };
    },
  };
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'rooms-client.js'), 'utf8'), context);
  return { rooms: context.window.NarduRooms, requests, client, clientLoads: () => clientLoads };
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nardy-neuro-persistence-'));
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: dataDir, ADMIN_PASSWORD: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = chunk => { childOutput = `${childOutput}${chunk}`.slice(-16000); };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);
  server.on('error', error => capture(error.message));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${childOutput}`);
    try { if ((await fetch(`${BASE}/index.html`)).ok) return; } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Test server failed to start: ${childOutput}`);
});
test.after(() => {
  server?.kill();
  // This exact mkdtemp directory contains only this test's isolated accounts/archive.
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

function guest(suffix) {
  const proof = `gproof:${sha256(`neural-test:${suffix}`)}`;
  return { proof, id: `guest:sha256:${sha256(`nardu/guest/v1:${proof}`)}`, name: `NeuroGuest${suffix}` };
}
async function request(player, pathname, method = 'GET', body = null) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-guest-id': player.id, 'x-guest-proof': player.proof, 'x-bot-owner': OWNER },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
async function createRoom(player, code, overrides = {}) {
  return request(player, '/api/rooms/bot-analysis', 'POST', {
    code, hostName: player.name, hostUserId: player.id, hostRatingEligible: false,
    difficulty: 'hard-neuro', variant: 'long', botName: 'Spoofed bot', botRating: 9999,
    ownerToken: OWNER, state: initialState(), ...overrides,
  });
}
function assertPinned(state) {
  assert.equal(state.variant, 'long');
  assert.equal(state.botDifficulty, 'hard-neuro');
  assert.equal(state.analysis.difficulty, 'hard-neuro');
  assert.equal(state.analysis.botName, NAME);
  assert.equal(state.analysis.neuralModel.id, 'hard-neuro-448-v1');
  assert.equal(state.analysis.neuralModel.modelFingerprint, MODEL_FP);
  assert.equal(state.analysis.neuralModel.trainingGames, 448);
  assert.equal(state.analysis.neuralModel.trainingSteps, 35147);
  assert.equal(state.analysis.neuralModel.maxCandidates, 16);
  assert.equal(state.analysis.neuralModel.epsilon, 0);
  const pin = require('../scripts/build-long-neural-model').PIN;
  for (const [key, value] of Object.entries(pin)) assert.equal(state.analysis.neuralModel[key], value, key);
}

test('local API rejects short neuro games before creating a room, including a conflicting embedded variant', async () => {
  const player = guest('Short');
  assert.equal((await createRoom(player, 'NSHR-2222', { variant: 'short' })).status, 422);
  assert.equal((await createRoom(player, 'NSHR-2222', { state: initialState('hard-neuro', 'short') })).status, 422);
  const created = await createRoom(player, 'NSHR-2222');
  assert.equal(created.status, 201, created.body.error);
});

test('local API pins neural identity and archives final model metadata, decisions and complete history', async () => {
  const player = guest('Archive');
  const created = await createRoom(player, 'NEUR-2222');
  assert.equal(created.status, 201, created.body.error);
  assert.equal(created.body.room.guestName, NAME);
  const saved = await request(player, '/api/rooms/NEUR-2222/game');
  assertPinned(saved.body.state);
  const state = saved.body.state;
  state.phase = 'move';
  state.analysis.neuralModel = { id: 'arbitrary', modelFingerprint: 'forged' };
  state.analysis.neuralDecisions = [{ policy: 'hard-neuro', modelFingerprint: MODEL_FP, roll: '2:4', value: 0.55 }];
  state.history = [{ roll: '2:4', color: 'dark', at: new Date().toISOString() }];
  const update = await request(player, '/api/rooms/NEUR-2222/game', 'PUT', { state, version: 0, ownerToken: OWNER });
  assert.equal(update.status, 200, update.body.error);
  const refreshed = await request(player, '/api/rooms/NEUR-2222/game');
  assertPinned(refreshed.body.state);
  assert.equal(refreshed.body.state.analysis.neuralDecisions.length, 1);
  state.phase = 'over';
  state.winner = 'dark';
  state.resultType = 'normal';
  state.history.unshift({ resign: true, color: 'white', at: new Date().toISOString() });
  const finish = await request(player, '/api/rooms/NEUR-2222/game', 'PUT', { state, version: 1, ownerToken: OWNER });
  assert.equal(finish.status, 200, finish.body.error);
  const archive = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-state.json'), 'utf8')).archive.find(row => row.code === 'NEUR-2222');
  assert.ok(archive);
  assertPinned(archive.session.game);
  assert.equal(archive.session.game.history.length, 2);
  assert.equal(archive.session.game.analysis.neuralDecisions[0].modelFingerprint, MODEL_FP);
  assert.equal(archive.session.players.find(row => row.color === 'dark').name, NAME);
});

test('local API rejects changing an existing neuro game into short narde or another bot', async () => {
  const player = guest('Immutable');
  assert.equal((await createRoom(player, 'NNMM-2222')).status, 201);
  for (const state of [initialState('hard-neuro', 'short'), initialState('hard', 'long')]) {
    const update = await request(player, '/api/rooms/NNMM-2222/game', 'PUT', { state, version: 0, ownerToken: OWNER });
    assert.equal(update.status, 422);
  }
  const current = await request(player, '/api/rooms/NNMM-2222/game');
  assert.equal(current.body.version, 0);
  assertPinned(current.body.state);
  assert.equal((await createRoom(player, 'NNMM-2222', { difficulty: 'hard', state: initialState('hard') })).status, 409);
  assert.equal((await createRoom(player, 'NNMM-2222')).status, 200);
});

test('local API preserves existing hard identity and forbids upgrading that room into the neural policy', async () => {
  const player = guest('Legacy');
  const created = await createRoom(player, 'HARD-4444', {
    difficulty: 'hard', botName: 'Legacy custom hard', botRating: 1400, state: initialState('hard'),
  });
  assert.equal(created.status, 201, created.body.error);
  assert.equal(created.body.room.guestName, 'Legacy custom hard');
  const current = await request(player, '/api/rooms/HARD-4444/game');
  assert.equal(current.body.state.botDifficulty, 'hard');
  assert.equal(current.body.state.analysis.neuralModel, undefined);
  const update = await request(player, '/api/rooms/HARD-4444/game', 'PUT', { state: initialState(), version: 0, ownerToken: OWNER });
  assert.equal(update.status, 422);
  const unchanged = await request(player, '/api/rooms/HARD-4444/game');
  assert.equal(unchanged.body.version, 0);
  assert.equal(unchanged.body.state.botDifficulty, 'hard');
});

test('room client blocks short / malformed neuro variants before auth, RPC or API writes', async () => {
  for (const configured of [false, true]) {
    const fixture = loadRooms({ configured });
    await assert.rejects(fixture.rooms.ensureBotAnalysisRoom({ code: 'NSHR-3333', difficulty: 'hard-neuro', variant: 'short', state: initialState() }), error => error.status === 422);
    await assert.rejects(fixture.rooms.ensureBotAnalysisRoom({ code: 'NSHR-3333', difficulty: 'hard', variant: 'long', state: initialState('hard-neuro', 'short') }), error => error.status === 422);
    await assert.rejects(fixture.rooms.putGameState('NSHR-3333', initialState('hard-neuro', 'short')), error => error.status === 422);
    await assert.rejects(fixture.rooms.finishRoomGame('NSHR-3333', initialState('hard-neuro', 'short')), error => error.status === 422);
    assert.equal(fixture.clientLoads(), 0);
    assert.equal(fixture.requests.length, 0);
  }
});

test('room client API fallback and Supabase insertion preserve canonical bot name, 1500 rating and model metadata', async () => {
  for (const configured of [false, true]) {
    const fixture = loadRooms({ configured });
    const state = initialState();
    state.analysis.neuralDecisions = [{ policy: 'hard-neuro', value: 0.44 }];
    state.analysis.neuralModel = { deploymentLabel: 'additional adapter metadata', epsilon: 0.8 };
    const inputBefore = JSON.stringify(state);
    await fixture.rooms.ensureBotAnalysisRoom({ code: 'NNNS-3333', difficulty: 'hard-neuro', variant: 'long', botName: 'Spoof', botRating: 9999, state });
    assert.equal(JSON.stringify(state), inputBefore, 'caller state stays unchanged');
    const row = configured ? fixture.client.inserts[0] : fixture.requests[0].body;
    assert.equal(configured ? row.guest_name : row.botName, NAME);
    assert.equal(configured ? row.guest_rating : row.botRating, 1500);
    const persisted = configured ? row.game_state : row.state;
    assertPinned(persisted);
    assert.equal(persisted.analysis.neuralModel.deploymentLabel, 'additional adapter metadata');
    assert.equal(persisted.analysis.neuralDecisions.length, 1);
  }
});

test('neural completion omits legacy hard training-state RPC and skips legacy XP ingestion', async () => {
  const fixture = loadRooms({ configured: true });
  const state = initialState();
  state.phase = 'over';
  state.winner = 'dark';
  state.history = [{ resign: true, color: 'white' }];
  state.analysis.neuralDecisions = [{ policy: 'hard-neuro', modelFingerprint: MODEL_FP }];
  const result = await fixture.rooms.finishRoomGame('NFNN-3333', state, 0, { analysis: { botMemory: { decisions: ['must-not-ingest'] } } });
  assert.equal(result.trainingArchived, false);
  const call = fixture.client.rpcCalls.find(row => row.name === 'finish_room_game');
  assert.ok(call);
  assert.ok(!Object.hasOwn(call.args, 'p_training_state'));
  assertPinned(call.args.p_final_state);
  assert.equal(call.args.p_final_state.history.length, 1);
  const count = fixture.client.rpcCalls.length;
  const skipped = await fixture.rooms.archiveBotTrainingGame('NFNN-3333', state);
  assert.equal(skipped.reason, 'neural-analysis-separate');
  assert.equal(fixture.client.rpcCalls.length, count);
});

test('legacy hard completion still passes its unchanged training payload', async () => {
  const fixture = loadRooms({ configured: true });
  const state = initialState('hard');
  state.phase = 'over';
  state.winner = 'dark';
  const training = { ...copy(state), analysis: { difficulty: 'hard', botMemory: { decisions: [1] } } };
  await fixture.rooms.finishRoomGame('HARD-3333', state, 0, training);
  assert.deepEqual(fixture.client.rpcCalls[0].args.p_training_state, training);
  assert.equal(fixture.client.rpcCalls[0].args.p_final_state.analysis.neuralModel, undefined);
});

test('existing SQL archives all completed final-state JSON while legacy bot-training remains hard-only', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
  const functionBody = name => {
    const start = schema.lastIndexOf(`create or replace function public.${name}(`);
    assert.ok(start >= 0, name);
    return schema.slice(start, schema.indexOf('\n$$;', start));
  };
  const archive = functionBody('archive_finished_room_game');
  assert.match(archive, /final_state/);
  assert.match(archive, /\n\s+gs,/);
  assert.doesNotMatch(archive, /botDifficulty|difficulty/);
  assert.match(functionBody('archive_finished_bot_training_game'), /botDifficulty[^\n]*<> 'hard'/);
  const metadata = require('../scripts/build-long-neural-model').PIN;
  assert.equal(metadata.modelFingerprint, MODEL_FP);
});
