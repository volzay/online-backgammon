'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Fair = require('../fair-dice.js');
const prototype = require('../experiments/system-dice/protocol.js');
const cryptoEntry = require('../lib/fair-dice-crypto-entry.mjs');

const ROOT = path.join(__dirname, '..');
const privateKey = '11'.repeat(32);
const publicKey = Fair.receiptPublicKey(privateKey);
const serverSeed = '22'.repeat(32);
const clientSeed = '33'.repeat(32);
const plain = value => JSON.parse(JSON.stringify(value));
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const contextFields = ['gameId', 'nonce', 'roomCode', 'variant', 'label', 'color', 'positionHash'];

function requestFor(overrides = {}, seed = serverSeed) {
  const request = { id: '11111111-1111-4111-8111-111111111111', roomCode: 'ABCD-EFGH',
    gameId: '22222222-2222-4222-8222-222222222222', nonce: 1, label: 'roll', color: 'white',
    variant: 'long', commitment: '00'.repeat(32), createdAt: '2026-09-18T00:00:00.000Z',
    positionHash: '44'.repeat(32), ...overrides };
  const context = Object.fromEntries(contextFields.map(field => [field, request[field]]));
  request.commitment = prototype.commitmentFor(context, seed);
  return request;
}

function proofFor(overrides = {}, ownClientSeed = clientSeed) {
  return Fair.createSystemProof(Fair.signReservation(requestFor(overrides), privateKey), serverSeed, ownClientSeed);
}

function browserVerifier({ env = { fairDicePublicKey: publicKey }, cryptoApi = cryptoEntry } = {}) {
  const context = vm.createContext({ TextEncoder, Uint8Array, DataView, console, crypto: webcrypto,
    NarduFairDiceCrypto: cryptoApi, NARDU_ENV: env,
    fetch() { throw new Error('Verification must not contact a network source.'); },
    localStorage: new Proxy({}, { get() { throw new Error('Verification must not access account storage.'); } }) });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'fair-dice.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game-verifier.js'), 'utf8'), context);
  return context;
}

test('system receipt binds ten fields using its own JSON-array domain and the same Ed25519 trust pin', () => {
  const request = requestFor();
  const encoded = Fair.canonicalSystemRequest(request);
  assert.deepEqual(JSON.parse(encoded), ['nardu/system-csprng/v1', ...Object.values(request)]);
  assert.equal(encoded, Fair.canonicalRequest(request));
  const receipt = Fair.signReservation(request, privateKey);
  assert.equal(receipt.requestHash, hash(encoded));
  assert.equal(Fair.verifyReservation(receipt, publicKey, request), true);
  assert.equal(Fair.verifyReservation(receipt), false);
});

test('system commitment and HMAC derivation exactly match the tested prototype for both variants and purposes', () => {
  for (const variant of ['long', 'short']) for (const purpose of [{ label: 'opening', color: 'none' },
    { label: 'roll', color: 'white' }, { label: 'roll', color: 'dark' }]) {
    for (let nonce = 1; nonce <= 15; nonce += 1) {
      const request = requestFor({ variant, ...purpose, nonce });
      const expected = prototype.deriveProof({ context: Object.fromEntries(contextFields.map(field => [field, request[field]])),
        privateSeed: serverSeed, clientSeed, commitment: request.commitment });
      const actual = Fair.deriveSystemDice(request, serverSeed, clientSeed);
      assert.equal(Fair.systemCommitment(request, serverSeed), request.commitment);
      assert.deepEqual(actual.dice, expected.dice);
      assert.deepEqual(actual.blocks, expected.blocks);
      assert.equal(actual.counter, expected.counter);
      assert.equal(hash(actual.input), actual.hash);
    }
  }
});

test('system proof verifies calculation and commitment without falsely claiming independent entropy or publication timing', async () => {
  const proof = proofFor();
  const actual = await Fair.verifyProof(proof, { publicKey, context: proof.request, clientSeed, commitment: proof.request.commitment });
  assert.equal(actual.reservationVerified, true);
  assert.equal(actual.commitmentVerified, true);
  assert.equal(actual.sourceVerified, false);
  assert.equal(actual.independentSourceVerified, false);
  assert.equal(actual.entropyVerified, false);
  assert.equal(actual.priorPublicationVerified, false);
  assert.equal(actual.clientSeedPinned, true);
  assert.equal(actual.commitmentPinned, true);
  assert.deepEqual(actual.dice, proof.dice);
  assert.equal(actual.hash, proof.sha256);
  const withoutPin = await Fair.verifyProof(proof);
  assert.equal(withoutPin.reservationVerified, false);
  assert.equal(withoutPin.commitmentVerified, true);
});

const requestTamper = { id: '33333333-3333-4333-8333-333333333333', roomCode: 'BCDE-FGHJ',
  gameId: '33333333-3333-4333-8333-333333333333', nonce: 2, label: 'opening', color: 'dark',
  variant: 'short', commitment: '55'.repeat(32), createdAt: '2026-09-18T00:00:01.000Z', positionHash: '66'.repeat(32) };

