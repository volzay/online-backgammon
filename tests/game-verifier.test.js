const assert = require('node:assert/strict');
const { createHash, createHmac, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const verifier = require('../game-verifier.js');
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const hmac256 = (key, message) => createHmac('sha256', key).update(message, 'utf8').digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const hashBytes = values => Buffer.from([...values, ...Array(32 - values.length).fill(255)]).toString('hex');

function independentlyExtractDice(hash) {
  const usable = [...Buffer.from(hash, 'hex')].filter(value => value < 252);
  assert.ok(usable.length >= 2, 'the independent fixture must contain two accepted bytes');
  return usable.slice(0, 2).map(value => (value % 6) + 1);
}

function loadBrowserVerifier({ fairDice, env } = {}) {
  let networkCalls = 0;
  const math = Object.create(Math);
  math.random = () => { throw new Error('random fallback must not be used by a verifier'); };
  const context = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    Math: math,
    NarduFairDice: fairDice,
    NARDU_ENV: env,
    fetch: () => { networkCalls += 1; throw new Error('verification must remain local'); },
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game-verifier.js'), 'utf8'), context, {
    filename: 'game-verifier.js',
  });
  return { verifier: context.NarduVerify, networkCalls: () => networkCalls };
}

const fairDice = require('../fair-dice.js');
const TEST_RECEIPT_KEY = '11'.repeat(32);
const TEST_RECEIPT_PUBLIC_KEY = fairDice.receiptPublicKey(TEST_RECEIPT_KEY);
const QUICKNET_1000 = Object.freeze({
  round: 1000,
  signature: 'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39',
  randomness: 'fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd',
});
function signedProof({ nonce = 1, label = 'opening', color = 'none', gameId = '11111111-1111-4111-8111-111111111111', roomCode = 'ABCD-EFGH' } = {}) {
  const request = { id: `${String(nonce).padStart(8, '0')}-1111-4111-8111-111111111111`, roomCode, gameId, nonce,
    label, color, variant: 'long', round: 1000, createdAt: new Date(fairDice.roundTime(1000) - 6000).toISOString(), positionHash: 'a'.repeat(64) };
  const receipt = fairDice.signReservation(request, TEST_RECEIPT_KEY);
  const derived = fairDice.deriveDice(request, QUICKNET_1000.randomness);
  return { protocol: fairDice.PROTOCOL, ...receipt, chainHash: fairDice.CHAIN.hash, beacon: { ...QUICKNET_1000 },
    dice: derived.dice, sha256: derived.hash, sha256Input: derived.input, rerolls: derived.rerolls };
}
function signedHistory(proof) {
  return { ...(proof.request.label === 'opening' ? { opening: true, host: proof.dice[0], guest: proof.dice[1] }
    : { roll: proof.dice.join(':'), color: proof.request.color }), sha256: proof.sha256, sha256Input: proof.sha256Input, fairDiceProof: proof };
}

test('the verifier exports the same local API in Node and in a browser without Node globals', async () => {
  const browser = loadBrowserVerifier();
  for (const method of ['sha256Hex', 'diceFromHash', 'normalizeDice', 'verifyPortalRoll', 'verifySeed', 'verifyHmacRoll']) {
    assert.equal(typeof verifier[method], 'function', `${method} must be exported to Node`);
    assert.equal(typeof browser.verifier[method], 'function', `${method} must be available in the browser`);
  }
  assert.equal(await browser.verifier.sha256Hex('abc'), sha256('abc'));
  assert.equal(browser.networkCalls(), 0);
});

