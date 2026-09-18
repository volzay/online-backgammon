const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const verifier = require('../game-verifier.js');
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const fairDice = require('../fair-dice.js');
const FIXTURE_KEY = '11'.repeat(32);
const FIXTURE_PUBLIC_KEY = fairDice.receiptPublicKey(FIXTURE_KEY);
function signedProof({ nonce = 1, label = 'opening', color = 'none', gameId = '22222222-2222-4222-8222-222222222222' } = {}) {
  const request = { id: `${String(nonce).padStart(8, '0')}-1111-4111-8111-111111111111`, roomCode: 'ABCD-EFGH',
    gameId, nonce, label, color, variant: 'long', round: 1000,
    createdAt: new Date(fairDice.roundTime(1000) - 6000).toISOString(), positionHash: 'a'.repeat(64) };
  const beacon = { round: 1000, signature: 'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39',
    randomness: 'fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd' };
  const receipt = fairDice.signReservation(request, FIXTURE_KEY);
  const derived = fairDice.deriveDice(request, beacon.randomness);
  return { protocol: fairDice.PROTOCOL, ...receipt, chainHash: fairDice.CHAIN.hash, beacon,
    sha256: derived.hash, sha256Input: derived.input, dice: derived.dice, rerolls: derived.rerolls };
}
function signedHistory(proof) {
  return { ...(proof.request.label === 'opening' ? { opening: true, host: proof.dice[0], guest: proof.dice[1] }
    : { roll: proof.dice.join(':'), color: proof.request.color }),
    sha256: proof.sha256, sha256Input: proof.sha256Input, fairDiceProof: proof };
}

class InlineElement {
  constructor() {
    this.attributes = new Map();
    this.dataset = {};
    this.disabled = false;
    this.hidden = true;
    this.isConnected = true;
    this.textContent = '';
    this.parent = null;
    this.output = null;
  }
  set innerHTML(_) { throw new Error('inline verification results must remain plain text'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) {
    return ['[data-game-result]', '[data-roll-result]'].includes(selector) ? this.output : null;
  }
  closest(selector) {
    if (selector === '[data-copy-roll-input], [data-copy-roll-proof]') {
      return this.hasAttribute('data-copy-roll-input') || this.hasAttribute('data-copy-roll-proof') ? this : null;
    }
    if (selector === '[data-open-roll-verifier]') return this.hasAttribute('data-open-roll-verifier') ? this : null;
    if (selector === '[data-verify-roll], [data-verify-game]') return this;
    if (selector === '[data-verifier-context]' || selector === '.fair-hash, .history-proof') return this.parent;
    return null;
  }
}

function createInlineUI({ api = verifier, lang = 'ru', loadCore = false, fairApi = fairDice, env, clipboard, transfer, open } = {}) {
  const handlers = new Map();
  const pending = [];
  const calls = [];
  let networkCalls = 0;
  let storageCalls = 0;
  const document = {
    documentElement: { lang },
    addEventListener(name, handler) { handlers.set(name, handler); },
  };
  const forbiddenStorage = new Proxy({}, {
    get() { storageCalls += 1; throw new Error('inline checking must not access account storage'); },
  });
  const context = vm.createContext({
    document,
    NarduVerify: api,
    NarduFairDice: fairApi,
    NARDU_ENV: env,
    navigator: { clipboard },
    crypto: webcrypto,
    TextEncoder,
    URL,
    location: new URL('https://volzay.github.io/online-backgammon/room.html'),
    NarduRollProofTransfer: transfer,
    open,
    localStorage: forbiddenStorage,
    sessionStorage: forbiddenStorage,
    fetch: () => { networkCalls += 1; throw new Error('inline checking must not make API requests'); },
  });
  context.window = context;
  if (loadCore) vm.runInContext(fs.readFileSync(path.join(ROOT, 'game-verifier.js'), 'utf8'), context, {
    filename: 'game-verifier.js',
  });
  const implementation = context.NarduVerify;
  const tracked = { ...implementation };
  for (const method of ['verifyPortalRoll', 'verifyFairRoll', 'verifyGameRolls']) {
    if (typeof implementation[method] !== 'function') continue;
    tracked[method] = input => {
      calls.push({ method, input });
      const work = Promise.resolve().then(() => implementation[method](input));
      pending.push(work);
      return work;
    };
  }
  context.NarduVerify = tracked;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'roll-verification-ui.js'), 'utf8'), context, {
    filename: 'roll-verification-ui.js',
  });
  return {
    api: context.NarduVerifyUI,
    document,
    calls,
    beginClick(button) {
      let prevented = false;
      handlers.get('click')({ target: button, preventDefault() { prevented = true; } });
      return prevented;
    },
    async finish() {
      await Promise.allSettled(pending.splice(0));
      await Promise.resolve();
    },
    async click(button) { this.beginClick(button); await this.finish(); },
    assertLocal() { assert.equal(networkCalls, 0); assert.equal(storageCalls, 0); },
  };
}

