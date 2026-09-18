'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const Dice = require('../experiments/system-dice/protocol.js');

const context = { gameId: '11111111-1111-4111-8111-111111111111', nonce: 1,
  roomCode: 'ABCD-EFGH', variant: 'long', label: 'roll', color: 'white', positionHash: '22'.repeat(32) };
const privateSeed = '11'.repeat(32);
const clientSeed = '33'.repeat(32);
const commitment = Dice.commitmentFor(context, privateSeed);
const expected = { context, commitment, clientSeed };
const input = { context, privateSeed, clientSeed, commitment };
const clone = value => structuredClone(value);
const bare = value => Object.assign(Object.create(null), value);
const assertCode = (fn, code) => assert.throws(fn, error => error.code === code && error.message === code);
const hexSeed = value => value.toString(16).padStart(64, '0');

function manualBlock(intent, client, counter, block = 0) {
  const canonical = JSON.stringify(['nardu/system-dice/v1', intent.gameId, intent.nonce,
    intent.roomCode, intent.variant, intent.label, intent.color, intent.positionHash]);
  return crypto.createHmac('sha256', Buffer.from(privateSeed, 'hex'))
    .update(JSON.stringify(['nardu/system-dice-hmac/v1', canonical, client, counter, block]), 'utf8').digest();
}