test('SHA-256 matches standard empty-string and abc vectors', async () => {
  assert.equal(await verifier.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await verifier.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('SHA-256 hashes exact UTF-8 text rather than trimming or normalizing seed/preimage data', async () => {
  for (const text of ['ВащеППЦ:Наблюдатель:🎲', '  seed\n', 'é', 'e\u0301']) {
    assert.equal(await verifier.sha256Hex(text), sha256(text));
  }
  assert.notEqual(await verifier.sha256Hex('  seed\n'), await verifier.sha256Hex('seed'));
  assert.notEqual(await verifier.sha256Hex('é'), await verifier.sha256Hex('e\u0301'));
});

test('hash decoding extracts the first two accepted bytes and exposes their origins', () => {
  const result = verifier.diceFromHash(hashBytes([0, 251]));
  assert.deepEqual(plain(result.dice), [1, 6]);
  assert.deepEqual(plain(result.sourceBytes), [
    { byteIndex: 0, sourceByte: 0, die: 1 },
    { byteIndex: 1, sourceByte: 251, die: 6 },
  ]);
});

test('hash decoding rejects 252–255 instead of introducing modulo bias', () => {
  const result = verifier.diceFromHash(hashBytes([252, 253, 254, 255, 1, 3]));
  assert.deepEqual(plain(result.dice), [2, 4]);
  assert.deepEqual(plain(result.sourceBytes), [
    { byteIndex: 4, sourceByte: 1, die: 2 },
    { byteIndex: 5, sourceByte: 3, die: 4 },
  ]);
});

test('hash decoding supports uppercase hexadecimal but not malformed or partial SHA-256', () => {
  assert.deepEqual(plain(verifier.diceFromHash(hashBytes([10, 11]).toUpperCase()).dice), [5, 6]);
  for (const value of ['', 'ab'.repeat(31), 'ab'.repeat(33), `g${'0'.repeat(63)}`, `0x${'ab'.repeat(32)}`, `${'ab'.repeat(16)} ${'ab'.repeat(16)}`, null, 0, {}]) {
    assert.throws(() => verifier.diceFromHash(value), `invalid SHA-256 must be rejected: ${String(value)}`);
  }
});

test('exhausting acceptable hash bytes fails closed without a Math.random fallback', () => {
  const browser = loadBrowserVerifier();
  for (const hash of ['ff'.repeat(32), hashBytes([0])]) {
    assert.throws(() => browser.verifier.diceFromHash(hash));
  }
  assert.equal(browser.networkCalls(), 0);
});

test('expected dice accept the supported delimiters and native two-die arrays', () => {
  for (const value of ['2:4', '2,4', '2 4', ' 2 : 4 ', [2, 4]]) {
    assert.deepEqual(plain(verifier.normalizeDice(value)), [2, 4]);
  }
});

test('four expanded dice are accepted only for a true double and reduce to two physical dice', () => {
  assert.deepEqual(plain(verifier.normalizeDice([6, 6, 6, 6])), [6, 6]);
  assert.deepEqual(plain(verifier.normalizeDice([1, 1, 1, 1])), [1, 1]);
  for (const value of [[2, 2, 2], [2, 4, 2, 4], [2, 2, 2, 3], [2, 2, 2, 2, 2]]) {
    assert.throws(() => verifier.normalizeDice(value));
  }
});

test('expected dice reject partial, out-of-range, fractional, or coerced values', () => {
  for (const value of ['2', '2:', '2:0', '7:2', '2.5:4', '2e0:4', [2], [2, 0], [7, 2], [2.5, 4], ['2', '4'], [true, 4], [null, 4], { 0: 2, 1: 4, length: 2 }]) {
    assert.throws(() => verifier.normalizeDice(value), `invalid dice must be rejected: ${JSON.stringify(value)}`);
  }
});

test('portal roll is verified only when both the exact preimage and recorded dice match', async () => {
  const preimage = 'room:ABCD-EFGH:roll:ВащеППЦ:19';
  const hash = sha256(preimage);
  const expectedDice = independentlyExtractDice(hash);
  const result = await verifier.verifyPortalRoll({ hash, preimage, expectedDice });
  assert.equal(result.status, 'verified');
  assert.equal(result.hashStatus, 'verified');
  assert.equal(result.diceStatus, 'verified');
  assert.equal(result.hash, hash);
  assert.deepEqual(plain(result.dice), expectedDice);
});

test('matching dice without a disclosed portal preimage cannot certify the roll', async () => {
  const hash = hashBytes([1, 3]);
  const result = await verifier.verifyPortalRoll({ hash, expectedDice: '2:4' });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.hashStatus, 'unavailable');
  assert.equal(result.diceStatus, 'verified');
  assert.ok(typeof result.warning === 'string' && result.warning.length > 0, 'missing proof must be explained');
});

test('a correct portal preimage with no recorded dice remains incomplete', async () => {
  const preimage = 'complete hash proof without a recorded roll';
  const result = await verifier.verifyPortalRoll({ hash: sha256(preimage), preimage });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.hashStatus, 'verified');
  assert.equal(result.diceStatus, 'unavailable');
});

test('a known portal hash mismatch remains a mismatch when no recorded dice are available', async () => {
  const result = await verifier.verifyPortalRoll({ hash: sha256('original preimage'), preimage: 'changed preimage' });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.hashStatus, 'mismatch');
  assert.equal(result.diceStatus, 'unavailable');
});

test('portal mismatches distinguish a wrong preimage from a wrong recorded roll', async () => {
  const preimage = 'portal roll proof';
  const hash = sha256(preimage);
  const dice = independentlyExtractDice(hash);
  const wrongDice = [(dice[0] % 6) + 1, dice[1]];
  const wrongPreimage = await verifier.verifyPortalRoll({ hash, preimage: `${preimage} `, expectedDice: dice });
  assert.equal(wrongPreimage.status, 'mismatch');
  assert.equal(wrongPreimage.hashStatus, 'mismatch');
  assert.equal(wrongPreimage.diceStatus, 'verified');
  const wrongRoll = await verifier.verifyPortalRoll({ hash, preimage, expectedDice: wrongDice });
  assert.equal(wrongRoll.status, 'mismatch');
  assert.equal(wrongRoll.hashStatus, 'verified');
  assert.equal(wrongRoll.diceStatus, 'mismatch');
});

test('portal recorded dice are ordered rather than compared as an unordered set', async () => {
  const result = await verifier.verifyPortalRoll({ hash: hashBytes([1, 3]), expectedDice: [4, 2] });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.diceStatus, 'mismatch');
});

test('a portal expanded double compares the two physical dice, not four new rolls', async () => {
  const result = await verifier.verifyPortalRoll({ hash: hashBytes([5, 11]), expectedDice: [6, 6, 6, 6] });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.diceStatus, 'verified');
  assert.deepEqual(plain(result.dice), [6, 6]);
});

