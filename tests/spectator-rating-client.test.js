const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'rating.js'), 'utf8');

function ratingHarness(rpcResult) {
  let user = {
    id: 'tester1-id', name: 'tester1', nickname: 'tester1',
    rating: 1400, tier: 'Silver', ratingEligible: true,
    registered: true, guest: false, history: [],
  };
  const writes = [];
  const calls = [];
  const app = {
    getUser: () => user,
    setUser: next => { user = next; writes.push(JSON.parse(JSON.stringify(next))); },
    paintUser: () => {},
  };
  const context = {
    window: { NarduApp: app, NarduSupabase: {
      configured: () => true,
      client: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: user.id } }, error: null }) },
        rpc: async (name, payload) => { calls.push({ name, payload }); return rpcResult; },
        from: () => { throw new Error('remote rating must not use direct profile/event fallback'); },
      }),
    } },
    NarduApp: app,
    console: { warn: () => {} },
    Date,
    Math,
    JSON,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { rating: context.window.NarduRating, user: () => user, writes, calls };
}

test('Q3PL spectator-style remote result denied by server leaves no local +1 or match', async () => {
  const harness = ratingHarness({ data: null, error: { status: 403, message: 'Only room players may record a rating.' } });
  const result = harness.rating.record('warlord', 1400, true, 'remote', 'Q3PL-result', {
    winner: 'white', score: { roomCode: 'Q3PL-JF26' },
  });
  assert.equal(harness.user().rating, 1400);
  assert.deepEqual(harness.user().history, []);
  assert.equal(result.authoritativePending, true);

  assert.equal(await result.syncPromise, null);
  assert.equal(harness.user().rating, 1400);
  assert.deepEqual(harness.user().history, []);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.calls.length, 1);
});

test('participant remote result appears only after the guarded RPC confirms it', async () => {
  const harness = ratingHarness({ data: { delta: 12, rating: 1412, tier: 'Silver' }, error: null });
  const result = harness.rating.record('warlord', 1400, true, 'remote', 'Q3PL-player-result', {
    winner: 'white', score: { roomCode: 'Q3PL-JF26' },
  });
  assert.equal(harness.user().rating, 1400);
  assert.deepEqual(harness.user().history, []);

  const confirmed = await result.syncPromise;
  assert.equal(confirmed.delta, 12);
  assert.equal(harness.user().rating, 1412);
  assert.equal(harness.user().history[0].resultKey, 'Q3PL-player-result');
  assert.equal(harness.user().history[0].history, undefined);
  assert.equal(harness.calls[0].name, 'record_rating_result');
});
