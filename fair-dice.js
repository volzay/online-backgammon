(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./lib/fair-dice-crypto-entry.mjs'));
  else root.NarduFairDice = factory(root.NarduFairDiceCrypto);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (crypto) {
  'use strict';
  const PROTOCOL = 'drand-quicknet-v1';
  const CHAIN = Object.freeze({
    hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
    publicKey: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
    genesis: 1692803367, period: 3, scheme: 'bls-unchained-g1-rfc9380',
  });
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const HASH = /^[0-9a-f]{64}$/;
  const REQUEST_FIELDS = ['id', 'roomCode', 'gameId', 'nonce', 'label', 'color', 'variant', 'round', 'createdAt', 'positionHash'];
  const MAX_COUNTER = 1024;
  function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
  function assert(value, code, message) { if (!value) fail(code, message); }
  function ready() { assert(crypto?.hash && crypto?.verifyBeaconSignature, 'FAIR_CRYPTO_UNAVAILABLE', 'Cryptographic verifier is unavailable.'); }
  function canonicalRequest(request) {
    assert(request && typeof request === 'object' && !Array.isArray(request)
      && Object.keys(request).length === REQUEST_FIELDS.length
      && REQUEST_FIELDS.every(field => Object.hasOwn(request, field)), 'FAIR_REQUEST_INVALID', 'Invalid roll reservation.');
    assert(UUID.test(request.id) && UUID.test(request.gameId)
      && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(request.roomCode)
      && Number.isSafeInteger(request.nonce) && request.nonce >= 1
      && Number.isSafeInteger(request.round) && request.round >= 1
      && ['long', 'short'].includes(request.variant)
      && HASH.test(request.positionHash), 'FAIR_REQUEST_INVALID', 'Invalid roll reservation fields.');
    assert((request.label === 'opening' && request.color === 'none')
      || (request.label === 'roll' && ['white', 'dark'].includes(request.color)), 'FAIR_REQUEST_INVALID', 'Invalid roll purpose.');
    const created = Date.parse(request.createdAt);
    assert(Number.isFinite(created) && new Date(created).toISOString() === request.createdAt
      && roundTime(request.round) - created >= 3000, 'FAIR_REQUEST_NOT_FUTURE', 'The reserved beacon round must be future.');
    return ['nardu/drand-quicknet/v1', ...REQUEST_FIELDS.map(field => request[field])].join('|');
  }
  function roundTime(round) { return (CHAIN.genesis + (round - 1) * CHAIN.period) * 1000; }
  function requestHash(request) { ready(); return crypto.hash(canonicalRequest(request)); }
  function verifyReservation(receipt, publicKey, context = {}) {
    ready();
    const calculated = requestHash(receipt?.request);
    assert(calculated === receipt.requestHash, 'FAIR_RESERVATION_MISMATCH', 'Roll reservation hash does not match.');
    assert(/^[0-9a-f]{128}$/.test(receipt.receiptSignature || ''), 'FAIR_RECEIPT_INVALID', 'Invalid coordinator receipt.');
    for (const field of REQUEST_FIELDS) {
      if (context[field] !== undefined) assert(receipt.request[field] === context[field], 'FAIR_CONTEXT_MISMATCH', 'The proof belongs to a different roll.');
    }
    if (!publicKey) return false;
    assert(HASH.test(publicKey) && crypto.verifyReceipt(receipt.receiptSignature, calculated, publicKey),
      'FAIR_RECEIPT_INVALID', 'Coordinator receipt signature does not match the pinned public key.');
    return true;
  }
  function deriveDice(request, randomness) {
    ready();
    const canonical = canonicalRequest(request);
    assert(HASH.test(randomness), 'FAIR_BEACON_INVALID', 'Invalid beacon randomness.');
    // Rejection sampling removes modulo bias. Opening ties and the vanishingly
    // rare exhausted digest use a fixed counter, never a new beacon/reservation.
    for (let counter = 0; counter < MAX_COUNTER; counter += 1) {
      const input = `${canonical}|${randomness}|${counter}`;
      const hash = crypto.hash(input);
      const dice = [];
      for (let index = 0; index < hash.length && dice.length < 2; index += 2) {
        const byte = parseInt(hash.slice(index, index + 2), 16);
        if (byte < 252) dice.push((byte % 6) + 1);
      }
      if (dice.length === 2 && (request.label !== 'opening' || dice[0] !== dice[1])) {
        return { dice, input, hash, rerolls: counter };
      }
    }
    fail('FAIR_DERIVATION_EXHAUSTED', 'Deterministic dice stream exhausted.');
  }
  async function verifyBeacon(beacon, expectedRound) {
    ready();
    assert(beacon && beacon.round === expectedRound && Number.isSafeInteger(beacon.round)
      && /^[0-9a-f]{96}$/.test(beacon.signature || '') && HASH.test(beacon.randomness || ''), 'FAIR_BEACON_INVALID', 'Invalid quicknet beacon.');
    assert(crypto.signatureHash(beacon.signature) === beacon.randomness, 'FAIR_BEACON_INVALID', 'Beacon randomness does not match its signature.');
    assert(crypto.verifyBeaconSignature(beacon.signature, beacon.round, CHAIN.publicKey), 'FAIR_BEACON_SIGNATURE_INVALID', 'Independent beacon signature verification failed.');
    return true;
  }
  async function verifyProof(proof, { publicKey, context = {} } = {}) {
    assert(proof?.protocol === PROTOCOL && proof.chainHash === CHAIN.hash, 'FAIR_PROTOCOL_INVALID', 'Unknown dice protocol or beacon chain.');
    const reservationVerified = verifyReservation(proof, publicKey, context);
    await verifyBeacon(proof.beacon, proof.request.round);
    const derived = deriveDice(proof.request, proof.beacon.randomness);
    assert(Array.isArray(proof.dice) && proof.dice.length === 2 && proof.dice.every((die, index) => die === derived.dice[index])
      && proof.sha256 === derived.hash && proof.sha256Input === derived.input && proof.rerolls === derived.rerolls,
      'FAIR_DICE_MISMATCH', 'Recorded dice do not match the independently verified source.');
    return { ...derived, sourceVerified: true, reservationVerified, round: proof.request.round, request: proof.request, protocol: PROTOCOL };
  }
  function signReservation(request, privateKey) {
    const hash = requestHash(request);
    return { request, requestHash: hash, receiptSignature: crypto.signReceipt(hash, privateKey) };
  }
  async function createProof(receipt, beacon) {
    verifyReservation(receipt);
    await verifyBeacon(beacon, receipt.request.round);
    const derived = deriveDice(receipt.request, beacon.randomness);
    return { protocol: PROTOCOL, ...receipt, chainHash: CHAIN.hash,
      beacon: { round: beacon.round, signature: beacon.signature, randomness: beacon.randomness },
      dice: derived.dice, sha256: derived.hash, sha256Input: derived.input, rerolls: derived.rerolls };
  }
  return Object.freeze({ PROTOCOL, CHAIN, canonicalRequest, requestHash, roundTime, verifyReservation,
    deriveDice, verifyBeacon, verifyProof, signReservation, createProof, receiptPublicKey: key => crypto.receiptPublicKey(key) });
});