for (const [field, value] of Object.entries(requestTamper)) {
  test(`system pinned external ${field} cannot be replaced by proof-local values`, async () => {
    const proof = proofFor();
    await assert.rejects(Fair.verifyProof(proof, { publicKey, context: { [field]: value } }), { code: 'FAIR_CONTEXT_MISMATCH' });
  });
  test(`system receipt signature prevents changing ${field} even after recomputing its request hash`, async () => {
    const proof = proofFor();
    proof.request[field] = value;
    // Purpose fields need their corresponding valid counterpart for canonicalization.
    if (field === 'label') proof.request.color = 'none';
    proof.requestHash = Fair.requestHash(proof.request);
    await assert.rejects(Fair.verifyProof(proof, { publicKey }), { code: 'FAIR_RECEIPT_INVALID' });
  });
}

for (const [name, change, code] of [
  ['server seed', proof => { proof.commitReveal.serverSeed = '77'.repeat(32); }, 'FAIR_SYSTEM_COMMITMENT_MISMATCH'],
  ['client seed', proof => { proof.commitReveal.clientSeed = '77'.repeat(32); }, 'FAIR_DICE_MISMATCH'],
  ['dice', proof => { proof.dice[0] = proof.dice[0] === 6 ? 1 : 6; }, 'FAIR_DICE_MISMATCH'],
  ['stream', proof => { proof.commitReveal.blocks[0] = '77'.repeat(32); }, 'FAIR_DICE_MISMATCH'],
  ['extra stream block', proof => { proof.commitReveal.blocks.push('77'.repeat(32)); }, 'FAIR_SYSTEM_PROOF_INVALID'],
  ['counter', proof => { proof.commitReveal.counter += 1; }, 'FAIR_DICE_MISMATCH'],
  ['rerolls', proof => { proof.rerolls += 1; }, 'FAIR_DICE_MISMATCH'],
  ['input', proof => { proof.sha256Input += ' '; proof.sha256 = hash(proof.sha256Input); }, 'FAIR_DICE_MISMATCH'],
  ['hash', proof => { proof.sha256 = '77'.repeat(32); }, 'FAIR_DICE_MISMATCH'],
  ['replacement public key', proof => { proof.publicKey = publicKey; }, 'FAIR_SYSTEM_PROOF_INVALID'],
  ['unexpected reveal field', proof => { proof.commitReveal.timingVerified = true; }, 'FAIR_SYSTEM_PROOF_INVALID'],
  ['sparse dice', proof => { proof.dice = new Array(2); }, 'FAIR_SYSTEM_PROOF_INVALID'],
  ['sparse stream', proof => { proof.commitReveal.blocks = new Array(1); }, 'FAIR_SYSTEM_PROOF_INVALID'],
  ['out-of-range seed', proof => { proof.commitReveal.clientSeed = 'ff'.repeat(33); }, 'FAIR_SYSTEM_SEED_INVALID'],
]) {
  test(`system proof rejects altered ${name} without an alternate-source fallback`, async () => {
    const proof = proofFor();
    change(proof);
    await assert.rejects(Fair.verifyProof(proof, { publicKey }), { code });
  });
}

test('proof cannot override the external client contribution, commitment or trusted Ed25519 key', async () => {
  const proof = proofFor();
  await assert.rejects(Fair.verifyProof(proof, { publicKey, clientSeed: '77'.repeat(32) }), { code: 'FAIR_CONTEXT_MISMATCH' });
  await assert.rejects(Fair.verifyProof(proof, { publicKey, commitment: '77'.repeat(32) }), { code: 'FAIR_CONTEXT_MISMATCH' });
  await assert.rejects(Fair.verifyProof(proof, { publicKey: Fair.receiptPublicKey('88'.repeat(32)) }), { code: 'FAIR_RECEIPT_INVALID' });
});

test('system requests reject ambiguous fields, getters, noncanonical dates and mixed-protocol fields', () => {
  const request = requestFor();
  const getter = { ...request };
  Object.defineProperty(getter, 'nonce', { enumerable: true, get() { throw new Error('Getter was invoked.'); } });
  for (const altered of [{ ...request, round: 1000 }, { ...request, nonce: 0 }, { ...request, commitment: null },
    { ...request, createdAt: '2026-09-18' }, { ...request, createdAt: 0 }, { ...request, roomCode: { toString: () => request.roomCode } }, getter]) {
    assert.throws(() => Fair.canonicalSystemRequest(altered), { code: 'FAIR_REQUEST_INVALID' });
  }
});

test('a system proof cannot disguise itself as quicknet or downgrade to an unknown protocol', async () => {
  const proof = proofFor();
  await assert.rejects(Fair.verifyProof({ ...proof, protocol: Fair.PROTOCOL }), { code: 'FAIR_PROTOCOL_INVALID' });
  await assert.rejects(Fair.verifyProof({ ...proof, protocol: 'unknown', chainHash: Fair.CHAIN.hash }), { code: 'FAIR_PROTOCOL_INVALID' });
});

