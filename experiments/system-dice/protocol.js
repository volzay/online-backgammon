'use strict';

/**
 * Isolated commit/reveal prototype; it is not connected to the live game.
 *
 * 1. The server obtains 32 bytes from the operating system CSPRNG and publishes
 *    the context-bound SHA-256 commitment BEFORE receiving a fresh client seed.
 * 2. The client independently obtains 32 fresh CSPRNG bytes AFTER that receipt.
 * 3. HMAC-SHA256(serverSeed, domain + context + clientSeed + counter + block)
 *    supplies bytes. Bytes 252..255 are skipped; the first two accepted bytes
 *    map to (byte % 6) + 1. Ordinary doubles are never discarded. Only an
 *    opening tie advances the deterministic counter, starting from zero.
 * 4. Reveal and verification bind all externally expected values. The caller
 *    must enforce durable one-use (gameId, nonce), ordering, and no abort/reroll.
 *
 * This demonstrates commitment integrity and reproducible mapping, NOT an
 * independent randomness source, trustworthy receipt timing, mathematical
 * proof of entropy, or protection from a server that selectively aborts games.
 * It has no network calls, Math.random, wall-clock inputs, or player/bot strategy.
 */

const { randomBytes, createHash, createHmac, timingSafeEqual } = require('node:crypto');

const PROTOCOL = 'nardu/system-dice/v1';
const COMMITMENT_DOMAIN = 'nardu/system-dice-commitment/v1';
const DERIVATION_DOMAIN = 'nardu/system-dice-hmac/v1';
const MAX_OPENING_COUNTER = 1024;
const MAX_STREAM_BLOCKS = 16;
const CONTEXT_FIELDS = ['gameId', 'nonce', 'roomCode', 'variant', 'label', 'color', 'positionHash'];
const HEX_32 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

// Only own enumerable data properties are accepted. Getters, inherited intent,
// symbols, and surplus fields cannot influence or escape canonicalization.
function exactRecord(value, fields, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) fail(code);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
  }
  return value;
}

function validatedContext(context) {
  exactRecord(context, CONTEXT_FIELDS, 'SYSTEM_DICE_CONTEXT_INVALID');
  if (typeof context.gameId !== 'string' || !UUID.test(context.gameId)
      || !Number.isSafeInteger(context.nonce) || context.nonce < 1
      || typeof context.roomCode !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(context.roomCode)
      || !['long', 'short'].includes(context.variant)
      || !['opening', 'roll'].includes(context.label)
      || (context.label === 'opening' ? context.color !== 'none' : !['white', 'dark'].includes(context.color))
      || typeof context.positionHash !== 'string' || !HEX_32.test(context.positionHash)) {
    fail('SYSTEM_DICE_CONTEXT_INVALID');
  }
  return Object.fromEntries(CONTEXT_FIELDS.map(field => [field, context[field]]));
}

function canonicalContext(context) {
  const validated = validatedContext(context);
  return JSON.stringify([PROTOCOL, ...CONTEXT_FIELDS.map(field => validated[field])]);
}

function seedValue(value, code = 'SYSTEM_DICE_SEED_INVALID') {
  if (typeof value !== 'string' || !HEX_32.test(value)) fail(code);
  return value;
}

function validateClientSeed(clientSeed) {
  return seedValue(clientSeed);
}

function randomClientSeed() {
  return randomBytes(32).toString('hex');
}

function hashCommitment(context, privateSeed) {
  const message = JSON.stringify([COMMITMENT_DOMAIN, canonicalContext(context), seedValue(privateSeed)]);
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

function commitmentFor(context, privateSeed) {
  return hashCommitment(context, privateSeed);
}

function equalHex(first, second) {
  return timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'));
}

function createCommitment(context) {
  // Validate before obtaining entropy, so malformed intent never creates a seed.
  canonicalContext(context);
  const privateSeed = randomBytes(32).toString('hex');
  return { privateSeed, commitment: hashCommitment(context, privateSeed) };
}

function diceFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_STREAM_BLOCKS * 32) {
    fail('SYSTEM_DICE_BYTES_INVALID');
  }
  const dice = [];
  for (const byte of bytes) {
    if (byte < 252) dice.push((byte % 6) + 1);
    if (dice.length === 2) break;
  }
  return dice;
}

function deriveAtCounter(contextText, privateSeed, clientSeed, counter) {
  const blocks = [];
  const accepted = [];
  for (let block = 0; block < MAX_STREAM_BLOCKS; block += 1) {
    const message = JSON.stringify([DERIVATION_DOMAIN, contextText, clientSeed, counter, block]);
    const digest = createHmac('sha256', Buffer.from(privateSeed, 'hex')).update(message, 'utf8').digest();
    blocks.push(digest.toString('hex'));
    for (const byte of digest) {
      if (byte < 252) accepted.push((byte % 6) + 1);
      if (accepted.length === 2) return { dice: accepted, blocks };
    }
  }
  fail('SYSTEM_DICE_DERIVATION_EXHAUSTED');
}