test('a missing portal hash yields an incomplete result and no fabricated dice', async () => {
  for (const hash of [undefined, '']) {
    const result = await verifier.verifyPortalRoll({ hash, expectedDice: [2, 4] });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.hashStatus, 'unavailable');
    assert.equal(result.diceStatus, 'unavailable');
    assert.deepEqual(plain(result.dice), []);
  }
});

test('a malformed supplied portal hash is an input error rather than a fairness result', async () => {
  for (const hash of ['legacy:123', 'f'.repeat(63), 'g'.repeat(64), `0x${'ab'.repeat(32)}`, 0, false, {}]) {
    await assert.rejects(() => verifier.verifyPortalRoll({ hash, expectedDice: [2, 4] }),
      error => error.code === 'INVALID_HASH');
  }
});

test('portal accepted-byte exhaustion is not reported as verified', async () => {
  const result = await verifier.verifyPortalRoll({ hash: 'ff'.repeat(32), expectedDice: [2, 4] });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(plain(result.dice), []);
});

test('portal partial recorded dice are rejected even when the hash has not been provided', async () => {
  for (const expectedDice of [[2], [2, null], '2:']) {
    await assert.rejects(() => verifier.verifyPortalRoll({ expectedDice }));
  }
});

test('a seed commitment is verified, mismatched, or incomplete only according to the provided hash', async () => {
  const seed = '  раскрытый server seed 🎲\n';
  const actual = sha256(seed);
  const matched = await verifier.verifySeed({ seed, expectedHash: actual });
  assert.equal(matched.status, 'verified');
  assert.equal(matched.hash, actual);
  const mismatched = await verifier.verifySeed({ seed, expectedHash: '0'.repeat(64) });
  assert.equal(mismatched.status, 'mismatch');
  assert.equal(mismatched.hash, actual);
  const uncommitted = await verifier.verifySeed({ seed });
  assert.equal(uncommitted.status, 'incomplete');
  assert.equal(uncommitted.hash, actual);
});

test('malformed seed commitments are errors rather than successful validation', async () => {
  for (const expectedHash of ['ab'.repeat(31), 'x'.repeat(64), `0x${'ab'.repeat(32)}`, 123, {}]) {
    await assert.rejects(() => verifier.verifySeed({ seed: 'seed', expectedHash }));
  }
});

test('HMAC-SHA256 uses the UTF-8 seed as key and the fixed game/client/nonce message', async () => {
  const input = { serverSeed: 'server seed', gameId: 'G934821', clientSeed: 'player-7d82c991', nonce: 0 };
  const message = 'G934821:player-7d82c991:0';
  const expectedHash = hmac256(input.serverSeed, message);
  const expectedDice = independentlyExtractDice(expectedHash);
  const result = await verifier.verifyHmacRoll({ ...input, expectedDice, expectedHash });
  assert.equal(result.status, 'verified');
  assert.equal(result.message, message);
  assert.equal(result.hmac, expectedHash);
  assert.deepEqual(plain(result.dice), expectedDice);
});

test('HMAC encodes Cyrillic, emoji, and surrounding seed whitespace exactly as UTF-8', async () => {
  const input = { serverSeed: '  семя 🎲\n', gameId: 'комната-1', clientSeed: 'ВащеППЦ', nonce: 17 };
  const message = 'комната-1:ВащеППЦ:17';
  const expectedHash = hmac256(input.serverSeed, message);
  const result = await verifier.verifyHmacRoll({ ...input, expectedDice: independentlyExtractDice(expectedHash) });
  assert.equal(result.status, 'verified');
  assert.equal(result.message, message);
  assert.equal(result.hmac, expectedHash);
});

test('expected hexadecimal hashes compare case-insensitively in every verification mode', async () => {
  const seed = 'upper-case seed hash';
  assert.equal((await verifier.verifySeed({ seed, expectedHash: sha256(seed).toUpperCase() })).status, 'verified');
  const portalHash = sha256(seed);
  assert.equal((await verifier.verifyPortalRoll({ hash: portalHash.toUpperCase(), preimage: seed, expectedDice: independentlyExtractDice(portalHash) })).status, 'verified');
  const input = { serverSeed: seed, gameId: 'game', clientSeed: 'client', nonce: 0 };
  const hmac = hmac256(seed, 'game:client:0');
  assert.equal((await verifier.verifyHmacRoll({ ...input, expectedHash: hmac.toUpperCase(), expectedDice: independentlyExtractDice(hmac) })).status, 'verified');
});

test('HMAC calculation without the recorded dice is incomplete even if the optional expected hash matches', async () => {
  const input = { serverSeed: 'seed', gameId: 'game', clientSeed: 'client', nonce: 1 };
  const result = await verifier.verifyHmacRoll({ ...input, expectedHash: hmac256('seed', 'game:client:1') });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(plain(result.dice), independentlyExtractDice(result.hmac));
});

test('HMAC comparison detects either an optional hash mismatch or a recorded dice mismatch', async () => {
  const input = { serverSeed: 'seed', gameId: 'game', clientSeed: 'client', nonce: 2 };
  const expectedHash = hmac256('seed', 'game:client:2');
  const dice = independentlyExtractDice(expectedHash);
  const badHash = await verifier.verifyHmacRoll({ ...input, expectedDice: dice, expectedHash: '0'.repeat(64) });
  assert.equal(badHash.status, 'mismatch');
  const badDice = await verifier.verifyHmacRoll({ ...input, expectedDice: [(dice[0] % 6) + 1, dice[1]], expectedHash });
  assert.equal(badDice.status, 'mismatch');
});

