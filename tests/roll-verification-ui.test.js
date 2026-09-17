const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const verifier = require('../game-verifier.js');
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));

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
    if (selector === '[data-verify-roll], [data-verify-game]') return this;
    if (selector === '[data-verifier-context]' || selector === '.fair-hash, .history-proof') return this.parent;
    return null;
  }
}

function createInlineUI({ api = verifier, lang = 'ru' } = {}) {
  const handlers = new Map();
  const pending = [];
  const calls = [];
  let networkCalls = 0;
  let storageCalls = 0;
  const tracked = { ...api };
  for (const method of ['verifyPortalRoll', 'verifyGameRolls']) {
    tracked[method] = input => {
      calls.push({ method, input });
      const work = Promise.resolve().then(() => api[method](input));
      pending.push(work);
      return work;
    };
  }
  const document = {
    documentElement: { lang },
    addEventListener(name, handler) { handlers.set(name, handler); },
  };
  const forbiddenStorage = new Proxy({}, {
    get() { storageCalls += 1; throw new Error('inline checking must not access account storage'); },
  });
  const context = vm.createContext({
    document,
    NarduVerify: tracked,
    localStorage: forbiddenStorage,
    sessionStorage: forbiddenStorage,
    fetch: () => { networkCalls += 1; throw new Error('inline checking must not make API requests'); },
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'roll-verification-ui.js'), 'utf8'), context, {
    filename: 'roll-verification-ui.js',
  });
  return {
    api: context.NarduVerifyUI,
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

function rollControl(item) {
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
  assert.equal(control.output.dataset.status, 'verified');
  assert.match(control.output.textContent, /Исходная строка, SHA-256 и кости/);
  assert.match(control.output.textContent, /не доказывает публикацию хеша заранее/);
  assert.equal(control.button.disabled, false);
  assert.equal(control.button.hasAttribute('aria-busy'), false);
  assert.equal(control.button.textContent, 'Проверить');
  assert.equal(control.output.hidden, false);
  ui.assertLocal();
});

test('historical matching hash/dice remains incomplete rather than showing a false full-verification badge', async () => {
  const ui = createInlineUI();
  const control = rollControl({ sha256: `0103${'ff'.repeat(30)}`, roll: '2:4' });
  await ui.click(control.button);
  assert.equal(control.output.dataset.status, 'incomplete');
  assert.match(control.output.textContent, /Кости 2:4 соответствуют хешу/);
  assert.match(control.output.textContent, /полная проверка SHA-256 недоступна/);
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
  assert.equal(archiveControl.output.dataset.status, 'incomplete');
  assert.match(archiveControl.output.textContent, /Неполных проверок: 1/);
  await ui.click(roomControl.button);
  assert.equal(ui.calls[1].input, room);
  assert.equal(roomControl.output.dataset.status, 'verified');
  assert.match(roomControl.output.textContent, /SHA-256 исходной строки совпал: 1/);
  assert.match(roomControl.output.textContent, /не подтверждает случайность генерации или законность перемещений шашек/);
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
  assert.equal(control.output.dataset.status, 'incomplete');
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
  assert.equal(control.output.dataset.status, 'incomplete');
  assert.match(control.output.textContent, /full SHA-256 verification is unavailable/);
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
  assert.equal(control.output.dataset.status, 'verified');
  original.history.push(fullRoll('second roll after finished proof'));
  ui.api.setGameContext(control.parent, original);
  assert.notEqual(control.output.dataset.status, 'verified');
  assert.doesNotMatch(control.output.textContent, /Бросков: 1\./);
  await ui.click(control.button);
  assert.equal(control.output.dataset.status, 'verified');
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
  assert.equal(control.output.dataset.status, 'verified');
  assert.equal(control.output.textContent, text);
  ui.api.setGameContext(control.parent, plain(game));
  assert.equal(control.output.dataset.status, 'verified');
  assert.equal(control.output.textContent, text);
  ui.assertLocal();
});
