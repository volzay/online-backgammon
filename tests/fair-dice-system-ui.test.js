'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const Fair = require('../fair-dice.js');
const cryptoEntry = require('../lib/fair-dice-crypto-entry.mjs');
const ROOT = path.join(__dirname, '..');
const privateKey = '11'.repeat(32);
const publicKey = Fair.receiptPublicKey(privateKey);
const serverSeed = '22'.repeat(32);
const clientSeed = '33'.repeat(32);
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function proofFor(nonce = 1) {
  const request = { id: `${String(nonce).padStart(8, '0')}-1111-4111-8111-111111111111`, roomCode: 'ABCD-EFGH',
    gameId: '22222222-2222-4222-8222-222222222222', nonce, label: nonce === 1 ? 'opening' : 'roll',
    color: nonce === 1 ? 'none' : 'white', variant: 'long', commitment: '00'.repeat(32),
    createdAt: '2026-09-18T00:00:00.000Z', positionHash: '44'.repeat(32) };
  request.commitment = Fair.systemCommitment(request, serverSeed);
  return Fair.createSystemProof(Fair.signReservation(request, privateKey), serverSeed, clientSeed);
}

class Element {
  constructor(id = '') {
    this.id = id;
    this.attributes = new Map();
    this.dataset = {};
    this.childNodes = [];
    this.listeners = new Map();
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.isConnected = true;
    this._text = '';
  }
  get textContent() { return this._text + this.childNodes.map(node => node.textContent || '').join(''); }
  set textContent(value) { this._text = String(value); this.childNodes = []; }
  set innerHTML(_) { throw new Error('Proof values must not be rendered as HTML.'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.childNodes = nodes; }
  focus() { this.focused = true; }
  querySelector() { return this.output || null; }
  querySelectorAll() { return []; }
  addEventListener(name, handler) { this.listeners.set(name, [...(this.listeners.get(name) || []), handler]); }
  async trigger(name) { await Promise.all((this.listeners.get(name) || []).map(handler => handler({ preventDefault() {} }))); }
  closest(selector) {
    if (selector.includes('data-copy-roll-')) return null;
    if (selector === '[data-verify-roll], [data-verify-game]') return this;
    return this.parent;
  }
}

function coreContext({ lang = 'ru', key = publicKey, hash = '' } = {}) {
  const handlers = new Map();
  const nodes = new Map();
  for (const match of read('verify-game.html').matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], new Element(match[1]));
  const document = { documentElement: { lang, dataset: {} }, title: '',
    getElementById(id) { assert.ok(nodes.has(id), id); return nodes.get(id); },
    createElement() { return new Element(); }, querySelectorAll() { return []; },
    addEventListener(name, handler) { handlers.set(name, handler); } };
  const context = vm.createContext({ TextEncoder, Uint8Array, DataView, URLSearchParams,
    document, crypto: webcrypto, console, NarduFairDiceCrypto: cryptoEntry, NARDU_ENV: { fairDicePublicKey: key },
    location: { hash, search: '' }, Event: class {}, addEventListener() {},
    fetch() { throw new Error('No network calls allowed during verification.'); },
    localStorage: new Proxy({}, { get() { throw new Error('No account storage access allowed.'); } }) });
  context.window = context;
  vm.runInContext(read('fair-dice.js'), context);
  vm.runInContext(read('game-verifier.js'), context);
  return { context, nodes, handlers };
}

function standalone(options = {}) {
  const ui = coreContext(options);
  vm.runInContext(read('verify-game-ui.js'), ui.context);
  return ui;
}

function inline(options = {}) {
  const ui = coreContext(options);
  vm.runInContext(read('roll-verification-ui.js'), ui.context);
  ui.run = async button => {
    ui.handlers.get('click')({ target: button, preventDefault() {} });
    // Actual crypto is local; settle the event-handler promise microtasks only.
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
  };
  return ui;
}