test('a known HMAC hash mismatch remains a mismatch even without recorded dice', async () => {
  const result = await verifier.verifyHmacRoll({ serverSeed: 'seed', gameId: 'game', clientSeed: 'client', nonce: 2, expectedHash: '0'.repeat(64) });
  assert.equal(result.status, 'mismatch');
});

test('HMAC nonce supports exactly safe integers and canonical unsigned decimal strings', async () => {
  const base = { serverSeed: 'seed', gameId: 'game', clientSeed: 'client' };
  for (const nonce of [0, 17, Number.MAX_SAFE_INTEGER, '0', '17', String(Number.MAX_SAFE_INTEGER)]) {
    const result = await verifier.verifyHmacRoll({ ...base, nonce });
    assert.equal(result.message, `game:client:${nonce}`);
    assert.equal(result.hmac, hmac256('seed', `game:client:${nonce}`));
    assert.equal(result.status, 'incomplete');
  }
});

test('HMAC rejects unsafe, negative, fractional, coerced, or noncanonical nonce values', async () => {
  const base = { serverSeed: 'seed', gameId: 'game', clientSeed: 'client' };
  for (const nonce of [undefined, null, false, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', '00', '01', '-1', '+1', '1.0', '1e0', ' 1', '1 ', '9007199254740992', [], {}]) {
    await assert.rejects(() => verifier.verifyHmacRoll({ ...base, nonce }), `invalid nonce must fail: ${String(nonce)}`);
  }
});

test('HMAC does not treat partial or malformed expected dice/hash as a verified roll', async () => {
  const base = { serverSeed: 'seed', gameId: 'game', clientSeed: 'client', nonce: 0 };
  for (const expectedDice of ['2', '2:', [2], [2, null], [2, 7]]) {
    await assert.rejects(() => verifier.verifyHmacRoll({ ...base, expectedDice }));
  }
  for (const expectedHash of ['x'.repeat(64), 'ab'.repeat(31), false, {}]) {
    await assert.rejects(() => verifier.verifyHmacRoll({ ...base, expectedHash, expectedDice: [2, 4] }));
  }
});

test('untrusted verifier fields have a bounded size and native string types', async () => {
  const tooLong = 'a'.repeat(16385);
  await assert.rejects(() => verifier.sha256Hex(tooLong));
  await assert.rejects(() => verifier.sha256Hex({ toString: () => 'abc' }));
  await assert.rejects(() => verifier.verifySeed({ seed: tooLong }));
  await assert.rejects(() => verifier.verifyPortalRoll({ hash: sha256('abc'), preimage: tooLong, expectedDice: [2, 4] }));
  const base = { serverSeed: 'seed', gameId: 'game', clientSeed: 'client', nonce: 0 };
  for (const field of ['serverSeed', 'gameId', 'clientSeed']) {
    await assert.rejects(() => verifier.verifyHmacRoll({ ...base, [field]: tooLong }));
    await assert.rejects(() => verifier.verifyHmacRoll({ ...base, [field]: { toString: () => 'text' } }));
  }
  for (const field of ['gameId', 'clientSeed']) {
    await assert.rejects(() => verifier.verifyHmacRoll({ ...base, [field]: 'a'.repeat(257) }));
  }
});

test('maximum permitted seed text and identifiers are hashed without silent truncation', async () => {
  const seed = 'x'.repeat(16384);
  assert.equal(await verifier.sha256Hex(seed), sha256(seed));
  const gameId = 'g'.repeat(256);
  const clientSeed = 'c'.repeat(256);
  const result = await verifier.verifyHmacRoll({ serverSeed: seed, gameId, clientSeed, nonce: 0 });
  assert.equal(result.message, `${gameId}:${clientSeed}:0`);
  assert.equal(result.hmac, hmac256(seed, `${gameId}:${clientSeed}:0`));
  assert.equal(result.status, 'incomplete');
});

test('a browser without Web Crypto reports an explicit unavailable error instead of replacing cryptography', async () => {
  const context = vm.createContext({ TextEncoder, Uint8Array, ArrayBuffer });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game-verifier.js'), 'utf8'), context, {
    filename: 'game-verifier.js',
  });
  await assert.rejects(() => context.NarduVerify.sha256Hex('abc'),
    error => error.code === 'CRYPTO_UNAVAILABLE');
  await assert.rejects(() => context.NarduVerify.verifyHmacRoll({ serverSeed: 'seed', gameId: 'game', clientSeed: 'client', nonce: 0 }),
    error => error.code === 'CRYPTO_UNAVAILABLE');
});

test('browser seed and HMAC checks use only Web Crypto and do not make network calls', async () => {
  const browser = loadBrowserVerifier();
  assert.equal((await browser.verifier.verifySeed({ seed: 'abc', expectedHash: sha256('abc') })).status, 'verified');
  const input = { serverSeed: 'seed', gameId: 'game', clientSeed: 'client', nonce: '9' };
  const expectedHash = hmac256('seed', 'game:client:9');
  const result = await browser.verifier.verifyHmacRoll({ ...input, expectedHash, expectedDice: independentlyExtractDice(expectedHash) });
  assert.equal(result.status, 'verified');
  assert.equal(result.hmac, expectedHash);
  assert.equal(browser.networkCalls(), 0);
});

