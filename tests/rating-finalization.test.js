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
  lookup,
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
        if (table === 'rating_events' && lookup) {
          const filters = {};
          return {
            select(columns) { assert.equal(columns, 'result_key'); return this; },
            eq(field, value) { filters[field] = value; return this; },
            async maybeSingle() { return lookup(filters); },
          };
        }
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

function recordBotRoom(rating, onlyIfMissing = false) {
  return rating.record('Hard bot', 1500, true, 'bot', resultKey, {
    winner: 'white',
    onlyIfMissing,
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
  assert.equal(name, 'record_saved_bot_rating');
  assert.equal(payload.p_result_key, resultKey);
  assert.equal(payload.p_room_code, roomCode);
  assert.deepEqual(Object.keys(payload).sort(), ['p_result_key', 'p_room_code']);

  resolveRpc({ data: { ok: true, delta: 19, rating: 1019, tier: 'Bronze' }, error: null });
  const confirmed = await result.syncPromise;
  assert.equal(confirmed.delta, 19);
  assert.equal(confirmed.rating, 1019);
  assert.ok(writes.every(profile => profile.rating === 1019));
  assert.equal(writes.at(-1).history[0].resultKey, resultKey);
  assert.equal(writes.at(-1).history[0].delta, 19);
  assert.deepEqual(directWrites, []);
});

test('a saved bot award sends only selectors even when analysis and history exceed a megabyte', async () => {
  const { rating, rpcCalls } = loadRating({ profile: newPlayer });
  const score = {
    roomCode,
    finalState: {
      phase: 'over', winner: 'white', finishedAt,
      analysis: { botMemory: { decisions: Array.from({ length: 40 }, (_, index) => ({
        index, diagnostic: 'x'.repeat(32768),
      })) } },
    },
  };
  const history = Array.from({ length: 500 }, (_, index) => ({ index, proof: 'y'.repeat(1024) }));
  assert.ok(Buffer.byteLength(JSON.stringify({ score, history })) > 1024 * 1024);

  const confirmed = await rating.record('Hard bot', 1500, true, 'bot', resultKey, {
    winner: 'white', score, history,
  }).syncPromise;

  assert.equal(confirmed.rating, 1412);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'record_saved_bot_rating');
  const wire = JSON.stringify(rpcCalls[0].payload);
  assert.deepEqual(JSON.parse(wire), { p_room_code: roomCode, p_result_key: resultKey });
  assert.ok(Buffer.byteLength(wire) < 128);
  for (const field of ['history', 'analysis', 'finalState', 'opponent', 'did_win']) {
    assert.equal(wire.includes(field), false, field);
  }
});

test('a compact bot result preserves its total history count without storing the journal', async () => {
  const { rating, rpcCalls, writes } = loadRating({ profile: {
    ...newPlayer,
    history: [{ resultKey: 'previous-compact-result', history: [], historyCount: 300 }],
  } });
  const confirmed = await rating.record('Hard bot', 1500, true, 'bot', resultKey, {
    winner: 'white',
    score: { roomCode, finalState: { finishedAt } },
    history: [],
    historyCount: 280,
  }).syncPromise;

  assert.equal(confirmed.rating, 1412);
  assert.equal(rpcCalls[0].name, 'record_saved_bot_rating');
  const history = writes.at(-1).history;
  assert.equal(history[0].history, undefined);
  assert.equal(history[0].historyCount, 280);
  assert.equal(history[1].history, undefined);
  assert.equal(history[1].historyCount, 300);
  assert.ok(Buffer.byteLength(JSON.stringify(history[0])) < 1024);
});

test('retrying a saved award uses the same selectors and only the confirmed server rating', async () => {
  let attempts = 0;
  const { rating, user, rpcCalls, writes, directWrites } = loadRating({
    profile: newPlayer,
    respond: () => ++attempts === 1
      ? { data: null, error: { code: 'TIMEOUT', message: 'The response was interrupted.' } }
      : { data: { ok: true, duplicate: true, delta: 19, rating: 1019, tier: 'Bronze' }, error: null },
  });

  assert.equal(await recordBotRoom(rating).syncPromise, null);
  assert.equal(user.rating, 1000);
  assert.deepEqual(writes, []);

  const confirmed = await recordBotRoom(rating).syncPromise;
  assert.equal(confirmed.delta, 19);
  assert.equal(confirmed.rating, 1019);
  assert.equal(rpcCalls.length, 2);
  assert.ok(rpcCalls.every(call => call.name === 'record_saved_bot_rating'));
  assert.equal(JSON.stringify(rpcCalls[0].payload), JSON.stringify(rpcCalls[1].payload));
  assert.ok(writes.every(profile => profile.rating === 1019));
  assert.equal(writes.at(-1).history[0].delta, 19);
  assert.equal(writes.at(-1).history[0].ratingAfter, 1019);
  assert.equal(writes.at(-1).history.filter(match => match.resultKey === resultKey).length, 1);
  assert.deepEqual(directWrites, []);
});

test('two-player rooms retain the participant-checked RPC and its complete result payload', async () => {
  const { rating, rpcCalls } = loadRating();
  const score = { roomCode, finalState: { phase: 'over', winner: 'white', finishedAt } };
  const history = [{ color: 'white', from: 1, to: 'off' }];
  await rating.record('Opponent', 1400, true, 'remote', resultKey, {
    winner: 'white', score, history,
  }).syncPromise;

  assert.equal(rpcCalls.length, 1);
  const [{ name, payload }] = rpcCalls;
  assert.equal(name, 'record_rating_result');
  assert.equal(payload.p_mode, 'remote');
  assert.equal(payload.p_score.roomCode, roomCode);
  assert.equal(payload.p_score.finalState.finishedAt, finishedAt);
  assert.equal(JSON.stringify(payload.p_history), JSON.stringify(history));
});

test('returning from a finished room repairs only a missing award', async () => {
  for (const existing of [true, false]) {
    const { rating, writes, rpcCalls } = loadRating({
      lookup: filters => {
        assert.deepEqual(filters, { user_id: 'user-1', result_key: resultKey });
        return { data: existing ? { result_key: resultKey } : null, error: null };
      },
    });
    const result = await recordBotRoom(rating, true).syncPromise;
    assert.equal(rpcCalls.length, existing ? 0 : 1);
    if (existing) {
      assert.equal(result, null);
      assert.deepEqual(writes, []);
    } else {
      assert.equal(result.rating, 1412);
      assert.equal(rpcCalls[0].name, 'record_saved_bot_rating');
      assert.equal(rpcCalls[0].payload.p_result_key, resultKey);
    }
  }
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
    { data: null, error: { code: 'PGRST202', message: 'Could not find the function record_saved_bot_rating' } },
  ]) {
    const { rating, rpcCalls, writes, directWrites } = loadRating({ profile: newPlayer, respond: () => response });
    assert.equal(await recordBotRoom(rating).syncPromise, null);
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(writes, []);
    assert.deepEqual(directWrites, []);
  }
});