function historyItem(proof) {
  return { ...(proof.request.label === 'opening' ? { opening: true, host: proof.dice[0], guest: proof.dice[1] }
    : { roll: proof.dice.join(':'), color: proof.request.color }), sha256: proof.sha256,
  sha256Input: proof.sha256Input, fairDiceProof: proof };
}

function inlineControl(proof) {
  const parent = new Element();
  const output = new Element();
  const button = new Element();
  parent.output = output;
  button.parent = parent;
  button.setAttribute('data-verify-roll', '');
  button.setAttribute('data-verify-fair-proof', '');
  button.setAttribute('data-verify-fair-context', '');
  button.dataset.verifyHash = proof.sha256;
  button.dataset.verifyDice = proof.dice.join(',');
  button.dataset.verifyInput = proof.sha256Input;
  button.dataset.verifyFairProof = JSON.stringify(proof);
  button.dataset.verifyFairContext = JSON.stringify(proof.request);
  return { button, output, parent };
}

for (const lang of ['ru', 'en']) {
  test(`standalone ${lang} displays verified system calculation without a false independent drand claim`, async () => {
    const ui = standalone({ lang });
    const proof = proofFor();
    ui.nodes.get('portal-proof').value = JSON.stringify(proof);
    await ui.nodes.get('verify-portal-form').trigger('submit');
    const result = ui.nodes.get('verify-portal-result');
    assert.equal(result.childNodes[0].dataset.status, 'verified');
    assert.match(result.textContent, lang === 'ru' ? /Подпись и расчёт броска подтверждены/ : /Roll signature and calculation verified/);
    assert.match(result.textContent, /HMAC-SHA256/);
    assert.equal(result.textContent.includes(serverSeed), true);
    assert.equal(result.textContent.includes(clientSeed), true);
    assert.equal(result.textContent.includes(proof.request.commitment), true);
    assert.doesNotMatch(result.textContent, /(?:независимый drand|independent drand|Цепочка drand|drand chain)/);
    assert.match(result.textContent, lang === 'ru' ? /не является независимым/ : /not independent proof/);
  });

  test(`inline ${lang} verifies the real system proof positively without claiming independent entropy`, async () => {
    const ui = inline({ lang });
    const control = inlineControl(proofFor());
    await ui.run(control.button);
    assert.equal(control.output.dataset.status, 'verified');
    assert.match(control.output.textContent, lang === 'ru' ? /Подпись и расчёт броска подтверждены/ : /Roll signature and calculation verified/);
    assert.match(control.output.textContent, /HMAC-SHA256/);
    assert.doesNotMatch(control.output.textContent, /drand|независим|independent/);
  });
}

test('standalone system link never interprets its integrity hash using the incompatible legacy dice mapping', async () => {
  const proof = proofFor();
  const ui = standalone({ hash: `#hash=${proof.sha256}&dice=${proof.dice.join(',')}&protocol=system-csprng-v1` });
  assert.equal(ui.nodes.get('verify-portal-result').childNodes.length, 0);
  assert.match(ui.nodes.get('verify-page-notice').textContent, /вставьте JSON/);
  await ui.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(ui.nodes.get('verify-portal-result').childNodes[0].dataset.status, 'incomplete');
  assert.match(ui.nodes.get('verify-portal-result').textContent, /вставьте JSON/);
  ui.nodes.get('portal-proof').value = JSON.stringify(proof);
  await ui.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(ui.nodes.get('verify-portal-result').childNodes[0].dataset.status, 'verified');
});

test('system detail controls disclose the actual protocol and seeds rather than empty drand metadata', () => {
  const ui = inline();
  const proof = proofFor();
  const markup = ui.context.NarduVerifyUI.rollControls(historyItem(proof));
  assert.match(markup, /server CSPRNG/);
  assert.match(markup, /HMAC-SHA256/);
  assert.equal(markup.includes(proof.request.commitment), true);
  assert.equal(markup.includes(serverSeed), true);
  assert.doesNotMatch(markup, /drand quicknet|Цепочка/);
  const href = markup.match(/href="([^"]+)"/)[1];
  assert.match(href, /protocol=system-csprng-v1/);
  assert.equal(href.includes(serverSeed) || href.includes(clientSeed), false);
});

