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

function loadBrowserVerifier() {
  let networkCalls = 0;
  const math = Object.create(Math);
  math.random = () => { throw new Error('random fallback must not be used by a verifier'); };
  const context = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    Math: math,
    fetch: () => { networkCalls += 1; throw new Error('verification must remain local'); },
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game-verifier.js'), 'utf8'), context, {
    filename: 'game-verifier.js',
  });
  return { verifier: context.NarduVerify, networkCalls: () => networkCalls };
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