test('the browser portal verifier preserves verified, incomplete, and mismatch states', async () => {
  const browser = loadBrowserVerifier();
  const preimage = 'браузерный портал';
  const hash = sha256(preimage);
  const expectedDice = independentlyExtractDice(hash);
  assert.equal((await browser.verifier.verifyPortalRoll({ hash, preimage, expectedDice })).status, 'verified');
  assert.equal((await browser.verifier.verifyPortalRoll({ hash, expectedDice })).status, 'incomplete');
  assert.equal((await browser.verifier.verifyPortalRoll({ hash, preimage: `${preimage}X`, expectedDice })).status, 'mismatch');
  assert.equal(browser.networkCalls(), 0);
});

test('history helpers preserve host/guest order for opening rolls independently of checker color', () => {
  const item = { opening: true, host: 3, guest: 1, color: 'dark', sha256: hashBytes([2, 0]) };
  const result = verifier.portalRollFromHistory(item);
  assert.deepEqual(plain(result.expectedDice), [3, 1]);
  assert.equal(result.hash, item.sha256);
  assert.equal(Object.hasOwn(result, 'preimage'), false);
  assert.deepEqual(plain(item), { opening: true, host: 3, guest: 1, color: 'dark', sha256: hashBytes([2, 0]) });
});

test('history helpers accept legacy ordinary and opening-move rolls without inventing an input preimage', () => {
  for (const item of [
    { roll: '2:4', sha256: hashBytes([1, 3]) },
    { openingMove: true, roll: [2, 4], sha256: hashBytes([1, 3]) },
    { roll: [6, 6, 6, 6], sha256: hashBytes([5, 11]) },
  ]) {
    const result = verifier.portalRollFromHistory(item);
    assert.deepEqual(plain(result.expectedDice), verifier.normalizeDice(item.roll));
    assert.equal(Object.hasOwn(result, 'preimage'), false);
  }
});

test('new history helpers use only the exact one-time SHA-256 input recorded on that roll', async () => {
  const sha256Input = '  nardu|комната|🎲|one-time-input\n';
  const hash = sha256(sha256Input);
  const roll = independentlyExtractDice(hash);
  const item = { sha256: hash, roll, sha256Input, serverSeed: 'must not be substituted' };
  const proof = verifier.portalRollFromHistory(item);
  assert.equal(proof.preimage, sha256Input);
  assert.equal((await verifier.verifyPortalRoll(proof)).status, 'verified');
  assert.equal(item.sha256Input, sha256Input);
  assert.deepEqual(item.roll, roll);
});

test('verification links carry public hash/dice in the fragment but no secret inputs or query parameters', () => {
  const secret = 'PRIVATE|serverSeed|password|token|🎲';
  const item = { sha256: hashBytes([1, 3]), roll: '2:4', color: 'dark', sha256Input: secret,
    serverSeed: secret, preimage: secret, password: secret, token: secret, clientSeed: secret };
  const link = verifier.verificationUrl(item);
  const url = new URL(link, 'https://example.invalid/online-backgammon/');
  const params = new URLSearchParams(url.hash.slice(1));
  assert.equal(url.pathname, '/online-backgammon/verify-game.html');
  assert.equal(url.search, '');
  assert.deepEqual([...params.keys()], ['hash', 'dice', 'color']);
  assert.equal(params.get('hash'), item.sha256);
  assert.deepEqual(params.get('dice').split(/[,:]/).map(Number), [2, 4]);
  assert.equal(params.get('color'), 'dark');
  assert.ok(!link.includes(secret) && !link.includes(encodeURIComponent(secret)));
  assert.doesNotMatch(link, /(?:seed|preimage|password|token)=/i);
});

test('verification links omit unknown colors rather than allowing HTML or arbitrary parameters', () => {
  const link = verifier.verificationUrl({ sha256: hashBytes([1, 3]), roll: '2:4', color: 'white&token=secret' });
  assert.ok(link.length > 0);
  assert.deepEqual([...new URLSearchParams(link.split('#')[1]).keys()], ['hash', 'dice']);
});

test('malformed history records never produce a verification link', () => {
  for (const item of [undefined, null, 0, false, 'roll', [], {},
    { sha256: 'bad', roll: '2:4' },
    { sha256: hashBytes([1, 3]), roll: '2' },
    { sha256: hashBytes([1, 3]), opening: true, host: 2, guest: undefined },
    { sha256: hashBytes([1, 3]), roll: '2:4', sha256Input: 'x'.repeat(16385) },
  ]) {
    assert.equal(verifier.verificationUrl(item), '');
    assert.throws(() => verifier.portalRollFromHistory(item));
  }
});

function historyRoll(seed, extra = {}) {
  const hash = sha256(seed);
  return { roll: independentlyExtractDice(hash).join(':'), sha256: hash, sha256Input: seed, ...extra };
}