function rollControl(item, context = { roomCode: 'ABCD-EFGH', variant: 'long' }) {
  const proof = verifier.portalRollFromHistory(item);
  const parent = new InlineElement();
  const output = new InlineElement();
  const button = new InlineElement();
  parent.output = output;
  button.parent = parent;
  button.textContent = 'Проверить';
  button.setAttribute('data-verify-roll', '');
  button.dataset.verifyHash = proof.hash;
  button.dataset.verifyDice = proof.expectedDice.join(',');
  if (proof.preimage !== undefined) button.dataset.verifyInput = proof.preimage;
  if (Object.hasOwn(item, 'fairDiceProof')) {
    button.setAttribute('data-verify-fair-proof', '');
    button.dataset.verifyFairProof = JSON.stringify(item.fairDiceProof);
    button.setAttribute('data-verify-fair-context', '');
    button.dataset.verifyFairContext = JSON.stringify({ ...context, label: item.opening ? 'opening' : 'roll',
      color: item.opening ? 'none' : item.color });
  }
  return { parent, button, output };
}

function wholeGameControl(ui, game) {
  const parent = new InlineElement();
  const output = new InlineElement();
  const button = new InlineElement();
  parent.output = output;
  button.parent = parent;
  button.textContent = 'Проверить броски';
  button.setAttribute('data-verify-game', '');
  ui.api.setGameContext(parent, game);
  return { parent, button, output };
}

function fullRoll(seed) {
  const hash = sha256(seed);
  return { sha256: hash, sha256Input: seed, roll: verifier.diceFromHash(hash).dice.join(':') };
}

test('the actual shared click handler passes only the clicked roll hash, ordered dice and exact recorded input', async () => {
  const seed = '  nardu|ВащеППЦ|🎲\n';
  const item = fullRoll(seed);
  const ui = createInlineUI();
  const control = rollControl(item);
  assert.equal(ui.beginClick(control.button), true);
  assert.equal(control.button.disabled, true);
  assert.equal(control.button.attributes.get('aria-busy'), 'true');
  await ui.finish();
  assert.deepEqual(plain(ui.calls[0].input), { hash: item.sha256, expectedDice: item.roll.replace(':', ','), preimage: seed });
  assert.equal(control.output.dataset.status, 'matched');
  assert.match(control.output.textContent, /Кости.*соответствуют хешу/);
  assert.match(control.output.textContent, /Протокол этой записи не содержит независимую подпись источника/);
  assert.doesNotMatch(control.output.textContent, /Проверка пройдена/);
  assert.equal(control.button.disabled, false);
  assert.equal(control.button.hasAttribute('aria-busy'), false);
  assert.equal(control.button.textContent, 'Проверить');
  assert.equal(control.output.hidden, false);
  ui.assertLocal();
});

test('historical matching hash/dice uses a neutral consistency badge rather than a fair-source badge', async () => {
  const ui = createInlineUI();
  const control = rollControl({ sha256: `0103${'ff'.repeat(30)}`, roll: '2:4' });
  await ui.click(control.button);
  assert.equal(control.output.dataset.status, 'matched');
  assert.match(control.output.textContent, /Кости 2:4 соответствуют хешу/);
  assert.match(control.output.textContent, /Протокол этой записи не раскрывает исходную строку или независимую подпись источника/);
  assert.doesNotMatch(control.output.textContent, /Проверка пройдена/);
  assert.equal(Object.hasOwn(ui.calls[0].input, 'preimage'), true);
  assert.equal(ui.calls[0].input.preimage, undefined);
  ui.assertLocal();
});

test('a recorded roll mismatch or wrong preimage is published as mismatch by the actual inline handler', async () => {
  const wrongInput = fullRoll('original roll input');
  wrongInput.sha256Input += ' changed';
  for (const item of [{ sha256: `0103${'ff'.repeat(30)}`, roll: '4:2' }, wrongInput]) {
    const ui = createInlineUI();
    const control = rollControl(item);
    await ui.click(control.button);
    assert.equal(control.output.dataset.status, 'mismatch');
    assert.match(control.output.textContent, /Обнаружено несовпадение/);
    ui.assertLocal();
  }
});