function deriveProof(input) {
  exactRecord(input, ['context', 'privateSeed', 'clientSeed', 'commitment'], 'SYSTEM_DICE_INPUT_INVALID');
  const context = validatedContext(input.context);
  const privateSeed = seedValue(input.privateSeed);
  const clientSeed = validateClientSeed(input.clientSeed);
  const commitment = seedValue(input.commitment, 'SYSTEM_DICE_COMMITMENT_INVALID');
  if (!equalHex(hashCommitment(context, privateSeed), commitment)) fail('SYSTEM_DICE_COMMITMENT_MISMATCH');
  const contextText = canonicalContext(context);
  for (let counter = 0; counter <= MAX_OPENING_COUNTER; counter += 1) {
    const result = deriveAtCounter(contextText, privateSeed, clientSeed, counter);
    if (context.label === 'opening' && result.dice[0] === result.dice[1]) continue;
    return {
      protocol: PROTOCOL,
      context,
      commitment,
      serverSeed: privateSeed,
      clientSeed,
      counter,
      dice: result.dice,
      blocks: result.blocks,
    };
  }
  fail('SYSTEM_DICE_OPENING_EXHAUSTED');
}

function exactArray(value, min, max, predicate, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < min || value.length > max) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(key => typeof key !== 'string'
      || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) fail(code);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !predicate(descriptor.value)) fail(code);
  }
  return value;
}

function verifyProof(proof, expected) {
  // External pins are mandatory. Values copied from a proof are not independent
  // evidence that a commitment was received before the client chose its seed.
  exactRecord(expected, ['context', 'commitment', 'clientSeed'], 'SYSTEM_DICE_EXPECTED_REQUIRED');
  const expectedContextText = canonicalContext(expected.context);
  const expectedCommitment = seedValue(expected.commitment, 'SYSTEM_DICE_COMMITMENT_INVALID');
  const expectedClientSeed = validateClientSeed(expected.clientSeed);
  exactRecord(proof, ['protocol', 'context', 'commitment', 'serverSeed', 'clientSeed', 'counter', 'dice', 'blocks'], 'SYSTEM_DICE_PROOF_INVALID');
  if (proof.protocol !== PROTOCOL) fail('SYSTEM_DICE_PROTOCOL_INVALID');
  if (canonicalContext(proof.context) !== expectedContextText) fail('SYSTEM_DICE_CONTEXT_MISMATCH');
  seedValue(proof.commitment, 'SYSTEM_DICE_COMMITMENT_INVALID');
  validateClientSeed(proof.clientSeed);
  seedValue(proof.serverSeed);
  if (!equalHex(proof.commitment, expectedCommitment)) fail('SYSTEM_DICE_COMMITMENT_MISMATCH');
  if (!equalHex(proof.clientSeed, expectedClientSeed)) fail('SYSTEM_DICE_CLIENT_SEED_MISMATCH');
  if (!Number.isSafeInteger(proof.counter) || proof.counter < 0 || proof.counter > MAX_OPENING_COUNTER) fail('SYSTEM_DICE_PROOF_INVALID');
  exactArray(proof.dice, 2, 2, die => Number.isSafeInteger(die) && die >= 1 && die <= 6, 'SYSTEM_DICE_DICE_INVALID');
  exactArray(proof.blocks, 1, MAX_STREAM_BLOCKS, hash => typeof hash === 'string' && HEX_32.test(hash), 'SYSTEM_DICE_BLOCKS_INVALID');
  // Reconstruct from counter zero, not the supplied counter. This also requires
  // the minimum byte-stream blocks needed for the first two accepted values.
  const reconstructed = deriveProof({ context: expected.context, privateSeed: proof.serverSeed,
    clientSeed: expectedClientSeed, commitment: expectedCommitment });
  if (proof.counter !== reconstructed.counter) fail('SYSTEM_DICE_COUNTER_MISMATCH');
  if (proof.dice.some((die, index) => die !== reconstructed.dice[index])) fail('SYSTEM_DICE_DICE_MISMATCH');
  if (proof.blocks.length !== reconstructed.blocks.length
      || proof.blocks.some((hash, index) => !equalHex(hash, reconstructed.blocks[index]))) {
    fail('SYSTEM_DICE_BLOCKS_MISMATCH');
  }
  return { verified: true, commitmentVerified: true, protocol: PROTOCOL,
    dice: [...reconstructed.dice], counter: reconstructed.counter,
    intendedRandomnessSource: 'system-csprng', entropyVerified: false,
    priorPublicationVerified: false, independentSourceVerified: false };
}

module.exports = {
  PROTOCOL, COMMITMENT_DOMAIN, DERIVATION_DOMAIN, MAX_OPENING_COUNTER, MAX_STREAM_BLOCKS,
  canonicalContext, validateClientSeed, randomClientSeed, createCommitment, commitmentFor,
  deriveProof, verifyProof, diceFromBytes,
};