test('whole-game verification selects opening, opening-move, and ordinary rolls without counting checker moves', async () => {
  const openingSeed = 'opening seed';
  const openingHash = sha256(openingSeed);
  const [host, guest] = independentlyExtractDice(openingHash);
  const game = { history: [
    { from: 24, to: 18, die: 6 },
    { opening: true, host, guest, sha256: openingHash, sha256Input: openingSeed },
    historyRoll('opening move seed', { openingMove: true }),
    { chat: 'not a roll', sha256: 'unrelated' },
    historyRoll('ordinary roll seed'),
  ] };
  const result = await verifier.verifyGameRolls(game);
  assert.equal(result.status, 'verified');
  assert.deepEqual(plain(result.counts), { rolls: 3, verified: 3, incomplete: 0, mismatch: 0, diceVerified: 3, hashVerified: 3 });
  assert.deepEqual(result.results.map(row => row.historyIndex), [1, 2, 4]);
  assert.ok(result.results.every(row => row.status === 'verified'));
});

test('whole-game verification retains legacy incomplete proofs and does not turn matching hashes into full certification', async () => {
  const result = await verifier.verifyGameRolls({ history: [
    { roll: '2:4', sha256: hashBytes([1, 3]) },
    historyRoll('new disclosed roll'),
    { openingMove: true, roll: '5:6' },
  ] });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(plain(result.counts), { rolls: 3, verified: 1, incomplete: 2, mismatch: 0, diceVerified: 2, hashVerified: 1 });
  assert.equal(result.results[0].hashStatus, 'unavailable');
  assert.equal(result.results[2].diceStatus, 'unavailable');
});

test('a known wrong roll or input makes the whole-game result mismatched even if other records are incomplete', async () => {
  const wrong = historyRoll('correct preimage');
  wrong.sha256Input += ' ';
  const result = await verifier.verifyGameRolls({ history: [
    { roll: '2:4', sha256: hashBytes([1, 3]) },
    wrong,
    historyRoll('valid new roll'),
  ] });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.counts.mismatch, 1);
  assert.equal(result.counts.incomplete, 1);
  assert.equal(result.counts.verified, 1);
  assert.equal(result.results[1].hashStatus, 'mismatch');
});

test('invalid individual roll records remain visible as incomplete warnings and do not abort other records', async () => {
  const result = await verifier.verifyGameRolls({ history: [
    { roll: '2:4', sha256: 'malformed' },
    { roll: '2', sha256: hashBytes([1, 3]) },
    { opening: true, host: 2, guest: 4, sha256: 'ff'.repeat(32) },
    historyRoll('good roll after bad ones'),
  ] });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.counts.rolls, 4);
  assert.equal(result.counts.incomplete, 3);
  assert.equal(result.counts.verified, 1);
  assert.equal(result.counts.mismatch, 0, 'an unreadable record is not proof of tampering');
  for (const row of result.results.slice(0, 3)) {
    assert.equal(row.status, 'incomplete');
    assert.ok(typeof row.warning === 'string' && row.warning.length > 0);
  }
});

test('an empty game or game without any roll records cannot be certified as verified', async () => {
  for (const history of [[], [{ from: 24, to: 18, die: 6 }]]) {
    const result = await verifier.verifyGameRolls({ history });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(plain(result.counts), { rolls: 0, verified: 0, incomplete: 0, mismatch: 0, diceVerified: 0, hashVerified: 0 });
    assert.deepEqual(plain(result.results), []);
  }
});

test('whole-game verification rejects nonnative history containers, primitive rows, and excessive history size', async () => {
  for (const game of [undefined, null, [], {}, { history: null }, { history: 'rolls' }, { history: {} },
    { history: [null] }, { history: ['roll'] }, { history: [1] }, { history: [[]] },
    { history: Array.from({ length: 5001 }, () => ({ from: 24, to: 18 })) },
  ]) {
    await assert.rejects(() => verifier.verifyGameRolls(game), error => error.code === 'INVALID_INPUT');
  }
});

test('whole-game verification freezes every selected proof before its first asynchronous digest', async () => {
  const game = { history: [historyRoll('first original seed'), historyRoll('second original seed')] };
  const promise = verifier.verifyGameRolls(game);
  game.history[1].sha256Input = 'tampered during first digest';
  game.history[1].sha256 = '0'.repeat(64);
  game.history[1].roll = '1:1';
  game.history.push({ roll: '2:4', sha256: 'broken late append' });
  const result = await promise;
  assert.equal(result.status, 'verified');
  assert.equal(result.counts.rolls, 2);
  assert.equal(result.counts.verified, 2);
  assert.equal(result.historyLength, 2, 'late appends must not change the captured game history length');
  assert.deepEqual(result.results.map(row => row.historyIndex), [0, 1]);
});

test('whole-game verification accepts the declared maximum history length without silent truncation', async () => {
  const history = Array.from({ length: 4999 }, () => ({ from: 24, to: 18, die: 6 }));
  history.push(historyRoll('last record within limit'));
  const result = await verifier.verifyGameRolls({ history });
  assert.equal(result.status, 'verified');
  assert.equal(result.counts.rolls, 1);
  assert.equal(result.results[0].historyIndex, 4999);
});