test('an inline input or cryptography error remains incomplete and restores the button without HTML insertion', async () => {
  const hostile = '<img src=x onerror="throw 1">';
  const ui = createInlineUI({ api: { ...verifier, verifyPortalRoll: async () => { throw new Error(hostile); } } });
  const control = rollControl({ sha256: `0103${'ff'.repeat(30)}`, roll: '2:4' });
  await ui.click(control.button);
  assert.equal(control.output.dataset.status, 'incomplete');
  assert.ok(control.output.textContent.includes(hostile));
  assert.equal(control.button.disabled, false);
  assert.equal(control.button.hasAttribute('aria-busy'), false);
  ui.assertLocal();
});

test('whole-game clicks use the bound room or archive context independently and leave both game objects unchanged', async () => {
  const room = { history: [fullRoll('current room roll')] };
  const archive = { history: [{ sha256: `0103${'ff'.repeat(30)}`, roll: '2:4' }] };
  const originals = [JSON.stringify(room), JSON.stringify(archive)];
  const ui = createInlineUI();
  const roomControl = wholeGameControl(ui, room);
  const archiveControl = wholeGameControl(ui, archive);
  await ui.click(archiveControl.button);
  assert.equal(ui.calls[0].input, archive);
  assert.equal(archiveControl.output.dataset.status, 'matched');
  assert.match(archiveControl.output.textContent, /Записей без полного доказательства источника: 1/);
  await ui.click(roomControl.button);
  assert.equal(ui.calls[1].input, room);
  assert.equal(roomControl.output.dataset.status, 'matched');
  assert.match(roomControl.output.textContent, /SHA-256 исходной строки совпал: 1/);
  assert.match(roomControl.output.textContent, /Старые SHA-записи подтверждают соответствие, а не независимый источник/);
  assert.match(roomControl.output.textContent, /Законность перемещения шашек не проверяется/);
  assert.deepEqual([JSON.stringify(room), JSON.stringify(archive)], originals);
  ui.assertLocal();
});

test('whole-game mismatches report the correct displayed history-entry numbers', async () => {
  const wrong = fullRoll('archived wrong roll');
  wrong.sha256Input += ' wrong';
  const ui = createInlineUI();
  const control = wholeGameControl(ui, { history: [wrong, { from: 24, to: 18 }, fullRoll('another good roll')] });
  await ui.click(control.button);
  assert.equal(control.output.dataset.status, 'mismatch');
  assert.match(control.output.textContent, /Несовпадений: 1/);
  assert.match(control.output.textContent, /Записи истории: 3\./);
  ui.assertLocal();
});

test('a detached roll output never receives a completed asynchronous result from a stale page view', async () => {
  let resolve;
  const work = new Promise(done => { resolve = done; });
  const ui = createInlineUI({ api: { ...verifier, verifyPortalRoll: () => work } });
  const control = rollControl({ sha256: `0103${'ff'.repeat(30)}`, roll: '2:4' });
  ui.beginClick(control.button);
  control.output.isConnected = false;
  resolve({ status: 'verified', diceStatus: 'verified', hashStatus: 'verified', dice: [2, 4] });
  await ui.finish();
  assert.equal(control.output.dataset.status, 'incomplete');
  assert.equal(control.output.textContent, 'Проверяем…');
  assert.equal(control.button.disabled, false);
  ui.assertLocal();
});

test('a detached whole-game output cannot be updated by a completed check for an older archive', async () => {
  let resolve;
  const work = new Promise(done => { resolve = done; });
  const ui = createInlineUI({ api: { ...verifier, verifyGameRolls: () => work } });
  const control = wholeGameControl(ui, { history: [fullRoll('old archive roll')] });
  ui.beginClick(control.button);
  control.output.isConnected = false;
  resolve({ status: 'verified', counts: { rolls: 1, diceVerified: 1, hashVerified: 1, mismatch: 0, incomplete: 0 }, results: [] });
  await ui.finish();
  assert.equal(control.output.dataset.status, 'incomplete');
  assert.equal(control.output.textContent, 'Проверяем…');
  assert.equal(control.button.disabled, false);
  ui.assertLocal();
});

