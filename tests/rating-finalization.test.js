const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadRating({
  failLocalWrite = false,
  profile = {},
  sessionUserId = 'user-1',
  respond = () => ({ data: { ok: true, delta: 12, rating: 1412, tier: 'Silver' }, error: null }),
} = {}) {
  const user = {
    id: 'user-1',
    name: 'warlord',
    nickname: 'warlord',
    rating: 1400,
    tier: 'Silver',
    ratingEligible: true,
    registered: true,
    guest: false,
    history: [{ resultKey: 'old', history: Array.from({ length: 300 }, (_, i) => ({ move: i })) }],
    ...profile,
  };
  const writes = [];
  const rpcCalls = [];
  const authCalls = [];
  const directWrites = [];
  const context = {
    window: {},
    console,
    Date,
    Math,
    JSON,
    fetch: async () => {
      directWrites.push('fetch');
      return { ok: false, json: async () => ({}) };
    },
  };
  context.window.window = context.window;
  context.window.NarduApp = {
    getUser: () => user,
    setUser: next => {
      if (failLocalWrite) throw new Error('QuotaExceededError');
      writes.push(JSON.parse(JSON.stringify(next)));
    },
    paintUser: () => {},
  };
  context.window.NarduSupabase = {
    configured: () => true,
    client: async () => ({
      auth: {
        async getUser() {
          authCalls.push('getUser');
          return { data: { user: { id: sessionUserId } }, error: null };
        },
        async getSession() {
          authCalls.push('getSession');
          return { data: { session: { user: { id: sessionUserId } } }, error: null };
        },
      },
      rpc: async (name, payload) => {
        rpcCalls.push({ name, payload });
        return respond();
      },
      from(table) {
        directWrites.push(table);
        throw new Error('Unexpected direct write');
      },
    }),
  };
  context.NarduApp = context.window.NarduApp;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'rating.js'), 'utf8'), context, { filename: 'rating.js' });
  return { rating: context.window.NarduRating, user, rpcCalls, writes, authCalls, directWrites };
}

test('a full localStorage cache cannot prevent the Timeweb rating RPC', async () => {
  const { rating, rpcCalls } = loadRating({ failLocalWrite: true });
  const result = rating.record('Hard bot', 1500, true, 'bot', 'room:win', {
    winner: 'white',
    history: Array.from({ length: 280 }, (_, i) => ({ move: i, sha256: `sha-${i}` })),
  });

  assert.ok(result);
  const authoritative = await result.syncPromise;
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'record_rating_result');
  assert.equal(rpcCalls[0].payload.p_history.length, 280);
  assert.equal(authoritative.delta, 12);
  assert.equal(authoritative.rating, 1412);
  assert.equal(authoritative.tier, 'Silver');
});

test('the browser cache stores compact matches while Timeweb receives full history', async () => {
  const { rating, rpcCalls, writes } = loadRating();
  const result = rating.record('Hard bot', 1500, false, 'bot', 'room:loss', {
    winner: 'dark',
    history: Array.from({ length: 240 }, (_, i) => ({ move: i, sha256: `sha-${i}` })),
  });
  assert.equal(result.authoritativePending, undefined);
  assert.equal(writes.length, 1);
  await result.syncPromise;

  assert.equal(writes[0].history[0].history, undefined);
  assert.equal(writes[0].history[0].historyCount, 240);
  assert.equal(writes[0].history[1].history, undefined);
  assert.equal(writes[0].history[1].historyCount, 300);
  assert.equal(rpcCalls[0].payload.p_history.length, 240);
});

const roomCode = 'BLTW-7E7Z';
const finishedAt = 1794750000000;
const resultKey = `${finishedAt}:white:normal`;
const newPlayer = { rating: 1000, tier: 'Bronze', history: [] };

function recordBotRoom(rating) {
  return rating.record('Hard bot', 1500, true, 'bot', resultKey, {
    winner: 'white',
    score: { roomCode, finalState: { phase: 'over', winner: 'white', finishedAt } },
    history: [{ from: 1, to: 'off', color: 'white' }],
    finishedAt: new Date(finishedAt).toISOString(),
  });
}

test('a fresh player gets only the server-confirmed rating for a win in a real bot room', async () => {
  let resolveRpc;
  const response = new Promise(resolve => { resolveRpc = resolve; });
  const { rating, user, rpcCalls, authCalls, writes, directWrites } = loadRating({
    profile: newPlayer,
    respond: () => response,
  });
  const result = recordBotRoom(rating);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(result.authoritativePending, true);
  assert.equal(result.rating, null);
  assert.equal(result.delta, 0);
  assert.equal(user.rating, 1000);
  assert.deepEqual(writes, []);
  assert.deepEqual(authCalls, ['getSession']);
  assert.equal(rpcCalls.length, 1);
  const [{ name, payload }] = rpcCalls;
  assert.equal(name, 'record_rating_result');
  assert.equal(payload.p_result_key, resultKey);
  assert.equal(payload.p_mode, 'bot');
  assert.equal(payload.p_did_win, true);
  assert.equal(payload.p_score.roomCode, roomCode);
  assert.equal(payload.p_score.finalState.finishedAt, finishedAt);

  resolveRpc({ data: { ok: true, delta: 19, rating: 1019, tier: 'Bronze' }, error: null });
  const confirmed = await result.syncPromise;
  assert.equal(confirmed.delta, 19);
  assert.equal(confirmed.rating, 1019);
  assert.ok(writes.every(profile => profile.rating === 1019));
  assert.equal(writes.at(-1).history[0].resultKey, resultKey);
  assert.equal(writes.at(-1).history[0].delta, 19);
  assert.deepEqual(directWrites, []);
});

test('a stale local identity cannot submit a guarded bot room rating', async () => {
  const { rating, rpcCalls, writes, directWrites } = loadRating({
    profile: newPlayer,
    sessionUserId: 'other-player',
  });
  assert.equal(await recordBotRoom(rating).syncPromise, null);
  assert.deepEqual(rpcCalls, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(directWrites, []);
});

test('malformed and rejected real bot room ratings do not update the local profile or fall back', async () => {
  for (const response of [
    { data: null, error: null },
    { data: { ok: true, rating: 1019 }, error: null },
    { data: { ok: true, delta: 19 }, error: null },
    { data: null, error: { code: 'PGRST202', message: 'Could not find the function record_rating_result' } },
  ]) {
    const { rating, rpcCalls, writes, directWrites } = loadRating({ profile: newPlayer, respond: () => response });
    assert.equal(await recordBotRoom(rating).syncPromise, null);
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(writes, []);
    assert.deepEqual(directWrites, []);
  }
});
