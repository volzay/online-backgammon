'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const Fair = require('../fair-dice.js');
const signingKey = '11'.repeat(32);
const publicKey = Fair.receiptPublicKey(signingKey);
const beacon = { round: 1000,
  signature: 'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39',
  randomness: 'fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd' };
const request = { id: '11111111-1111-4111-8111-111111111111', roomCode: 'ABCD-EFGH',
  gameId: '22222222-2222-4222-8222-222222222222', nonce: 1, label: 'opening', color: 'none',
  variant: 'long', round: 1000, createdAt: new Date(Fair.roundTime(1000) - 6000).toISOString(), positionHash: '22'.repeat(32) };
const copy = object => structuredClone(object);
const hash = text => createHash('sha256').update(text).digest('hex');

test('official quicknet mainnet round 1000 verifies with the pinned RFC9380 G1 scheme', async () => {
  assert.equal(await Fair.verifyBeacon(beacon, 1000), true);
  assert.equal(createHash('sha256').update(Buffer.from(beacon.signature, 'hex')).digest('hex'), beacon.randomness);
});
test('self-contained signed proof proves independent source and exact dice mapping', async () => {
  const receipt = Fair.signReservation(request, signingKey);
  assert.equal(receipt.requestHash, hash(Fair.canonicalRequest(request)));
  const proof = await Fair.createProof(receipt, beacon);
  const result = await Fair.verifyProof(proof, { publicKey, context: { roomCode: request.roomCode, gameId: request.gameId } });
  assert.equal(result.sourceVerified, true);
  assert.equal(result.reservationVerified, true);
  assert.equal(hash(result.input), result.hash);
  assert.notEqual(result.dice[0], result.dice[1]);
  assert.deepEqual(result.dice, proof.dice);
});
test('missing trusted receipt pin cannot claim a confirmed server reservation', async () => {
  const proof = await Fair.createProof(Fair.signReservation(request, signingKey), beacon);
  const result = await Fair.verifyProof(proof);
  assert.equal(result.sourceVerified, true);
  assert.equal(result.reservationVerified, false);
});
test('changing round and recomputing the randomness hash cannot forge BLS provenance', async () => {
  const altered = { ...beacon, round: 1001 };
  await assert.rejects(Fair.verifyBeacon(altered, 1001), { code: 'FAIR_BEACON_SIGNATURE_INVALID' });
});
test('well-formed forged signature with a matching SHA256 is not authenticated', async () => {
  const altered = { ...beacon, signature: 'aa'.repeat(48) };
  altered.randomness = createHash('sha256').update(Buffer.from(altered.signature, 'hex')).digest('hex');
  await assert.rejects(Fair.verifyBeacon(altered, 1000), { code: 'FAIR_BEACON_SIGNATURE_INVALID' });
});
test('every result-determining intent field is protected by the receipt', async () => {
  const proof = await Fair.createProof(Fair.signReservation(request, signingKey), beacon);
  for (const [field, value] of Object.entries({ id: '33333333-3333-4333-8333-333333333333', roomCode: 'BCDE-FGHJ',
    gameId: '33333333-3333-4333-8333-333333333333', nonce: 2, variant: 'short', positionHash: '33'.repeat(32),
    createdAt: new Date(Fair.roundTime(1000) - 9000).toISOString() })) {
    const altered = copy(proof); altered.request[field] = value;
    altered.requestHash = Fair.requestHash(altered.request);
    await assert.rejects(Fair.verifyProof(altered, { publicKey }), { code: 'FAIR_RECEIPT_INVALID' }, field);
  }
});
test('proof cannot switch chain, public key, expected room or recorded dice', async () => {
  const proof = await Fair.createProof(Fair.signReservation(request, signingKey), beacon);
  await assert.rejects(Fair.verifyProof({ ...proof, chainHash: '00'.repeat(32) }, { publicKey }), { code: 'FAIR_PROTOCOL_INVALID' });
  await assert.rejects(Fair.verifyProof(proof, { publicKey: '00'.repeat(32) }), { code: 'FAIR_RECEIPT_INVALID' });
  await assert.rejects(Fair.verifyProof(proof, { publicKey, context: { roomCode: 'BCDE-FGHJ' } }), { code: 'FAIR_CONTEXT_MISMATCH' });
  const changed = copy(proof); changed.dice[0] = changed.dice[0] === 6 ? 1 : 6;
  await assert.rejects(Fair.verifyProof(changed, { publicKey }), { code: 'FAIR_DICE_MISMATCH' });
});
test('canonicalization rejects ambiguous, malformed and non-future reservations', () => {
  for (const altered of [{ ...request, salt: 'choose-after-result' }, { ...request, nonce: 0 },
    { ...request, round: Number.MAX_SAFE_INTEGER + 1 }, { ...request, roomCode: 'ABCD|EFGH' },
    { ...request, createdAt: new Date(Fair.roundTime(1000)).toISOString() }, { ...request, color: 'white' }]) {
    assert.throws(() => Fair.canonicalRequest(altered));
  }
});
test('derivation is deterministic, uses both sides equally, and never calls Math.random', () => {
  const saved = Math.random;
  Math.random = () => { throw new Error('Browser or bot random generator used'); };
  try {
    for (const color of ['white', 'dark']) {
      const intent = { ...request, label: 'roll', color };
      const first = Fair.deriveDice(intent, beacon.randomness);
      assert.deepEqual(first, Fair.deriveDice(intent, beacon.randomness));
      const eligible = Buffer.from(first.hash, 'hex').filter(byte => byte < 252);
      assert.deepEqual(first.dice, [...eligible.subarray(0, 2)].map(byte => (byte % 6) + 1));
    }
  } finally { Math.random = saved; }
});
test('locally bundled browser verifier matches Node and performs real BLS, without relay network', async () => {
  const context = { TextEncoder, Uint8Array, DataView, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../fair-dice-crypto.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../fair-dice.js'), 'utf8'), context);
  const proof = await Fair.createProof(Fair.signReservation(request, signingKey), beacon);
  const browser = await context.NarduFairDice.verifyProof(copy(proof), { publicKey });
  assert.equal(browser.hash, proof.sha256);
  assert.equal(browser.sourceVerified, true);
  assert.equal(browser.reservationVerified, true);
});
