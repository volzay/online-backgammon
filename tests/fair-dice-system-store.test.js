'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SupabaseFairDiceStore } = require('../lib/fair-dice-supabase-store.js');

const CODE = 'SAFE-RQME';
const GAME = 'eb9acac4-7621-4106-976f-08dd288b6585';
const ID = 'ca2a6463-c2ba-4a9b-a0f0-000000000001';
const SEED = 'cd'.repeat(32);
const HASH = 'ef'.repeat(32);
const PLAYER = { authorization: 'Bearer player.test' };

function harness(roomOverride = {}) {
  const calls = [];
  const room = { roomCode: CODE, version: 2, gameId: GAME, state: { history: [] },
    serverPositionHash: HASH, fairDiceProtocol: 'system-csprng-v1',
    actor: { ownsHost: true, actorColor: 'white', bot: false }, pending: { request: { id: ID } }, ...roomOverride };
  const store = new SupabaseFairDiceStore({ url: 'https://backend.example', anonKey: 'anon.test',
    serviceRoleKey: 'secret.service.role', fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      return { ok: true, status: 200, json: async () => url.endsWith('/get_fair_dice_room')
        ? room : { request: { id: ID }, clientSeed: body.p_client_seed } };
    } });
  return { store, calls };
}

test('seed acceptance is a privileged narrow RPC after validating the exact player room access', async () => {
  const { store, calls } = harness();
  await store.getRoom(CODE, PLAYER);
  const result = await store.acceptClientSeed(ID, SEED, PLAYER);
  assert.equal(result.clientSeed, SEED);
  assert.equal(calls[1].url, 'https://backend.example/rest/v1/rpc/accept_system_fair_dice_client_seed');
  assert.deepEqual(calls[1].body, { p_request_id: ID, p_client_seed: SEED, p_room_code: CODE,
    p_game_id: GAME, p_position_hash: HASH });
  assert.equal(calls[1].init.headers.authorization, 'Bearer secret.service.role');
  assert.equal(calls[1].init.headers['x-guest-proof'], undefined);
  assert.equal(JSON.stringify(result).includes('secret.service.role'), false);
});

test('seed acceptance cannot use unvalidated credentials or a copied credentials object', async () => {
  const { store, calls } = harness();
  await assert.rejects(store.acceptClientSeed(ID, SEED, PLAYER), error => error.code === 'UNVALIDATED_ACTOR');
  await store.getRoom(CODE, PLAYER);
  await assert.rejects(store.acceptClientSeed(ID, SEED, { ...PLAYER }), error => error.code === 'UNVALIDATED_ACTOR');
  assert.equal(calls.length, 1);
});

test('seed acceptance cannot target a different pending request', async () => {
  const { store, calls } = harness();
  await store.getRoom(CODE, PLAYER);
  await assert.rejects(store.acceptClientSeed('ca2a6463-c2ba-4a9b-a0f0-000000000002', SEED, PLAYER),
    error => error.code === 'UNVALIDATED_ACTOR');
  assert.equal(calls.length, 1);
});

for (const seed of ['', 'a', 'Z'.repeat(64), SEED.toUpperCase(), null, [], {}]) {
  test('seed acceptance rejects invalid client seed ' + JSON.stringify(seed), async () => {
    const { store, calls } = harness();
    await store.getRoom(CODE, PLAYER);
    await assert.rejects(store.acceptClientSeed(ID, seed, PLAYER), error => error.code === 'INVALID_CLIENT_SEED');
    assert.equal(calls.length, 1);
  });
}

for (const override of [{ gameId: 'invalid' }, { serverPositionHash: 'invalid' }, { pending: null }]) {
  test('seed acceptance rejects incomplete authoritative binding ' + JSON.stringify(override), async () => {
    const { store, calls } = harness(override);
    await store.getRoom(CODE, PLAYER);
    await assert.rejects(store.acceptClientSeed(ID, SEED, PLAYER));
    assert.equal(calls.length, 1);
  });
}