test('the delegated handler ignores a disabled button and starts no duplicate check while its digest is pending', async () => {
  let resolve;
  const work = new Promise(done => { resolve = done; });
  const ui = createInlineUI({ api: { ...verifier, verifyPortalRoll: () => work } });
  const control = rollControl({ sha256: `0103${'ff'.repeat(30)}`, roll: '2:4' });
  ui.beginClick(control.button);
  assert.equal(ui.beginClick(control.button), false);
  assert.equal(ui.calls.length, 1);
  resolve({ status: 'incomplete', diceStatus: 'verified', hashStatus: 'unavailable', dice: [2, 4] });
  await ui.finish();
  assert.equal(control.output.dataset.status, 'matched');
  assert.equal(control.button.disabled, false);
  ui.assertLocal();
});

test('the shared controls and handler render English results while retaining the same incomplete-proof semantics', async () => {
  const ui = createInlineUI({ lang: 'en' });
  const item = { sha256: `0103${'ff'.repeat(30)}`, roll: '2:4' };
  assert.match(ui.api.rollControls(item), />Check roll</);
  assert.match(ui.api.rollControls(item), />Details</);
  const control = rollControl(item);
  await ui.click(control.button);
  assert.equal(control.output.dataset.status, 'matched');
  assert.match(control.output.textContent, /does not disclose the input or an independent source signature/);
  ui.assertLocal();
});

test('a pending whole-game result cannot certify a newer history rebound to the same connected panel', async () => {
  const game = { roomCode: 'ROOM-A', history: [fullRoll('old one-roll history')] };
  const oldResult = await verifier.verifyGameRolls(game);
  let resolve;
  const work = new Promise(done => { resolve = done; });
  const ui = createInlineUI({ api: { ...verifier, verifyGameRolls: () => work } });
  const control = wholeGameControl(ui, game);
  ui.beginClick(control.button);
  game.history.push(fullRoll('new roll added while digest is pending'));
  ui.api.setGameContext(control.parent, game);
  resolve(oldResult);
  await ui.finish();
  assert.notEqual(control.output.dataset.status, 'verified');
  assert.doesNotMatch(control.output.textContent, /Бросков: 1\./);
  assert.equal(control.button.disabled, false);
  ui.assertLocal();
});

test('a pending whole-game result is discarded when its bound history mutates without a context refresh', async () => {
  const game = { roomCode: 'ROOM-A', history: [fullRoll('original checked input')] };
  const oldResult = await verifier.verifyGameRolls(game);
  let resolve;
  const work = new Promise(done => { resolve = done; });
  const ui = createInlineUI({ api: { ...verifier, verifyGameRolls: () => work } });
  const control = wholeGameControl(ui, game);
  ui.beginClick(control.button);
  game.history[0].sha256Input += ' silently changed';
  resolve(oldResult);
  await ui.finish();
  assert.notEqual(control.output.dataset.status, 'verified');
  assert.doesNotMatch(control.output.textContent, /SHA-256 исходной строки совпал: 1/);
  assert.equal(control.button.disabled, false);
  ui.assertLocal();
});

test('rebinding an already verified panel to a new game or changed history clears its finished proof', async () => {
  const ui = createInlineUI();
  const original = { roomCode: 'ROOM-A', history: [fullRoll('finished verified input')] };
  const control = wholeGameControl(ui, original);
  await ui.click(control.button);
  assert.equal(control.output.dataset.status, 'matched');
  original.history.push(fullRoll('second roll after finished proof'));
  ui.api.setGameContext(control.parent, original);
  assert.notEqual(control.output.dataset.status, 'verified');
  assert.doesNotMatch(control.output.textContent, /Бросков: 1\./);
  await ui.click(control.button);
  assert.equal(control.output.dataset.status, 'matched');
  const otherRoom = { roomCode: 'ROOM-B', history: plain(original.history) };
  ui.api.setGameContext(control.parent, otherRoom);
  assert.notEqual(control.output.dataset.status, 'verified');
  ui.assertLocal();
});

test('an identical no-op context rerender preserves an already finished verification result', async () => {
  const ui = createInlineUI();
  const game = { roomCode: 'ROOM-A', history: [fullRoll('unchanged verified input')] };
  const control = wholeGameControl(ui, game);
  await ui.click(control.button);
  const text = control.output.textContent;
  ui.api.setGameContext(control.parent, game);
  assert.equal(control.output.dataset.status, 'matched');
  assert.equal(control.output.textContent, text);
  ui.api.setGameContext(control.parent, plain(game));
  assert.equal(control.output.dataset.status, 'matched');
  assert.equal(control.output.textContent, text);
  ui.assertLocal();
});

