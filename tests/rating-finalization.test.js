const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadRating({ failLocalWrite = false } = {}) {
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
  };
  const writes = [];
  const rpcCalls = [];
  const context = {
    window: {},
    console,
    Date,
    Math,
    JSON,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
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
      auth: { getUser: async () => ({ data: { user: { id: user.id } }, error: null }) },
      rpc: async (name, payload) => {
        rpcCalls.push({ name, payload });
        return { data: { delta: 12, rating: 1412, tier: 'Silver' }, error: null };
      },
    }),
  };
  context.NarduApp = context.window.NarduApp;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'rating.js'), 'utf8'), context, { filename: 'rating.js' });
  return { rating: context.window.NarduRating, rpcCalls, writes };
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
  await result.syncPromise;

  assert.equal(writes[0].history[0].history, undefined);
  assert.equal(writes[0].history[0].historyCount, 240);
  assert.equal(writes[0].history[1].history, undefined);
  assert.equal(writes[0].history[1].historyCount, 300);
  assert.equal(rpcCalls[0].payload.p_history.length, 240);
});