for (const roll of ['', null, 0, false, undefined]) {
  test(`whole-game verification counts an own corrupted roll field (${String(roll)}) instead of silently certifying the other rolls`, async () => {
    const corrupted = historyRoll('corrupted recorded roll', { roll });
    assert.equal(Object.hasOwn(corrupted, 'roll'), true);
    const result = await verifier.verifyGameRolls({ history: [historyRoll('valid neighboring roll'), corrupted] });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.counts.rolls, 2);
    assert.equal(result.counts.verified, 1);
    assert.equal(result.counts.incomplete, 1);
    assert.equal(result.counts.mismatch, 0);
    assert.deepEqual(result.results.map(item => item.historyIndex), [0, 1]);
    assert.equal(result.results[1].status, 'incomplete');
    assert.ok(typeof result.results[1].warning === 'string' && result.results[1].warning.length > 0);
  });
}

test('a disclosed roll proof whose recorded dice field was deleted remains visible as an incomplete roll', async () => {
  const corrupted = historyRoll('roll with deleted dice');
  delete corrupted.roll;
  const result = await verifier.verifyGameRolls({ history: [historyRoll('valid roll before missing dice'), corrupted] });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.counts.rolls, 2);
  assert.equal(result.counts.verified, 1);
  assert.equal(result.counts.incomplete, 1);
  assert.equal(result.results[1].historyIndex, 1);
});

test('a chat entry containing only unrelated SHA-256 metadata is not mistaken for a roll', async () => {
  const result = await verifier.verifyGameRolls({ history: [
    historyRoll('actual recorded roll'),
    { chat: 'message with its own content hash', sha256: sha256('chat content') },
  ] });
  assert.equal(result.status, 'verified');
  assert.equal(result.counts.rolls, 1);
  assert.deepEqual(result.results.map(item => item.historyIndex), [0]);
});

test('a self-contained signed quicknet proof verifies real BLS and the configured receipt key without duplicate input fields', async () => {
  const browser = loadBrowserVerifier({ fairDice, env: { fairDicePublicKey: TEST_RECEIPT_PUBLIC_KEY } });
  const proof = signedProof();
  const original = JSON.stringify(proof);
  const result = await browser.verifier.verifyFairRoll({ proof: JSON.stringify(proof) });
  assert.equal(result.status, 'verified');
  assert.equal(result.sourceVerified, true);
  assert.equal(result.reservationVerified, true);
  assert.equal(result.receiptKeyAvailable, true);
  assert.equal(result.diceStatus, 'verified');
  assert.equal(result.hashStatus, 'verified');
  assert.equal(result.input, proof.sha256Input);
  assert.equal(sha256(result.input), result.hash);
  assert.deepEqual(plain(result.dice), independentlyExtractDice(result.hash));
  assert.equal(JSON.stringify(proof), original);
  assert.equal(browser.networkCalls(), 0);
});

test('signed source authentication does not claim server reservation authentication without an environment-pinned key', async () => {
  const proof = { ...signedProof(), publicKey: TEST_RECEIPT_PUBLIC_KEY, serverPublicKey: TEST_RECEIPT_PUBLIC_KEY };
  for (const env of [undefined, {}, { fairDicePublicKey: '' }]) {
    const browser = loadBrowserVerifier({ fairDice, env });
    const result = await browser.verifier.verifyFairRoll({ proof });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.sourceVerified, true);
    assert.equal(result.reservationVerified, false);
    assert.equal(result.receiptKeyAvailable, false);
    assert.equal(result.diceStatus, 'verified');
    assert.equal(browser.networkCalls(), 0);
  }
});

test('the wrapper cannot promote an unpinned receipt even if a proof verifier reports reservationVerified true', async () => {
  const proof = signedProof();
  const browser = loadBrowserVerifier({ fairDice: { verifyProof: async () => ({ dice: proof.dice, hash: proof.sha256,
    input: proof.sha256Input, sourceVerified: true, reservationVerified: true }) } });
  const result = await browser.verifier.verifyFairRoll({ proof });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.reservationVerified, false);
});

test('external history dice, hash and input must independently match a signed proof and retain physical-die order', async () => {
  const browser = loadBrowserVerifier({ fairDice, env: { fairDicePublicKey: TEST_RECEIPT_PUBLIC_KEY } });
  const proof = signedProof();
  for (const options of [
    { expectedDice: [proof.dice[1], proof.dice[0]] },
    { hash: '0'.repeat(64) },
    { preimage: `${proof.sha256Input} ` },
  ]) {
    const result = await browser.verifier.verifyFairRoll({ proof, ...options });
    assert.equal(result.status, 'mismatch');
    assert.equal(result.sourceVerified, true);
    assert.equal(result.reservationVerified, true);
  }
  await assert.rejects(() => browser.verifier.verifyFairRoll({ proof, expectedDice: [2] }), error => error.code === 'INVALID_DICE');
  await assert.rejects(() => browser.verifier.verifyFairRoll({ proof, hash: 'bad' }), error => error.code === 'INVALID_HASH');
});

test('an invalid beacon signature or mismatched pinned receipt fails closed without a legacy SHA fallback', async () => {
  const browser = loadBrowserVerifier({ fairDice, env: { fairDicePublicKey: TEST_RECEIPT_PUBLIC_KEY } });
  const source = signedProof();
  const beacon = { ...source.beacon, signature: `a${source.beacon.signature.slice(1)}` };
  beacon.randomness = createHash('sha256').update(Buffer.from(beacon.signature, 'hex')).digest('hex');
  await assert.rejects(() => browser.verifier.verifyFairRoll({ proof: { ...source, beacon } }), error => error.code === 'FAIR_BEACON_SIGNATURE_INVALID');
  await assert.rejects(() => browser.verifier.verifyFairRoll({ proof: { ...source, receiptSignature: '0'.repeat(128) } }), error => error.code === 'FAIR_RECEIPT_INVALID');
  assert.equal(browser.networkCalls(), 0);
});