test('the shared inline verifier checks a real pinned signed roll and its externally supplied room context without any legacy fallback', async () => {
  const proof = signedProof();
  const item = signedHistory(proof);
  const original = JSON.stringify(item);
  const ui = createInlineUI({ loadCore: true, env: { fairDicePublicKey: FIXTURE_PUBLIC_KEY } });
  const control = rollControl(item);
  await ui.click(control.button);
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].method, 'verifyFairRoll');
  assert.deepEqual(plain(ui.calls[0].input.context), { roomCode: 'ABCD-EFGH', variant: 'long', label: 'opening', color: 'none' });
  assert.equal(ui.calls[0].input.proof, JSON.stringify(proof));
  assert.equal(ui.calls[0].input.preimage, proof.sha256Input);
  assert.equal(control.output.dataset.status, 'verified');
  assert.match(control.output.textContent, /Проверка пройдена\. Источник броска подтверждён, кости рассчитаны верно\./);
  assert.match(control.output.textContent, /Игроки и боты используют один независимый источник drand/);
  assert.equal(control.button.disabled, false);
  assert.equal(JSON.stringify(item), original);
  ui.assertLocal();
});

test('the shared signed-source result remains incomplete without a pinned key even when the proof contains its own receipt public key', async () => {
  const proof = { ...signedProof(), publicKey: FIXTURE_PUBLIC_KEY };
  const ui = createInlineUI({ loadCore: true });
  const control = rollControl(signedHistory(proof));
  await ui.click(control.button);
  assert.equal(ui.calls[0].method, 'verifyFairRoll');
  assert.equal(control.output.dataset.status, 'incomplete');
  assert.match(control.output.textContent, /Подпись drand подтверждена/);
  assert.match(control.output.textContent, /Резервирование не подтверждено настроенным ключом сервера/);
  assert.doesNotMatch(control.output.textContent, /Проверка пройдена|Подписанная серверная запись подтверждена/);
  ui.assertLocal();
});

test('invalid signed receipts, source signatures, JSON and transplanted room proofs do not fall back to matching legacy dice', async () => {
  const valid = signedProof();
  const wrongSignature = plain(valid);
  wrongSignature.beacon.signature = `${wrongSignature.beacon.signature[0] === 'a' ? 'b' : 'a'}${wrongSignature.beacon.signature.slice(1)}`;
  wrongSignature.beacon.randomness = createHash('sha256').update(Buffer.from(wrongSignature.beacon.signature, 'hex')).digest('hex');
  for (const { proof, context, expected } of [
    { proof: { ...valid, receiptSignature: '00'.repeat(64) }, expected: /Подпись серверной записи не соответствует настроенному ключу/ },
    { proof: wrongSignature, expected: /Подпись независимого источника не прошла проверку/ },
    { proof: valid, context: { roomCode: 'WXYZ-ABCD', variant: 'long' }, expected: /Доказательство относится к другому броску или партии/ },
    { proof: null, expected: /Проверка недоступна/ },
  ]) {
    const ui = createInlineUI({ loadCore: true, env: { fairDicePublicKey: FIXTURE_PUBLIC_KEY } });
    const control = rollControl({ ...signedHistory(valid), fairDiceProof: proof }, context);
    await ui.click(control.button);
    assert.equal(ui.calls[0].method, 'verifyFairRoll');
    assert.equal(control.output.dataset.status, 'incomplete');
    assert.match(control.output.textContent, expected);
    assert.doesNotMatch(control.output.textContent, /Проверка пройдена|соответствуют хешу/);
    assert.equal(control.button.disabled, false);
    ui.assertLocal();
  }
  const malformed = createInlineUI({ loadCore: true, env: { fairDicePublicKey: FIXTURE_PUBLIC_KEY } });
  const control = rollControl(signedHistory(valid));
  control.button.dataset.verifyFairProof = '{not JSON';
  await malformed.click(control.button);
  assert.equal(malformed.calls[0].method, 'verifyFairRoll');
  assert.equal(control.output.dataset.status, 'incomplete');
  malformed.assertLocal();
});