function isolatedCrypto(overrides) {
  const sandbox = { module: { exports: {} }, Buffer,
    require(name) {
      assert.equal(name, 'node:crypto');
      return { ...crypto, ...overrides };
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../experiments/system-dice/protocol.js'), 'utf8'), sandbox);
  return sandbox.module.exports;
}

test('canonical intent is unambiguous and ignores object insertion order', () => {
  assert.equal(Dice.canonicalContext(context), '["nardu/system-dice/v1","11111111-1111-4111-8111-111111111111",1,"ABCD-EFGH","long","roll","white","2222222222222222222222222222222222222222222222222222222222222222"]');
  const reordered = Object.fromEntries(Object.entries(context).reverse());
  assert.equal(Dice.canonicalContext(reordered), Dice.canonicalContext(context));
  assert.equal(Dice.canonicalContext(bare(context)), Dice.canonicalContext(context));
  assert.equal(Dice.canonicalContext(Object.freeze(clone(context))), Dice.canonicalContext(context));
});

test('known commitment and HMAC vectors agree with an independent implementation', () => {
  assert.equal(commitment, '4b987631ec5b3c231e0477df7b4556f001471df0b0cde76f0cce4ea4d54bdb91');
  const proof = Dice.deriveProof(input);
  assert.equal(proof.blocks[0], 'bf1fe18a8ef3120478336a9c2678b2c7a543246cefe510239b64827e12023281');
  assert.equal(proof.blocks[0], manualBlock(context, clientSeed, 0).toString('hex'));
  assert.deepEqual(proof.dice, [6, 2]);
  const raw = manualBlock(context, clientSeed, 0);
  assert.deepEqual(proof.dice, [...raw].filter(byte => byte < 252).slice(0, 2).map(byte => (byte % 6) + 1));
});

test('generated server and client seeds use exactly 32 operating-system random bytes', () => {
  const sizes = [];
  const isolated = isolatedCrypto({ randomBytes(size) { sizes.push(size); return Buffer.alloc(size, sizes.length); } });
  const record = isolated.createCommitment(bare(context));
  assert.equal(record.privateSeed, '01'.repeat(32));
  assert.equal(record.commitment, Dice.commitmentFor(context, record.privateSeed));
  assert.equal(isolated.randomClientSeed(), '02'.repeat(32));
  assert.deepEqual(sizes, [32, 32]);
  assertCode(() => isolated.createCommitment(bare({ ...context, nonce: 0 })), 'SYSTEM_DICE_CONTEXT_INVALID');
  assert.deepEqual(sizes, [32, 32], 'invalid context must be rejected before obtaining entropy');
});

test('actual local seed API has the fixed lower-case hex encoding', () => {
  const record = Dice.createCommitment(context);
  assert.match(record.privateSeed, /^[0-9a-f]{64}$/);
  assert.match(record.commitment, /^[0-9a-f]{64}$/);
  assert.equal(record.commitment, Dice.commitmentFor(context, record.privateSeed));
  assert.match(Dice.randomClientSeed(), /^[0-9a-f]{64}$/);
});

test('verification requires external expected commitment, client seed and full context', () => {
  const proof = Dice.deriveProof(input);
  assertCode(() => Dice.verifyProof(proof), 'SYSTEM_DICE_EXPECTED_REQUIRED');
  assertCode(() => Dice.verifyProof(proof, {}), 'SYSTEM_DICE_EXPECTED_REQUIRED');
  assertCode(() => Dice.verifyProof(proof, { context, commitment }), 'SYSTEM_DICE_EXPECTED_REQUIRED');
  const result = Dice.verifyProof(JSON.parse(JSON.stringify(proof)), expected);
  assert.deepEqual(result, { verified: true, commitmentVerified: true, protocol: 'nardu/system-dice/v1',
    dice: [6, 2], counter: 0, intendedRandomnessSource: 'system-csprng', entropyVerified: false,
    priorPublicationVerified: false, independentSourceVerified: false });
  result.dice[0] = 1;
  assert.deepEqual(proof.dice, [6, 2]);
});

test('all result-determining context values change the commitment and cannot be transplanted', () => {
  const proof = Dice.deriveProof(input);
  for (const [field, value] of Object.entries({
    gameId: '22222222-2222-4222-8222-222222222222', nonce: 2, roomCode: 'BCDE-FGHJ',
    variant: 'short', color: 'dark', positionHash: '44'.repeat(32),
  })) {
    const intent = { ...context, [field]: value };
    assert.notEqual(Dice.commitmentFor(intent, privateSeed), commitment, field);
    assertCode(() => Dice.verifyProof(proof, { ...expected, context: intent }), 'SYSTEM_DICE_CONTEXT_MISMATCH');
    assertCode(() => Dice.deriveProof({ ...input, context: intent }), 'SYSTEM_DICE_COMMITMENT_MISMATCH');
  }
  const opening = { ...context, label: 'opening', color: 'none' };
  assert.notEqual(Dice.commitmentFor(opening, privateSeed), commitment);
  assertCode(() => Dice.verifyProof(proof, { ...expected, context: opening }), 'SYSTEM_DICE_CONTEXT_MISMATCH');
});

test('replacing revealed seed, expected commitment or either client seed is rejected', () => {
  const proof = Dice.deriveProof(input);
  assertCode(() => Dice.verifyProof({ ...proof, serverSeed: 'aa'.repeat(32) }, expected), 'SYSTEM_DICE_COMMITMENT_MISMATCH');
  assertCode(() => Dice.verifyProof(proof, { ...expected, commitment: 'aa'.repeat(32) }), 'SYSTEM_DICE_COMMITMENT_MISMATCH');
  assertCode(() => Dice.verifyProof({ ...proof, clientSeed: 'aa'.repeat(32) }, expected), 'SYSTEM_DICE_CLIENT_SEED_MISMATCH');
  assertCode(() => Dice.verifyProof(proof, { ...expected, clientSeed: 'aa'.repeat(32) }), 'SYSTEM_DICE_CLIENT_SEED_MISMATCH');
  assert.notDeepEqual(Dice.deriveProof({ ...input, clientSeed: 'aa'.repeat(32) }), proof);
});

test('changing a public commitment together with server seed cannot override the external pin', () => {
  const changedSeed = 'aa'.repeat(32);
  const changed = Dice.deriveProof({ ...input, privateSeed: changedSeed,
    commitment: Dice.commitmentFor(context, changedSeed) });
  assertCode(() => Dice.verifyProof(changed, expected), 'SYSTEM_DICE_COMMITMENT_MISMATCH');
});

test('ordinary doubles are retained and the verifier cannot select another counter', () => {
  const client = hexSeed(9);
  const proof = Dice.deriveProof({ ...input, clientSeed: client });
  assert.deepEqual(proof.dice, [4, 4]);
  assert.equal(proof.counter, 0);
  assert.equal(Dice.verifyProof(proof, { ...expected, clientSeed: client }).verified, true);
  const later = manualBlock(context, client, 1);
  const selected = { ...proof, counter: 1, blocks: [later.toString('hex')],
    dice: [...later].filter(byte => byte < 252).slice(0, 2).map(byte => (byte % 6) + 1) };
  assertCode(() => Dice.verifyProof(selected, { ...expected, clientSeed: client }), 'SYSTEM_DICE_COUNTER_MISMATCH');
});

test('opening ties advance a fixed deterministic counter, not a fresh random seed', () => {
  const opening = { ...context, label: 'opening', color: 'none' };
  const client = hexSeed(0);
  const intent = { context: opening, privateSeed, clientSeed: client, commitment: Dice.commitmentFor(opening, privateSeed) };
  const initial = Dice.diceFromBytes(manualBlock(opening, client, 0));
  assert.equal(initial[0], initial[1]);
  const proof = Dice.deriveProof(intent);
  assert.equal(proof.counter, 1);
  assert.deepEqual(proof.dice, [1, 4]);
  assert.deepEqual(proof.blocks, ['a803c70fdf099cb35c2eb84b542d56827cd13cfc1aa24e2aa517a5a9e9fe0da9']);
  assert.deepEqual(Dice.deriveProof(intent), proof);
  assert.equal(Dice.verifyProof(proof, { context: opening, clientSeed: client, commitment: intent.commitment }).verified, true);
});

test('two consecutive opening ties are replayed and skipped exactly', () => {
  const opening = { ...context, label: 'opening', color: 'none' };
  const client = hexSeed(9);
  const intent = { context: opening, privateSeed, clientSeed: client, commitment: Dice.commitmentFor(opening, privateSeed) };
  for (const counter of [0, 1]) {
    const dice = Dice.diceFromBytes(manualBlock(opening, client, counter));
    assert.equal(dice[0], dice[1]);
  }
  const proof = Dice.deriveProof(intent);
  assert.equal(proof.counter, 2);
  assert.deepEqual(proof.dice, [5, 3]);
  assert.equal(Dice.verifyProof(proof, { context: opening, clientSeed: client, commitment: intent.commitment }).verified, true);
});

test('rejection mapping skips 252..255 instead of introducing modulo bias', () => {
  assert.deepEqual(Dice.diceFromBytes(Uint8Array.from([252, 253, 254, 255, 251, 0])), [6, 1]);
  assert.deepEqual(Dice.diceFromBytes(Uint8Array.from([252, 253, 254, 255])), []);
  assert.deepEqual(Dice.diceFromBytes(Uint8Array.from([252, 0, 255])), [1]);
  assertCode(() => Dice.diceFromBytes([0, 1]), 'SYSTEM_DICE_BYTES_INVALID');
  assertCode(() => Dice.diceFromBytes(new Uint8Array(513)), 'SYSTEM_DICE_BYTES_INVALID');
});

test('all 36 ordered pairs have exactly equal accepted-byte preimage counts', () => {
  const counts = new Map();
  for (let first = 0; first < 252; first += 1) {
    for (let second = 0; second < 252; second += 1) {
      const pair = Dice.diceFromBytes(Uint8Array.from([first, second])).join(':');
      counts.set(pair, (counts.get(pair) || 0) + 1);
    }
  }
  assert.equal(counts.size, 36);
  for (const count of counts.values()) assert.equal(count, 42 * 42);
  // This proves the mapping's lack of bias, not that observed source entropy is random.
});

test('byte-stream extension handles rejected hashes and cross-block accepted bytes', () => {
  let calls = 0;
  const isolated = isolatedCrypto({ createHmac() {
    return { update() { return this; }, digest() {
      calls += 1;
      if (calls === 1) return Buffer.alloc(32, 255);
      if (calls === 2) { const bytes = Buffer.alloc(32, 255); bytes[31] = 1; return bytes; }
      return Buffer.alloc(32, 8);
    } };
  } });
  const proof = isolated.deriveProof(bare({ ...input, context: bare(context) }));
  assert.deepEqual(Array.from(proof.dice), [2, 3]);
  assert.equal(proof.blocks.length, 3);
  assert.equal(calls, 3);
});

test('pathological rejected-byte streams have a strict computational bound', () => {
  let calls = 0;
  const isolated = isolatedCrypto({ createHmac() {
    return { update() { return this; }, digest() { calls += 1; return Buffer.alloc(32, 255); } };
  } });
  assertCode(() => isolated.deriveProof(bare({ ...input, context: bare(context) })), 'SYSTEM_DICE_DERIVATION_EXHAUSTED');
  assert.equal(calls, Dice.MAX_STREAM_BLOCKS);
});

test('pathological opening ties have a strict counter bound and no fallback RNG', () => {
  let calls = 0;
  const isolated = isolatedCrypto({ createHmac() {
    return { update() { return this; }, digest() { calls += 1; return Buffer.alloc(32); } };
  } });
  const opening = bare({ ...context, label: 'opening', color: 'none' });
  const commit = Dice.commitmentFor(opening, privateSeed);
  assertCode(() => isolated.deriveProof(bare({ ...input, context: opening, commitment: commit })), 'SYSTEM_DICE_OPENING_EXHAUSTED');
  assert.equal(calls, Dice.MAX_OPENING_COUNTER + 1);
});

test('nonminimal block lists and altered HMAC, dice, counter or protocol are rejected', () => {
  const proof = Dice.deriveProof(input);
  assertCode(() => Dice.verifyProof({ ...proof, blocks: [...proof.blocks, '00'.repeat(32)] }, expected), 'SYSTEM_DICE_BLOCKS_MISMATCH');
  assertCode(() => Dice.verifyProof({ ...proof, blocks: ['aa'.repeat(32)] }, expected), 'SYSTEM_DICE_BLOCKS_MISMATCH');
  assertCode(() => Dice.verifyProof({ ...proof, dice: [1, 2] }, expected), 'SYSTEM_DICE_DICE_MISMATCH');
  assertCode(() => Dice.verifyProof({ ...proof, counter: 1 }, expected), 'SYSTEM_DICE_COUNTER_MISMATCH');
  assertCode(() => Dice.verifyProof({ ...proof, protocol: 'drand-quicknet-v1' }, expected), 'SYSTEM_DICE_PROTOCOL_INVALID');
});

test('malformed context, coercion and ambiguous intent are rejected', () => {
  for (const changed of [{ nonce: 0 }, { nonce: -1 }, { nonce: 1.1 }, { nonce: '1' },
    { nonce: Number.MAX_SAFE_INTEGER + 1 }, { gameId: context.gameId.toUpperCase().replace('11111111', 'AAAAAAAA') },
    { gameId: '00000000-0000-0000-0000-000000000000' }, { gameId: 'a'.repeat(1000) },
    { roomCode: 'ABCD|EFGH' }, { roomCode: 'abcd-efgh' }, { roomCode: 'ABCD-EFGH\n' },
    { variant: 'Long' }, { variant: { toString: () => 'long' } }, { label: 'opening' },
    { color: 'none' }, { positionHash: '22'.repeat(31) }, { positionHash: 'A'.repeat(64) },
    { unexpected: true }, { label: 'roll\u0000' }]) {
    assertCode(() => Dice.canonicalContext({ ...context, ...changed }), 'SYSTEM_DICE_CONTEXT_INVALID');
  }
  assertCode(() => Dice.canonicalContext(null), 'SYSTEM_DICE_CONTEXT_INVALID');
  assertCode(() => Dice.canonicalContext(Object.assign(Object.create(context), context)), 'SYSTEM_DICE_CONTEXT_INVALID');
  const symbol = clone(context); symbol[Symbol('intent')] = 1;
  assertCode(() => Dice.canonicalContext(symbol), 'SYSTEM_DICE_CONTEXT_INVALID');
  const nonenumerable = clone(context); Object.defineProperty(nonenumerable, 'hidden', { value: true });
  assertCode(() => Dice.canonicalContext(nonenumerable), 'SYSTEM_DICE_CONTEXT_INVALID');
});

test('input getter side effects are not invoked during validation', () => {
  let reads = 0;
  const intent = clone(context);
  Object.defineProperty(intent, 'nonce', { enumerable: true, get() { reads += 1; return 1; } });
  assertCode(() => Dice.canonicalContext(intent), 'SYSTEM_DICE_CONTEXT_INVALID');
  const proof = Dice.deriveProof(input);
  Object.defineProperty(proof, 'clientSeed', { enumerable: true, get() { reads += 1; return clientSeed; } });
  assertCode(() => Dice.verifyProof(proof, expected), 'SYSTEM_DICE_PROOF_INVALID');
  assert.equal(reads, 0);
});

test('seeds, dice and proof arrays have strict bounded JSON types and shapes', () => {
  for (const seed of [null, undefined, 123, {}, '', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(65), 'aa'.repeat(32) + '\n']) {
    assertCode(() => Dice.validateClientSeed(seed), 'SYSTEM_DICE_SEED_INVALID');
  }
  const proof = Dice.deriveProof(input);
  for (const dice of [[], [1], [1, 2, 3], [0, 2], [1, 7], ['1', 2], [1.1, 2], new Array(2)]) {
    assertCode(() => Dice.verifyProof({ ...proof, dice }, expected), 'SYSTEM_DICE_DICE_INVALID');
  }
  for (const blocks of [[], new Array(1), ['a'.repeat(63)], Array(17).fill('a'.repeat(64))]) {
    assertCode(() => Dice.verifyProof({ ...proof, blocks }, expected), 'SYSTEM_DICE_BLOCKS_INVALID');
  }
  const symbolBlocks = [...proof.blocks]; symbolBlocks[Symbol('ignored')] = 'x';
  assertCode(() => Dice.verifyProof({ ...proof, blocks: symbolBlocks }, expected), 'SYSTEM_DICE_BLOCKS_INVALID');
  const surplusDice = [...proof.dice]; surplusDice.extra = 'x';
  assertCode(() => Dice.verifyProof({ ...proof, dice: surplusDice }, expected), 'SYSTEM_DICE_DICE_INVALID');
  assertCode(() => Dice.verifyProof({ ...proof, extra: 1 }, expected), 'SYSTEM_DICE_PROOF_INVALID');
  assertCode(() => Dice.deriveProof({ ...input, extra: 1 }), 'SYSTEM_DICE_INPUT_INVALID');
  for (const counter of [-1, 1.1, '0', 1025, Number.MAX_SAFE_INTEGER + 1]) {
    assertCode(() => Dice.verifyProof({ ...proof, counter }, expected), 'SYSTEM_DICE_PROOF_INVALID');
  }
});

test('derivation and verification use no bot RNG, wall-clock or player strategy', () => {
  const savedRandom = Math.random;
  const savedNow = Date.now;
  Math.random = () => { throw new Error('Math.random forbidden'); };
  Date.now = () => { throw new Error('wall clock forbidden'); };
  try {
    assert.equal(Dice.verifyProof(Dice.deriveProof(input), expected).verified, true);
    for (const color of ['white', 'dark']) {
      for (const variant of ['long', 'short']) {
        const intent = { ...context, color, variant };
        const commit = Dice.commitmentFor(intent, privateSeed);
        const parameters = { context: intent, privateSeed, clientSeed, commitment: commit };
        assert.deepEqual(Dice.deriveProof(parameters), Dice.deriveProof(parameters));
      }
    }
  } finally {
    Math.random = savedRandom;
    Date.now = savedNow;
  }
});

test('valid JSON round trips preserve proof and expected-field verification', () => {
  const proof = Dice.deriveProof(input);
  const encoded = JSON.stringify(proof);
  assert.equal(Dice.verifyProof(JSON.parse(encoded), JSON.parse(JSON.stringify(expected))).verified, true);
  assert.deepEqual(input, { context, privateSeed, clientSeed, commitment }, 'protocol must not mutate input');
});