test('ordinary doubles are preserved and opening ties use only the earliest deterministic counter', async () => {
  let foundDouble = false;
  let foundOpeningTie = false;
  for (let index = 0; index < 100; index += 1) {
    const ownSeed = index.toString(16).padStart(64, '0');
    const ordinary = proofFor({}, ownSeed);
    if (ordinary.dice[0] === ordinary.dice[1]) {
      foundDouble = true;
      assert.equal(ordinary.rerolls, 0);
    }
    const opening = proofFor({ label: 'opening', color: 'none' }, ownSeed);
    if (opening.rerolls > 0) {
      foundOpeningTie = true;
      assert.notEqual(opening.dice[0], opening.dice[1]);
      const checked = await Fair.verifyProof(opening, { publicKey });
      assert.equal(checked.counter, opening.rerolls);
      const changed = clone(opening);
      changed.commitReveal.counter += 1;
      await assert.rejects(Fair.verifyProof(changed, { publicKey }), { code: 'FAIR_DICE_MISMATCH' });
    }
    if (foundDouble && foundOpeningTie) break;
  }
  assert.equal(foundDouble && foundOpeningTie, true);
});

test('system HMAC maps accepted bytes and deterministically fails closed on exhausted bytes without Math.random', () => {
  const saved = Math.random;
  Math.random = () => { throw new Error('Math.random was used.'); };
  try {
    const browser = browserVerifier({ cryptoApi: { ...cryptoEntry, hmacSha256: () => 'fcfdfeff0005' + 'ff'.repeat(26) } });
    assert.deepEqual(plain(browser.NarduFairDice.deriveSystemDice(requestFor(), serverSeed, clientSeed).dice), [1, 6]);
    const exhausted = browserVerifier({ cryptoApi: { ...cryptoEntry, hmacSha256: () => 'ff'.repeat(32) } });
    assert.throws(() => exhausted.NarduFairDice.deriveSystemDice(requestFor(), serverSeed, clientSeed), { code: 'FAIR_DERIVATION_EXHAUSTED' });
  } finally { Math.random = saved; }
});

test('browser core and read-only verifier validate system HMAC locally and do not relabel server entropy as independent', async () => {
  const browser = browserVerifier();
  const proof = proofFor();
  const result = await browser.NarduVerify.verifyFairRoll({ proof: JSON.stringify(proof), expectedDice: proof.dice,
    hash: proof.sha256, preimage: proof.sha256Input, context: proof.request });
  assert.equal(result.status, 'verified');
  assert.equal(result.sourceVerified, false);
  assert.equal(result.commitmentVerified, true);
  assert.equal(result.reservationVerified, true);
  assert.equal(result.independentSourceVerified, false);
  assert.match(result.warning, /не является независимым/);
  const missingPin = browserVerifier({ env: {} });
  assert.equal((await missingPin.NarduVerify.verifyFairRoll({ proof })).status, 'incomplete');
});

function historyItem(proof) {
  return { ...(proof.request.label === 'opening' ? { opening: true, host: proof.dice[0], guest: proof.dice[1] }
    : { color: proof.request.color, roll: proof.dice.join(':') }),
  sha256: proof.sha256, sha256Input: proof.sha256Input, fairDiceProof: proof };
}

test('whole-game system verification distinguishes commitments from independent source signatures and enforces the nonce sequence', async () => {
  const browser = browserVerifier();
  const game = { roomCode: 'ABCD-EFGH', variant: 'long', history: [historyItem(proofFor({ nonce: 2 })),
    historyItem(proofFor({ label: 'opening', color: 'none' }))] };
  const result = await browser.NarduVerify.verifyGameRolls(game);
  assert.equal(result.status, 'verified');
  assert.deepEqual(plain(result.sourceCounts), { signed: 2, sourceVerified: 0, reservationVerified: 2, system: 2, commitmentVerified: 2 });
  const changed = clone(game);
  changed.history.reverse();
  assert.equal((await browser.NarduVerify.verifyGameRolls(changed)).status, 'mismatch');
  const tampered = clone(game);
  tampered.history[0].fairDiceProof.commitReveal.serverSeed = '77'.repeat(32);
  assert.equal((await browser.NarduVerify.verifyGameRolls(tampered)).status, 'mismatch');
});

test('system standalone links identify the HMAC protocol without putting seeds or receipt JSON in a URL', () => {
  const browser = browserVerifier();
  const proof = proofFor();
  const url = browser.NarduVerify.verificationUrl(historyItem(proof));
  assert.match(url, /&protocol=system-csprng-v1$/);
  assert.doesNotMatch(url, /\?|serverSeed|clientSeed|commitment|request|%7B/);
  assert.equal(url.includes(serverSeed), false);
  assert.equal(url.includes(clientSeed), false);
});