test('signed controls escape the complete source JSON and room context and keep all proof/input data out of the page URL', () => {
  const ui = createInlineUI();
  const hostile = '<img src=x onerror="throw 1">&\'"';
  const proof = { ...signedProof(), note: hostile };
  const item = { ...signedHistory(proof), password: 'secret-password', token: 'account-token' };
  const markup = ui.api.rollControls(item, { context: { roomCode: 'ABCD-EFGH', variant: 'long', token: 'context-token' } });
  assert.match(markup, /data-verify-fair-proof="/);
  assert.match(markup, /data-verify-fair-context="\{&quot;roomCode&quot;:&quot;ABCD-EFGH&quot;,&quot;variant&quot;:&quot;long&quot;,&quot;label&quot;:&quot;opening&quot;,&quot;color&quot;:&quot;none&quot;\}"/);
  assert.match(markup, /&lt;img src=x onerror=/);
  assert.doesNotMatch(markup, /<img|secret-password|account-token|context-token/);
  assert.ok(markup.includes(proof.sha256Input));
  assert.ok(markup.includes(proof.beacon.signature));
  assert.ok(markup.includes(proof.chainHash));
  assert.match(markup, /Исходная строка SHA-256 \(целиком\)|JSON-доказательство броска/);
  const href = markup.match(/data-verifier-url="([^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.match(href, /^verify-game\.html#hash=[0-9a-f]{64}&dice=/);
  for (const value of [proof.sha256Input, proof.request.id, proof.receiptSignature, proof.beacon.signature, proof.chainHash, 'proof', 'seed', 'password', 'token']) {
    assert.ok(!href.includes(value), `${value} must not enter the public verification URL`);
  }
  const hostileContext = ui.api.rollControls(item, { context: { roomCode: hostile, variant: 'long' } });
  assert.doesNotMatch(hostileContext, /<img/);
  assert.match(hostileContext, /&lt;img/);
  ui.assertLocal();
});

test('complete signed game history gets a full source badge while mixed protocols and noncontiguous signed histories never do', async () => {
  const opening = signedHistory(signedProof());
  const roll = signedHistory(signedProof({ nonce: 2, label: 'roll', color: 'dark' }));
  const ui = createInlineUI({ loadCore: true, env: { fairDicePublicKey: FIXTURE_PUBLIC_KEY } });
  const game = { roomCode: 'ABCD-EFGH', variant: 'long', history: [roll, opening] };
  const original = JSON.stringify(game);
  const full = wholeGameControl(ui, game);
  await ui.click(full.button);
  assert.equal(full.output.dataset.status, 'verified');
  assert.match(full.output.textContent, /Проверка пройдена\. Источники всех записанных бросков и кости подтверждены/);
  assert.match(full.output.textContent, /Подписи drand подтверждены: 2\/2\. Серверные записи подтверждены: 2\/2/);
  assert.match(full.output.textContent, /Записей без полного доказательства источника: 0/);
  assert.equal(JSON.stringify(game), original);
  const mixed = wholeGameControl(ui, { roomCode: 'ABCD-EFGH', variant: 'long', history: [fullRoll('legacy-one-use-source'), opening] });
  await ui.click(mixed.button);
  assert.equal(mixed.output.dataset.status, 'incomplete');
  assert.doesNotMatch(mixed.output.textContent, /Проверка пройдена/);
  assert.match(mixed.output.textContent, /Записей без полного доказательства источника: 1/);
  assert.match(mixed.output.textContent, /Старые SHA-записи подтверждают соответствие, а не независимый источник/);
  const gap = wholeGameControl(ui, { roomCode: 'ABCD-EFGH', variant: 'long',
    history: [signedHistory(signedProof({ nonce: 3, label: 'roll', color: 'dark' })), opening] });
  await ui.click(gap.button);
  assert.equal(gap.output.dataset.status, 'mismatch');
  assert.doesNotMatch(gap.output.textContent, /Проверка пройдена/);
  ui.assertLocal();
});

test('changing a signed proof or externally expected context on a connected roll during a pending check discards success and error results', async () => {
  const proof = signedProof();
  for (const field of ['verifyFairProof', 'verifyFairContext', 'verifyDice', 'verifyInput']) {
    for (const rejected of [false, true]) {
      let resolve;
      let reject;
      const work = new Promise((done, fail) => { resolve = done; reject = fail; });
      const ui = createInlineUI({ api: { ...verifier, verifyFairRoll: () => work } });
      const control = rollControl(signedHistory(proof));
      ui.beginClick(control.button);
      control.button.dataset[field] += ' changed';
      if (rejected) reject(new Error('stale source failure'));
      else resolve({ status: 'verified', protocol: fairDice.PROTOCOL, sourceVerified: true, reservationVerified: true,
        diceStatus: 'verified', hashStatus: 'verified', dice: proof.dice });
      await ui.finish();
      assert.equal(control.output.textContent, '');
      assert.equal(control.output.hidden, true);
      assert.equal(control.output.dataset.status, undefined);
      assert.equal(control.button.disabled, false);
      ui.assertLocal();
    }
  }
});

test('a nested signed-proof mutation invalidates pending whole-game checks and clears finished checks, while an identical rerender preserves them', async () => {
  const proof = signedProof();
  const game = { roomCode: 'ABCD-EFGH', variant: 'long', history: [signedHistory(proof)] };
  const actual = createInlineUI({ loadCore: true, env: { fairDicePublicKey: FIXTURE_PUBLIC_KEY } });
  const complete = wholeGameControl(actual, game);
  await actual.click(complete.button);
  assert.equal(complete.output.dataset.status, 'verified');
  const finished = complete.output.textContent;
  actual.api.setGameContext(complete.parent, plain(game));
  assert.equal(complete.output.dataset.status, 'verified');
  assert.equal(complete.output.textContent, finished);
  game.history[0].fairDiceProof.beacon.signature = '00'.repeat(48);
  actual.api.setGameContext(complete.parent, game);
  assert.equal(complete.output.textContent, '');
  assert.equal(complete.output.dataset.status, undefined);
  for (const refresh of [false, true]) {
    const current = { roomCode: 'ABCD-EFGH', variant: 'long', history: [signedHistory(signedProof())] };
    let resolve;
    const work = new Promise(done => { resolve = done; });
    const ui = createInlineUI({ api: { ...verifier, verifyGameRolls: () => work } });
    const control = wholeGameControl(ui, current);
    ui.beginClick(control.button);
    current.history[0].fairDiceProof.request.positionHash = 'b'.repeat(64);
    if (refresh) ui.api.setGameContext(control.parent, current);
    resolve({ status: 'verified', counts: { rolls: 1, diceVerified: 1, hashVerified: 1, mismatch: 0 },
      sourceCounts: { signed: 1, sourceVerified: 1, reservationVerified: 1 }, results: [] });
    await ui.finish();
    assert.equal(control.output.textContent, '');
    assert.equal(control.output.dataset.status, undefined);
    ui.assertLocal();
  }
  actual.assertLocal();
});

test('copying complete inline source input or proof JSON is explicit and local, bounded, and never starts a verification check', async () => {
  const writes = [];
  const ui = createInlineUI({ clipboard: { writeText: async value => writes.push(value) } });
  const proof = signedProof();
  ui.api.rollControls(signedHistory(proof));
  assert.equal(writes.length, 0);
  for (const [kind, value] of [['input', proof.sha256Input], ['proof', JSON.stringify(proof)]]) {
    const copy = new InlineElement();
    copy.setAttribute(`data-copy-roll-${kind}`, '');
    copy.dataset.copyValue = value;
    assert.equal(ui.beginClick(copy), true);
    await ui.finish();
    await Promise.resolve();
    assert.equal(writes.at(-1), value);
    assert.equal(copy.textContent, 'Скопировано');
  }
  const oversize = new InlineElement();
  oversize.setAttribute('data-copy-roll-input', '');
  oversize.dataset.copyValue = 'x'.repeat(16385);
  ui.beginClick(oversize);
  await ui.finish();
  assert.equal(writes.length, 2);
  assert.equal(ui.calls.length, 0);
  ui.assertLocal();
});

function fullVerificationControl(item) {
  const control = rollControl(item);
  const full = new InlineElement();
  full.setAttribute('data-open-roll-verifier', '');
  full.dataset.verifierUrl = verifier.verificationUrl(item);
  full.parent = control.parent;
  control.parent.querySelector = selector => selector === '[data-verify-roll]' ? control.button
    : selector === '[data-roll-result]' ? control.output : null;
  return { ...control, full };
}

test('signed full-check action transfers only the selected complete roll and removes opener before loading the verifier', async () => {
  const proof = signedProof();
  const transferred = [];
  const navigated = [];
  const tab = { opener: 'source-page', location: { replace(url) { assert.equal(tab.opener, null); navigated.push(url); } } };
  const token = 'ab'.repeat(24);
  const ui = createInlineUI({ transfer: { publish(value) { transferred.push(plain(value)); return { token, close() {} }; } },
    open(url, target) { assert.equal(url, 'about:blank'); assert.equal(target, '_blank'); return tab; } });
  const control = fullVerificationControl(signedHistory(proof));
  await ui.click(control.full);
  assert.equal(ui.calls.length, 0, 'the verifier tab performs verification, not the source page');
  assert.equal(transferred.length, 1);
  assert.deepEqual(transferred[0], { hash: proof.sha256, expectedDice: proof.dice.join(','), preimage: proof.sha256Input,
    proof: JSON.stringify(proof), context: { roomCode: 'ABCD-EFGH', variant: 'long', label: 'opening', color: 'none' } });
  const url = new URL(navigated[0]);
  assert.equal(url.origin, 'https://volzay.github.io');
  assert.equal(url.pathname, '/online-backgammon/verify-game.html');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('transfer'), token);
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('protocol'), fairDice.PROTOCOL);
  assert.equal(url.href.includes(proof.sha256Input), false);
  assert.equal(url.search, '');
  ui.assertLocal();
});

