(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./lib/fair-dice-crypto-entry.mjs'));
  else root.NarduFairDice = factory(root.NarduFairDiceCrypto);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (crypto) {
  'use strict';
  const PROTOCOL = 'drand-quicknet-v1';
  const SYSTEM_PROTOCOL = 'system-csprng-v1';
  const CHAIN = Object.freeze({
    hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
    publicKey: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
    genesis: 1692803367, period: 3, scheme: 'bls-unchained-g1-rfc9380',
  });
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const HASH = /^[0-9a-f]{64}$/;
  const REQUEST_FIELDS = ['id', 'roomCode', 'gameId', 'nonce', 'label', 'color', 'variant', 'round', 'createdAt', 'positionHash'];
  const SYSTEM_REQUEST_FIELDS = ['id', 'roomCode', 'gameId', 'nonce', 'label', 'color', 'variant', 'commitment', 'createdAt', 'positionHash'];
  const SYSTEM_CONTEXT_FIELDS = ['gameId', 'nonce', 'roomCode', 'variant', 'label', 'color', 'positionHash'];
  const MAX_COUNTER = 1024;
  function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
  function assert(value, code, message) { if (!value) fail(code, message); }
  function ready() { assert(crypto?.hash && crypto?.verifyBeaconSignature, 'FAIR_CRYPTO_UNAVAILABLE', 'Cryptographic verifier is unavailable.'); }
  function exactRecord(value, fields, code = 'FAIR_REQUEST_INVALID') {
    assert(value && typeof value === 'object' && !Array.isArray(value)
      && Reflect.ownKeys(value).length === fields.length
      && fields.every(field => { const property = Object.getOwnPropertyDescriptor(value, field);
        return property && property.enumerable && Object.hasOwn(property, 'value'); }), code, 'Invalid committed roll record.');
  }
  function exactArray(value, length, code = 'FAIR_SYSTEM_PROOF_INVALID') {
    assert(Array.isArray(value) && value.length === length && Reflect.ownKeys(value).length === length + 1
      && Array.from({ length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
        .every(property => property && property.enumerable && Object.hasOwn(property, 'value')),
    code, 'Invalid committed roll array.');
  }
  function canonicalSystemRequest(request) {
    exactRecord(request, SYSTEM_REQUEST_FIELDS);
    assert(typeof request.id === 'string' && UUID.test(request.id)
      && typeof request.gameId === 'string' && UUID.test(request.gameId)
      && typeof request.roomCode === 'string' && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(request.roomCode)
      && Number.isSafeInteger(request.nonce) && request.nonce >= 1
      && ['long', 'short'].includes(request.variant)
      && typeof request.commitment === 'string' && HASH.test(request.commitment)
      && typeof request.positionHash === 'string' && HASH.test(request.positionHash), 'FAIR_REQUEST_INVALID', 'Invalid committed roll fields.');
    assert((request.label === 'opening' && request.color === 'none')
      || (request.label === 'roll' && ['white', 'dark'].includes(request.color)), 'FAIR_REQUEST_INVALID', 'Invalid roll purpose.');
    const created = Date.parse(request.createdAt);
    assert(typeof request.createdAt === 'string' && Number.isFinite(created)
      && new Date(created).toISOString() === request.createdAt, 'FAIR_REQUEST_INVALID', 'Invalid committed roll timestamp.');
    return JSON.stringify(['nardu/system-csprng/v1', ...SYSTEM_REQUEST_FIELDS.map(field => request[field])]);
  }
  function canonicalRequest(request) {
    if (request && Object.hasOwn(request, 'commitment')) return canonicalSystemRequest(request);
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
  function systemRequestHash(request) { ready(); return crypto.hash(canonicalSystemRequest(request)); }
  function verifyReservation(receipt, publicKey, context = {}) {
    ready();
    const calculated = requestHash(receipt?.request);
    assert(calculated === receipt.requestHash, 'FAIR_RESERVATION_MISMATCH', 'Roll reservation hash does not match.');
    assert(/^[0-9a-f]{128}$/.test(receipt.receiptSignature || ''), 'FAIR_RECEIPT_INVALID', 'Invalid coordinator receipt.');
    const fields = Object.hasOwn(receipt.request, 'commitment') ? SYSTEM_REQUEST_FIELDS : REQUEST_FIELDS;
    for (const field of fields) {
      if (context[field] !== undefined) assert(receipt.request[field] === context[field], 'FAIR_CONTEXT_MISMATCH', 'The proof belongs to a different roll.');
    }
    if (!publicKey) return false;
    assert(HASH.test(publicKey) && crypto.verifyReceipt(receipt.receiptSignature, calculated, publicKey),
      'FAIR_RECEIPT_INVALID', 'Coordinator receipt signature does not match the pinned public key.');
    return true;
  }
  function systemContext(request) {
    canonicalSystemRequest(request);
    return JSON.stringify(['nardu/system-dice/v1', ...SYSTEM_CONTEXT_FIELDS.map(field => request[field])]);
  }
  function systemCommitment(request, serverSeed) {
    ready();
    assert(typeof serverSeed === 'string' && HASH.test(serverSeed), 'FAIR_SYSTEM_SEED_INVALID', 'Invalid server seed.');
    return crypto.hash(JSON.stringify(['nardu/system-dice-commitment/v1', systemContext(request), serverSeed]));
  }
  function deriveSystemDice(request, serverSeed, clientSeed) {
    ready();
    assert(typeof crypto.hmacSha256 === 'function', 'FAIR_CRYPTO_UNAVAILABLE', 'HMAC verifier is unavailable.');
    const context = systemContext(request);
    assert(typeof clientSeed === 'string' && HASH.test(clientSeed), 'FAIR_SYSTEM_SEED_INVALID', 'Invalid client seed.');
    assert(systemCommitment(request, serverSeed) === request.commitment,
      'FAIR_SYSTEM_COMMITMENT_MISMATCH', 'The revealed server seed does not match its signed commitment.');
    // Match the isolated prototype exactly: fixed stream blocks, skip 252..255,
    // and advance the counter only for the opening tie. Never obtain fresh seeds.
    for (let counter = 0; counter <= MAX_COUNTER; counter += 1) {
      const blocks = [];
      const dice = [];
      for (let block = 0; block < 16; block += 1) {
        const digest = crypto.hmacSha256(serverSeed, JSON.stringify(['nardu/system-dice-hmac/v1', context, clientSeed, counter, block]));
        blocks.push(digest);
        for (let offset = 0; offset < digest.length && dice.length < 2; offset += 2) {
          const byte = parseInt(digest.slice(offset, offset + 2), 16);
          if (byte < 252) dice.push((byte % 6) + 1);
        }
        if (dice.length === 2) break;
      }
      assert(dice.length === 2, 'FAIR_DERIVATION_EXHAUSTED', 'Deterministic dice stream exhausted.');
      if (request.label === 'opening' && dice[0] === dice[1]) continue;
      const input = JSON.stringify(['nardu/system-csprng-result/v1', systemRequestHash(request), serverSeed, clientSeed, counter, blocks, dice]);
      return { dice, blocks, counter, rerolls: counter, input, hash: crypto.hash(input) };
    }
    fail('FAIR_DERIVATION_EXHAUSTED', 'Deterministic opening stream exhausted.');
  }
  function createSystemProof(receipt, serverSeed, clientSeed) {
    verifyReservation(receipt);
    canonicalSystemRequest(receipt.request);
    const derived = deriveSystemDice(receipt.request, serverSeed, clientSeed);
    return { protocol: SYSTEM_PROTOCOL, ...receipt,
      commitReveal: { serverSeed, clientSeed, counter: derived.counter, blocks: derived.blocks },
      dice: derived.dice, sha256: derived.hash, sha256Input: derived.input, rerolls: derived.counter };
  }
  function verifySystemProof(proof, { publicKey, context = {}, clientSeed, commitment } = {}) {
    exactRecord(proof, ['protocol', 'request', 'requestHash', 'receiptSignature', 'commitReveal', 'dice', 'sha256', 'sha256Input', 'rerolls'], 'FAIR_SYSTEM_PROOF_INVALID');
    canonicalSystemRequest(proof.request);
    const reservationVerified = verifyReservation(proof, publicKey, context);
    exactRecord(proof.commitReveal, ['serverSeed', 'clientSeed', 'counter', 'blocks'], 'FAIR_SYSTEM_PROOF_INVALID');
    if (clientSeed !== undefined) assert(proof.commitReveal.clientSeed === clientSeed, 'FAIR_CONTEXT_MISMATCH', 'The proof uses a different client seed.');
    if (commitment !== undefined) assert(proof.request.commitment === commitment, 'FAIR_CONTEXT_MISMATCH', 'The proof uses a different commitment.');
    const derived = deriveSystemDice(proof.request, proof.commitReveal.serverSeed, proof.commitReveal.clientSeed);
    exactArray(proof.dice, 2);
    exactArray(proof.commitReveal.blocks, derived.blocks.length);
    assert(Number.isSafeInteger(proof.commitReveal.counter) && proof.commitReveal.counter === derived.counter
      && Array.isArray(proof.commitReveal.blocks) && proof.commitReveal.blocks.length === derived.blocks.length
      && proof.commitReveal.blocks.every((value, index) => value === derived.blocks[index])
      && Array.isArray(proof.dice) && proof.dice.length === 2 && proof.dice.every((value, index) => value === derived.dice[index])
      && proof.sha256 === derived.hash && proof.sha256Input === derived.input && proof.rerolls === derived.rerolls,
      'FAIR_DICE_MISMATCH', 'Recorded dice do not match the signed commitment and HMAC stream.');
    return { ...derived, protocol: SYSTEM_PROTOCOL, request: proof.request, sourceVerified: false,
      independentSourceVerified: false, commitmentVerified: true, reservationVerified,
      clientSeedPinned: clientSeed !== undefined, commitmentPinned: commitment !== undefined,
      entropyVerified: false, priorPublicationVerified: false };
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
  async function verifyProof(proof, options = {}) {
    if (proof?.protocol === SYSTEM_PROTOCOL) return verifySystemProof(proof, options);
    const { publicKey, context = {} } = options;
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
  return Object.freeze({ PROTOCOL, SYSTEM_PROTOCOL, CHAIN, canonicalRequest, canonicalSystemRequest, requestHash, systemRequestHash, roundTime, verifyReservation,
    systemCommitment, deriveSystemDice, createSystemProof, deriveDice, verifyBeacon, verifyProof, signReservation, createProof,
    receiptPublicKey: key => crypto.receiptPublicKey(key) });
});