test('malformed, oversized and nonobject signed proofs are input errors and a missing source module is explicit', async () => {
  for (const proof of [undefined, null, [], 0, 'bad JSON', '{', '{"value":"' + 'a'.repeat(16384) + '"}']) {
    assert.throws(() => verifier.parseFairProof(proof), error => error.code === 'INVALID_INPUT');
  }
  const circular = {}; circular.self = circular;
  assert.throws(() => verifier.parseFairProof(circular), error => error.code === 'INVALID_INPUT');
  const browser = loadBrowserVerifier();
  await assert.rejects(() => browser.verifier.verifyFairRoll({ proof: signedProof() }), error => error.code === 'FAIR_PROOF_UNAVAILABLE');
});

test('signed verification snapshots the proof, expected dice and configured receipt key before any asynchronous work', async () => {
  const proof = signedProof();
  const original = plain(proof);
  const expectedDice = [...proof.dice];
  const env = { fairDicePublicKey: TEST_RECEIPT_PUBLIC_KEY };
  let proceed;
  const wait = new Promise(resolve => { proceed = resolve; });
  const captured = [];
  const browser = loadBrowserVerifier({ env, fairDice: { verifyProof: async (input, options) => {
    captured.push({ input, options });
    await wait;
    return fairDice.verifyProof(input, options);
  } } });
  const pending = browser.verifier.verifyFairRoll({ proof, expectedDice });
  proof.request.round += 1;
  proof.beacon.signature = '0'.repeat(96);
  expectedDice[0] = expectedDice[0] === 6 ? 1 : expectedDice[0] + 1;
  env.fairDicePublicKey = '0'.repeat(64);
  proceed();
  const result = await pending;
  assert.equal(result.status, 'verified');
  assert.deepEqual(plain(captured[0].input), original);
  assert.equal(captured[0].options.publicKey, TEST_RECEIPT_PUBLIC_KEY);
});

test('whole-game signed verification checks room, purpose, player color, common game epoch and contiguous newest-first nonces', async () => {
  const browser = loadBrowserVerifier({ fairDice, env: { fairDicePublicKey: TEST_RECEIPT_PUBLIC_KEY } });
  const opening = signedProof();
  const ordinary = signedProof({ nonce: 2, label: 'roll', color: 'white' });
  const game = { roomCode: 'ABCD-EFGH', variant: 'long', history: [signedHistory(ordinary), signedHistory(opening)] };
  const result = await browser.verifier.verifyGameRolls(game);
  assert.equal(result.status, 'verified');
  assert.deepEqual(plain(result.sourceCounts), { signed: 2, sourceVerified: 2, reservationVerified: 2 });
  for (const corrupt of [
    { ...game, roomCode: 'EFGH-ABCD' },
    { ...game, variant: 'short' },
    { ...game, history: [{ ...signedHistory(ordinary), color: 'dark' }, signedHistory(opening)] },
    { ...game, history: [signedHistory(opening), signedHistory(ordinary)] },
    { ...game, history: [signedHistory(ordinary), signedHistory(ordinary)] },
    { ...game, history: [signedHistory(signedProof({ nonce: 3, label: 'roll', color: 'white' })), signedHistory(opening)] },
    { ...game, history: [signedHistory(signedProof({ nonce: 2, label: 'roll', color: 'white', gameId: '22222222-2222-4222-8222-222222222222' })), signedHistory(opening)] },
  ]) {
    const failed = await browser.verifier.verifyGameRolls(corrupt);
    assert.equal(failed.status, 'mismatch');
    assert.ok(failed.counts.mismatch > 0);
  }
});

test('a corrupted or missing signed proof is not silently replaced with a matching legacy proof', async () => {
  const browser = loadBrowserVerifier({ fairDice, env: { fairDicePublicKey: TEST_RECEIPT_PUBLIC_KEY } });
  const legacy = historyRoll('otherwise valid legacy input', { color: 'white' });
  for (const fairDiceProof of [null, undefined, 0, {}, []]) {
    const result = await browser.verifier.verifyGameRolls({ history: [{ ...legacy, fairDiceProof }] });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.counts.verified, 0);
    assert.equal(result.sourceCounts.signed, 1);
    assert.equal(result.sourceCounts.sourceVerified, 0);
  }
});

test('a mixed legacy/signed history reports each protocol without claiming all roll sources are signed', async () => {
  const browser = loadBrowserVerifier({ fairDice, env: { fairDicePublicKey: TEST_RECEIPT_PUBLIC_KEY } });
  const result = await browser.verifier.verifyGameRolls({ history: [historyRoll('legacy recorded input'), signedHistory(signedProof())] });
  assert.equal(result.status, 'verified');
  assert.equal(result.counts.rolls, 2);
  assert.deepEqual(plain(result.sourceCounts), { signed: 1, sourceVerified: 1, reservationVerified: 1 });
});