test('blocked tabs, missing channels and navigation errors check the same signed roll inline without opening an incomplete page', async () => {
  const proof = signedProof();
  for (const reason of ['popup', 'channel', 'navigation', 'destination']) {
    let released = 0;
    let closed = 0;
    let opened = 0;
    const ui = createInlineUI({ loadCore: true, env: { fairDicePublicKey: FIXTURE_PUBLIC_KEY },
      transfer: reason === 'channel' ? undefined : { publish() { return { token: 'ab'.repeat(24), close() { released += 1; } }; } },
      open() { opened += 1; return reason === 'popup' ? null : { opener: 'source', location: { replace() { throw new Error('Navigation blocked'); } }, close() { closed += 1; } }; } });
    const control = fullVerificationControl(signedHistory(proof));
    if (reason === 'destination') control.full.dataset.verifierUrl = 'https://untrusted.example/verify-game.html#hash=' + proof.sha256;
    await ui.click(control.full);
    assert.equal(control.output.dataset.status, 'verified', reason);
    assert.equal(ui.calls[0].method, 'verifyFairRoll');
    assert.equal(ui.calls[0].input.proof, JSON.stringify(proof));
    assert.equal(opened, ['channel', 'destination'].includes(reason) ? 0 : 1);
    assert.equal(released, ['channel', 'destination'].includes(reason) ? 0 : 1);
    assert.equal(closed, reason === 'navigation' ? 1 : 0);
    ui.assertLocal();
  }
});