test('static verifier fallback copy distinguishes server commitments from the earlier independent drand protocol', () => {
  const html = read('verify-game.html');
  assert.match(html, /class="verify-protocol">CSPRNG · HMAC \/ drand/);
  assert.match(html, /Серверная схема CSPRNG \+ commit\/reveal/);
  assert.match(html, /В прежней схеме drand отдельно проверяется подпись независимого источника/);
  assert.match(html, /Для неё необходим JSON броска, а не только хеш/);
  assert.doesNotMatch(html, /В новом протоколе игроки и боты используют один независимый источник drand/);
});

test('missing server trust pin or forged system reveal cannot display a positive verification badge', async () => {
  for (const [key, alter] of [[undefined, () => {}], [publicKey, proof => { proof.commitReveal.serverSeed = '77'.repeat(32); }]]) {
    const ui = inline({ key: key === undefined ? '' : key });
    const proof = proofFor();
    alter(proof);
    const control = inlineControl(proof);
    await ui.run(control.button);
    assert.equal(control.output.dataset.status, 'incomplete');
    assert.doesNotMatch(control.output.textContent, /Подпись и расчёт броска подтверждены/);
  }
});

test('a system proof without a trusted receipt pin reports HMAC consistency rather than legacy hash-to-dice mapping', async () => {
  const ui = standalone({ key: '' });
  ui.nodes.get('portal-proof').value = JSON.stringify(proofFor());
  await ui.nodes.get('verify-portal-form').trigger('submit');
  const result = ui.nodes.get('verify-portal-result');
  assert.equal(result.childNodes[0].dataset.status, 'incomplete');
  assert.match(result.textContent, /Расчёт HMAC-SHA256 совпал/);
  assert.doesNotMatch(result.textContent, /Кости соответствуют (?:указанному )?хешу/);
});

test('an unsupported recorded protocol is not displayed as an independent drand source', () => {
  const ui = inline();
  const proof = proofFor();
  proof.protocol = 'unsupported';
  const markup = ui.context.NarduVerifyUI.rollControls(historyItem(proof));
  assert.match(markup, /Сохранённый протокол \(не проверен\): unsupported/);
  assert.doesNotMatch(markup, /drand quicknet/);
});

test('whole-game inline system results are verified as commitments, not as independent source signatures', async () => {
  const ui = inline();
  const parent = new Element();
  const output = new Element();
  const button = new Element();
  parent.output = output;
  button.parent = parent;
  button.setAttribute('data-verify-game', '');
  ui.context.NarduVerifyUI.setGameContext(parent, { roomCode: 'ABCD-EFGH', variant: 'long',
    history: [historyItem(proofFor(2)), historyItem(proofFor(1))] });
  await ui.run(button);
  assert.equal(output.dataset.status, 'verified');
  assert.match(output.textContent, /Серверные обязательства подтверждены: 2\/2/);
  assert.match(output.textContent, /Независимые подписи drand: 0\/0/);
  assert.doesNotMatch(output.textContent, /один независимый источник drand/);
});

test('rebuilt local browser cryptography exposes the same HMAC implementation as Node', async () => {
  const context = vm.createContext({ TextEncoder, Uint8Array, DataView, console });
  vm.runInContext(read('fair-dice-crypto.js'), context);
  vm.runInContext(read('fair-dice.js'), context);
  assert.equal(typeof context.NarduFairDiceCrypto.hmacSha256, 'function');
  const proof = proofFor();
  const verified = await context.NarduFairDice.verifyProof(proof, { publicKey });
  assert.equal(verified.hash, proof.sha256);
  assert.deepEqual(JSON.parse(JSON.stringify(verified.dice)), proof.dice);
  assert.equal(verified.sourceVerified, false);
});