test('full-check ignores stale or busy controls and visible JSON copying is outside both disclosure sections', async () => {
  const ui = createInlineUI({ transfer: { publish() { throw new Error('Must not publish'); } }, open() { throw new Error('Must not open'); } });
  const item = signedHistory(signedProof());
  const control = fullVerificationControl(item);
  control.full.isConnected = false;
  await ui.click(control.full);
  control.full.isConnected = true;
  control.button.disabled = true;
  await ui.click(control.full);
  assert.equal(ui.calls.length, 0);
  const markup = ui.api.rollControls(item);
  assert.match(markup, />Полная проверка<.*>Скопировать JSON</);
  assert.ok(markup.indexOf('data-copy-roll-proof') < markup.indexOf('<details'));
  assert.doesNotMatch(markup, /<a[^>]*target="_blank"/);
  assert.equal((markup.match(/data-copy-roll-proof/g) || []).length, 1);
  ui.assertLocal();
});

test('inconsistent source flags cannot show a full source badge when dice are unavailable or any server signature is unverified', async () => {
  const proof = signedProof();
  for (const result of [
    { diceStatus: 'unavailable', reservationVerified: true },
    { diceStatus: 'verified', reservationVerified: false },
    { diceStatus: 'verified', reservationVerified: true, sourceVerified: false },
  ]) {
    const ui = createInlineUI({ api: { ...verifier, verifyFairRoll: async () => ({ status: 'verified', protocol: fairDice.PROTOCOL,
      sourceVerified: true, hashStatus: 'verified', dice: proof.dice, ...result }) } });
    const control = rollControl(signedHistory(proof));
    await ui.click(control.button);
    assert.equal(control.output.dataset.status, 'incomplete');
    assert.doesNotMatch(control.output.textContent, /Проверка пройдена/);
    ui.assertLocal();
  }
  const empty = createInlineUI({ api: { ...verifier, verifyGameRolls: async () => ({ status: 'verified',
    counts: { rolls: 0, diceVerified: 0, hashVerified: 0, mismatch: 0 }, sourceCounts: { signed: 0, sourceVerified: 0, reservationVerified: 0 }, results: [] }) } });
  const emptyControl = wholeGameControl(empty, { history: [] });
  await empty.click(emptyControl.button);
  assert.equal(emptyControl.output.dataset.status, 'incomplete');
  assert.doesNotMatch(emptyControl.output.textContent, /Проверка пройдена/);
  empty.assertLocal();
});
