const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const verifier = require('../game-verifier.js');
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

class LocalNode {
  constructor(tagName, id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.attributes = new Map();
    this.dataset = {};
    this.childNodes = [];
    this.listeners = new Map();
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.focused = false;
    this._textContent = '';
  }
  get textContent() { return this._textContent + this.childNodes.map(node => node.textContent || '').join(''); }
  set textContent(value) { this._textContent = String(value); this.childNodes = []; }
  set innerHTML(_) { throw new Error('untrusted result data must not be inserted as HTML'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this._textContent = ''; this.childNodes = nodes; }
  focus() { this.focused = true; }
  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }
  async trigger(name) {
    const event = { type: name, preventDefault() { this.defaultPrevented = true; } };
    await Promise.all((this.listeners.get(name) || []).map(handler => handler(event)));
  }
}

function createLocalUI({ hash = '', search = '', api = verifier } = {}) {
  const html = read('verify-game.html');
  const nodes = new Map();
  const pending = [];
  const windowEvents = new LocalNode('window');
  let networkCalls = 0;
  let storageCalls = 0;
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const node = new LocalNode(match[1], match[3]);
    const value = match[2].match(/\bvalue="([^"]*)"/);
    if (value) node.value = value[1];
    node.disabled = /\bdisabled(?:\s|>|$)/.test(match[2]);
    node.hidden = /\bhidden(?:\s|>|$)/.test(match[2]);
    nodes.set(node.id, node);
  }
  const languageButtons = ['ru', 'en'].map(value => {
    const node = new LocalNode('button');
    node.dataset.verifyLang = value;
    return node;
  });
  const themeButtons = ['day', 'night'].map(value => {
    const node = new LocalNode('button');
    node.dataset.verifyTheme = value;
    return node;
  });
  const document = {
    documentElement: { lang: 'ru', dataset: { theme: 'night' } },
    title: '',
    getElementById: id => {
      assert.ok(nodes.has(id), `UI element ${id} must exist`);
      return nodes.get(id);
    },
    createElement: tag => new LocalNode(tag),
    querySelectorAll: selector => selector === '[data-verify-lang]' ? languageButtons
      : selector === '[data-verify-theme]' ? themeButtons : [],
  };
  for (const node of nodes.values()) {
    node.querySelectorAll = selector => selector === '[aria-invalid]'
      ? [...nodes.values()].filter(item => item.getAttribute('aria-invalid') !== null) : [];
    node.requestSubmit = () => { pending.push(node.trigger('submit')); };
  }
  const forbiddenStorage = new Proxy({}, {
    get() { storageCalls += 1; throw new Error('verification fields must not access persistent storage'); },
  });
  const context = vm.createContext({
    document,
    URLSearchParams,
    Event: class { constructor(type) { this.type = type; } },
    location: { search, hash },
    NarduVerify: api,
    localStorage: forbiddenStorage,
    sessionStorage: forbiddenStorage,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    fetch: () => { networkCalls += 1; throw new Error('verification must not send input data'); },
  });
  context.window = context;
  vm.runInContext(read('verify-game-ui.js'), context, { filename: 'verify-game-ui.js' });
  return {
    nodes,
    document,
    languageButtons,
    themeButtons,
    async changeFragment(next) {
      context.location.hash = next;
      await windowEvents.trigger('hashchange');
      await Promise.all(pending.splice(0));
    },
    async flush() { await Promise.all(pending.splice(0)); },
    assertLocal() { assert.equal(networkCalls, 0); assert.equal(storageCalls, 0); },
  };
}

function setFields(ui, values) {
  for (const [id, value] of Object.entries(values)) ui.nodes.get(id).value = value;
}

function portalResult(ui) { return ui.nodes.get('verify-portal-result'); }
function firstStatus(out) { return out.childNodes[0]?.dataset.status; }

test('the standalone verifier loads its local scripts without auth, external resources, or form GET fallback', () => {
  const html = read('verify-game.html');
  assert.match(html, /<meta name="referrer" content="no-referrer"/);
  assert.match(html, /<script src="game-verifier\.js" defer><\/script>[\s\S]*<script src="verify-game-ui\.js" defer><\/script>/);
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//);
  assert.doesNotMatch(html, /<script[^>]*src="(?:app|auth-client|rooms-client|supabase-client)\.js/);
  assert.doesNotMatch(html, /<(?:input|textarea)[^>]*\bname=/);
  assert.doesNotMatch(html, /<form[^>]*\baction=/);
  for (const kind of ['portal', 'seed', 'hmac']) {
    assert.match(html, new RegExp(`id="verify-${kind}-submit"[^>]*disabled`));
  }
});

test('an unavailable core leaves all submission buttons disabled and explains the missing verifier', () => {
  const ui = createLocalUI({ api: null });
  for (const kind of ['portal', 'seed', 'hmac']) assert.equal(ui.nodes.get(`verify-${kind}-submit`).disabled, true);
  assert.equal(ui.nodes.get('verify-page-notice').hidden, false);
  assert.match(ui.nodes.get('verify-page-notice').textContent, /недоступен/);
  ui.assertLocal();
});

test('a public fragment imports only hash/dice and reports matching legacy dice as incomplete proof', async () => {
  const hash = `0103${'ff'.repeat(30)}`;
  const ui = createLocalUI({ hash: `#hash=${hash}&dice=2%3A4&color=white` });
  await ui.flush();
  assert.equal(ui.nodes.get('portal-hash').value, hash);
  assert.equal(ui.nodes.get('portal-die-one').value, '2');
  assert.equal(ui.nodes.get('portal-die-two').value, '4');
  assert.equal(ui.nodes.get('portal-preimage').value, '');
  assert.equal(firstStatus(portalResult(ui)), 'incomplete');
  assert.match(portalResult(ui).textContent, /Доказательство неполное/);
  assert.match(portalResult(ui).textContent, /не доказывает случайность/);
  ui.assertLocal();
});

test('invalid, duplicate, oversized, or secret fragment fields are not imported or evaluated', async () => {
  const hash = `0103${'ff'.repeat(30)}`;
  let checks = 0;
  const api = { ...verifier, verifyPortalRoll: async input => { checks += 1; return verifier.verifyPortalRoll(input); } };
  for (const fragment of [
    `hash=${hash}&hash=${hash}&dice=2:4`,
    `hash=${hash}&dice=2:7`,
    `hash=${hash}&dice=2:4&color=unknown`,
    `hash=${hash}&dice=2:4&preimage=password`,
    `hash=${hash}&dice=2:4&seed=secret`,
    `hash=${hash}&dice=2:4&clientSeed=secret`,
    `hash=${hash}&dice=2:4&extra=${'a'.repeat(257)}`,
    'hash=bad&dice=2:4',
  ]) {
    const ui = createLocalUI({ hash: `#${fragment}`, api });
    await ui.flush();
    assert.equal(ui.nodes.get('portal-hash').value, '');
    assert.equal(ui.nodes.get('portal-preimage').value, '');
    assert.equal(portalResult(ui).childNodes.length, 0);
    assert.match(ui.nodes.get('verify-page-notice').textContent, /не прошли проверку/);
    ui.assertLocal();
  }
  assert.equal(checks, 0);
});

test('query-string secrets are ignored and never enter any verification field', async () => {
  const ui = createLocalUI({ search: `?hash=${'a'.repeat(64)}&seed=secret&preimage=secret&dice=2:4` });
  await ui.flush();
  for (const id of ['portal-hash', 'portal-preimage', 'verify-seed', 'hmac-server-seed']) assert.equal(ui.nodes.get(id).value, '');
  assert.match(ui.nodes.get('verify-page-notice').textContent, /не импортируются/);
  ui.assertLocal();
});

test('a disclosed portal preimage verifies exact data, while a wrong preimage reports a mismatch', async () => {
  const seed = 'room|ВащеППЦ|🎲';
  const hash = sha256(seed);
  const dice = verifier.diceFromHash(hash).dice;
  const ui = createLocalUI();
  setFields(ui, { 'portal-hash': hash, 'portal-die-one': String(dice[0]), 'portal-die-two': String(dice[1]), 'portal-preimage': seed });
  await ui.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(firstStatus(portalResult(ui)), 'verified');
  assert.match(portalResult(ui).textContent, /не доказывает случайность/);
  ui.nodes.get('portal-preimage').value += ' ';
  await ui.nodes.get('verify-portal-form').trigger('input');
  assert.equal(firstStatus(portalResult(ui)), 'incomplete');
  await ui.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(firstStatus(portalResult(ui)), 'mismatch');
  assert.match(portalResult(ui).textContent, /не совпадает/);
  ui.assertLocal();
});

test('one populated die is rejected before invoking the core and focuses the invalid field', async () => {
  let calls = 0;
  const ui = createLocalUI({ api: { ...verifier, verifyPortalRoll: async () => { calls += 1; } } });
  setFields(ui, { 'portal-hash': `0103${'ff'.repeat(30)}`, 'portal-die-one': '2', 'portal-die-two': '' });
  await ui.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(calls, 0);
  assert.equal(ui.nodes.get('portal-die-two').getAttribute('aria-invalid'), 'true');
  assert.equal(ui.nodes.get('portal-die-two').focused, true);
  assert.match(portalResult(ui).textContent, /обе кости/);
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, false);
  ui.assertLocal();
});

test('noncanonical UI nonce is rejected without converting it into a different signed message', async () => {
  let calls = 0;
  const ui = createLocalUI({ api: { ...verifier, verifyHmacRoll: async () => { calls += 1; } } });
  setFields(ui, { 'hmac-server-seed': 'seed', 'hmac-game-id': 'game', 'hmac-client-seed': 'client', 'hmac-nonce': '01' });
  await ui.nodes.get('verify-hmac-form').trigger('submit');
  assert.equal(calls, 0);
  assert.equal(ui.nodes.get('hmac-nonce').getAttribute('aria-invalid'), 'true');
  assert.match(ui.nodes.get('verify-hmac-result').textContent, /Nonce/);
  ui.assertLocal();
});

test('the HMAC UI compares the expected HMAC digest rather than silently using a seed commitment', async () => {
  const digest = createHmac('sha256', 'seed').update('game:client:0', 'utf8').digest('hex');
  const dice = verifier.diceFromHash(digest).dice;
  const ui = createLocalUI();
  setFields(ui, {
    'hmac-server-seed': 'seed', 'hmac-game-id': 'game', 'hmac-client-seed': 'client', 'hmac-nonce': '0',
    'hmac-expected-hash': digest, 'hmac-die-one': String(dice[0]), 'hmac-die-two': String(dice[1]),
  });
  await ui.nodes.get('verify-hmac-form').trigger('submit');
  assert.equal(firstStatus(ui.nodes.get('verify-hmac-result')), 'verified');
  assert.match(ui.nodes.get('verify-hmac-result').textContent, /не подтверждает алгоритм этого портала/);
  ui.nodes.get('hmac-expected-hash').value = sha256('seed');
  await ui.nodes.get('verify-hmac-form').trigger('input');
  await ui.nodes.get('verify-hmac-form').trigger('submit');
  assert.equal(firstStatus(ui.nodes.get('verify-hmac-result')), 'mismatch');
  ui.assertLocal();
});

test('verification results and errors insert hostile text only as text nodes, never HTML', async () => {
  const hostile = '<img src=x onerror="throw 1">';
  const result = {
    status: 'incomplete', message: hostile, hmac: hostile, dice: [2, 4], sourceBytes: [],
  };
  const ui = createLocalUI({ api: { ...verifier, verifyHmacRoll: async () => result } });
  setFields(ui, { 'hmac-server-seed': 'seed', 'hmac-game-id': 'game', 'hmac-client-seed': 'client', 'hmac-nonce': '0' });
  await ui.nodes.get('verify-hmac-form').trigger('submit');
  assert.ok(ui.nodes.get('verify-hmac-result').textContent.includes(hostile));
  ui.assertLocal();
  const errorUI = createLocalUI({ api: { ...verifier, verifySeed: async () => { throw new Error(hostile); } } });
  setFields(errorUI, { 'verify-seed': 'seed' });
  await errorUI.nodes.get('verify-seed-form').trigger('submit');
  assert.ok(errorUI.nodes.get('verify-seed-result').textContent.includes(hostile));
  errorUI.assertLocal();
});

test('editing inputs during a pending digest invalidates its result and restores the submission control', async () => {
  let finish;
  let calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const ui = createLocalUI({ api: { ...verifier, verifyPortalRoll: () => { calls += 1; return pending; } } });
  setFields(ui, { 'portal-hash': `0103${'ff'.repeat(30)}`, 'portal-die-one': '2', 'portal-die-two': '4' });
  const submitted = ui.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, true);
  await ui.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(calls, 1, 'a busy form must not start duplicate verification');
  ui.nodes.get('portal-die-two').value = '5';
  await ui.nodes.get('verify-portal-form').trigger('input');
  finish({ status: 'verified', hashStatus: 'verified', diceStatus: 'verified', hash: 'a'.repeat(64), dice: [2, 4], sourceBytes: [] });
  await submitted;
  assert.equal(firstStatus(portalResult(ui)), 'incomplete');
  assert.match(portalResult(ui).textContent, /Данные изменены/);
  assert.doesNotMatch(portalResult(ui).textContent, /Хеш и бросок совпадают/);
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, false);
  ui.assertLocal();
});

test('changing the language and theme leaves verification data local and retains truthful result status', async () => {
  const ui = createLocalUI({ hash: `#hash=0103${'ff'.repeat(30)}&dice=2:4` });
  await ui.flush();
  await ui.languageButtons[1].trigger('click');
  assert.equal(ui.document.documentElement.lang, 'en');
  assert.equal(firstStatus(portalResult(ui)), 'incomplete');
  assert.match(portalResult(ui).textContent, /Proof is incomplete/);
  assert.match(portalResult(ui).textContent, /does not prove a random roll/);
  await ui.themeButtons[0].trigger('click');
  assert.equal(ui.document.documentElement.dataset.theme, 'day');
  ui.assertLocal();
});

test('changing the public fragment clears an earlier private preimage and invalid fragments clear stale proof', async () => {
  const first = `0103${'ff'.repeat(30)}`;
  const second = `0405${'ff'.repeat(30)}`;
  const ui = createLocalUI({ hash: `#hash=${first}&dice=2:4` });
  await ui.flush();
  ui.nodes.get('portal-preimage').value = 'private input manually pasted for the previous roll';
  await ui.changeFragment(`#hash=${second}`);
  assert.equal(ui.nodes.get('portal-hash').value, second);
  assert.equal(ui.nodes.get('portal-preimage').value, '');
  assert.equal(ui.nodes.get('portal-die-one').value, '');
  assert.equal(ui.nodes.get('portal-die-two').value, '');
  assert.equal(portalResult(ui).childNodes.length, 0);
  await ui.changeFragment(`#hash=${first}&dice=2:4&preimage=secret`);
  assert.equal(ui.nodes.get('portal-hash').value, '');
  assert.equal(ui.nodes.get('portal-preimage').value, '');
  assert.equal(portalResult(ui).childNodes.length, 0);
  assert.match(ui.nodes.get('verify-page-notice').textContent, /не прошли проверку/);
  ui.assertLocal();
});

test('a later public-fragment check cannot be overwritten by an older pending digest', async () => {
  const first = `0103${'ff'.repeat(30)}`;
  const second = `0405${'ff'.repeat(30)}`;
  let finishOld;
  let calls = 0;
  const pendingOld = new Promise(resolve => { finishOld = resolve; });
  const api = { ...verifier, verifyPortalRoll: input => {
    calls += 1;
    return input.hash === first ? pendingOld : verifier.verifyPortalRoll(input);
  } };
  const ui = createLocalUI({ api });
  setFields(ui, { 'portal-hash': first, 'portal-die-one': '2', 'portal-die-two': '4' });
  const oldSubmit = ui.nodes.get('verify-portal-form').trigger('submit');
  await ui.changeFragment(`#hash=${second}&dice=5:6`);
  assert.equal(calls, 2);
  assert.equal(firstStatus(portalResult(ui)), 'incomplete');
  assert.ok(portalResult(ui).textContent.includes(second));
  finishOld({ status: 'verified', hashStatus: 'verified', diceStatus: 'verified', hash: first, dice: [2, 4], sourceBytes: [] });
  await oldSubmit;
  assert.equal(firstStatus(portalResult(ui)), 'incomplete');
  assert.ok(portalResult(ui).textContent.includes(second));
  assert.ok(!portalResult(ui).textContent.includes(first));
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, false);
  ui.assertLocal();
});

test('removing the public fragment clears the previous imported proof and private input', async () => {
  const hash = `0103${'ff'.repeat(30)}`;
  const ui = createLocalUI({ hash: `#hash=${hash}&dice=2:4` });
  await ui.flush();
  ui.nodes.get('portal-preimage').value = 'private input pasted for the old roll';
  await ui.changeFragment('');
  for (const id of ['portal-hash', 'portal-die-one', 'portal-die-two', 'portal-preimage']) {
    assert.equal(ui.nodes.get(id).value, '', `${id} must not retain the removed fragment's proof`);
  }
  assert.equal(portalResult(ui).childNodes.length, 0);
  ui.assertLocal();
});

test('removing the public fragment invalidates an old pending verification result', async () => {
  const hash = `0103${'ff'.repeat(30)}`;
  let defer = false;
  let resolve;
  const work = new Promise(done => { resolve = done; });
  const api = { ...verifier, verifyPortalRoll: input => defer ? work : verifier.verifyPortalRoll(input) };
  const ui = createLocalUI({ hash: `#hash=${hash}&dice=2:4`, api });
  await ui.flush();
  defer = true;
  const submitted = ui.nodes.get('verify-portal-form').trigger('submit');
  await ui.changeFragment('');
  resolve({ status: 'verified', hashStatus: 'verified', diceStatus: 'verified', hash, dice: [2, 4], sourceBytes: [] });
  await submitted;
  assert.equal(portalResult(ui).childNodes.length, 0);
  assert.equal(ui.nodes.get('portal-hash').value, '');
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, false);
  ui.assertLocal();
});

function extractDeclaration(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const body = source.indexOf(') {', start) + 2;
  assert.ok(body > start, `${signature} must have a function body`);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${signature} must have a closing brace`);
}

test('the actual game roll generator discloses the exact accepted one-use preimage without changing the digest-to-dice mapping', async () => {
  const source = read('game-controller.js');
  const entropy = [];
  const state = { roomCode: 'ABCD-EFGH', history: [{}, {}], matchScore: { white: 2, dark: 3 }, turn: 'dark' };
  const context = vm.createContext({
    state,
    Date: { now: () => 1789671000000 },
    randomHex: bytes => { entropy.push(bytes); return 'ab'.repeat(bytes); },
    sha256Hex: async text => sha256(text),
  });
  vm.runInContext([
    extractDeclaration(source, 'function diceValuesFromHash('),
    extractDeclaration(source, 'function expandRollValues('),
    extractDeclaration(source, 'async function shaDiceRoll('),
    'this.generate = shaDiceRoll;',
  ].join('\n'), context, { filename: 'game-controller.roll-proof-test.js' });
  const generated = await context.generate({ label: 'turn-roll', color: 'dark' });
  const preimage = `nardu|ABCD-EFGH|turn-roll|dark|2|2|3|1789671000000|0|${'ab'.repeat(32)}`;
  assert.equal(generated.input, preimage);
  assert.equal(generated.hash, sha256(preimage));
  assert.deepEqual(JSON.parse(JSON.stringify(generated.values)), verifier.diceFromHash(generated.hash).dice);
  assert.deepEqual(entropy, [32]);
  const history = { roll: JSON.parse(JSON.stringify(generated.roll)), sha256: generated.hash, sha256Input: generated.input };
  assert.equal((await verifier.verifyPortalRoll(verifier.portalRollFromHistory(history))).status, 'verified');
});

test('the actual opening roll rerolls ties and discloses only the accepted one-use input', async () => {
  const prefix = 'nardu|OPEN-ROLL|opening|opening|0|0|0|1789671000000';
  let salt;
  for (let candidate = 0; candidate < 1000; candidate += 1) {
    const value = candidate.toString(16).padStart(64, '0');
    const first = verifier.diceFromHash(sha256(`${prefix}|0|${value}`)).dice;
    const second = verifier.diceFromHash(sha256(`${prefix}|1|${value}`)).dice;
    if (first[0] === first[1] && second[0] !== second[1]) { salt = value; break; }
  }
  assert.ok(salt, 'deterministic fixture search must find a first-roll tie followed by a non-tie');
  const inputs = [];
  const entropy = [];
  const state = { roomCode: 'OPEN-ROLL', history: [], matchScore: { white: 0, dark: 0 }, turn: 'white' };
  const originalState = JSON.stringify(state);
  const context = vm.createContext({
    state,
    Date: { now: () => 1789671000000 },
    randomHex: bytes => { entropy.push(bytes); return salt; },
    sha256Hex: async input => { inputs.push(input); return sha256(input); },
  });
  const source = read('game-controller.js');
  vm.runInContext([
    extractDeclaration(source, 'function diceValuesFromHash('),
    extractDeclaration(source, 'function expandRollValues('),
    extractDeclaration(source, 'async function shaDiceRoll('),
    'this.generate = shaDiceRoll;',
  ].join('\n'), context, { filename: 'game-controller.opening-proof-test.js' });
  const generated = await context.generate({ label: 'opening', color: 'opening', noTie: true });
  assert.deepEqual(inputs, [`${prefix}|0|${salt}`, `${prefix}|1|${salt}`]);
  assert.deepEqual(entropy, [32, 32]);
  assert.equal(generated.rerolls, 1);
  assert.equal(generated.input, inputs[1]);
  assert.equal(generated.hash, sha256(inputs[1]));
  assert.notEqual(generated.values[0], generated.values[1]);
  assert.equal(JSON.stringify(state), originalState, 'generation must not mutate the game history before the accepted proof is saved');
  const opening = { opening: true, host: generated.values[0], guest: generated.values[1], sha256: generated.hash, sha256Input: generated.input };
  assert.equal((await verifier.verifyPortalRoll(verifier.portalRollFromHistory(opening))).status, 'verified');
});

test('opening and ordinary history save the accepted one-use preimage alongside the exact generated hash', () => {
  const controller = read('game-controller.js');
  assert.match(controller, /opening\.sha256 = fair\.hash;[\s\S]*?opening\.sha256Input = fair\.input;/);
  assert.match(controller, /openingHistory\.sha256 = fair\.hash;[\s\S]*?openingHistory\.sha256Input = fair\.input;/);
  assert.match(controller, /state\.history\.unshift\(\{[\s\S]*?sha256: fair\.hash,[\s\S]*?sha256Input: fair\.input,/);
});

test('room, archive admin, and static build include real verification controls and all local verifier assets', () => {
  const assets = ['verify-game.html', 'verify-game.css', 'verify-game-ui.js', 'game-verifier.js', 'roll-verification-ui.js', 'roll-verification.css'];
  const build = read('scripts/build-github-pages.js');
  const staticList = build.slice(build.indexOf('const STATIC_FILES = ['), build.indexOf('];', build.indexOf('const STATIC_FILES = [')));
  for (const asset of assets) {
    assert.ok(fs.existsSync(path.join(ROOT, asset)), `${asset} must exist`);
    assert.ok(staticList.includes(`"${asset}"`), `${asset} must be present in the published static file list`);
  }
  for (const page of ['room.html', 'homegate.html']) {
    const html = read(page);
    const core = html.indexOf('src="game-verifier.js');
    const embedded = html.indexOf('src="roll-verification-ui.js');
    assert.ok(core >= 0 && embedded > core, `${page} must load core before shared verification controls`);
    assert.match(html, /href="roll-verification\.css"/);
  }
  assert.match(read('room.html'), /data-verify-game/);
  assert.match(read('room.html'), /href="verify-game\.html"/);
  assert.match(read('homegate.js'), /data-verify-game/);
  assert.match(read('homegate.js'), /NarduVerifyUI\?\.setGameContext/);
  assert.match(read('game-controller.js'), /NarduVerifyUI\?\.rollControls/);
  assert.match(read('game-controller.js'), /NarduVerifyUI\?\.setGameContext/);
});

test('embedded roll markup escapes disclosed input text and keeps its separate-page URL secret-free', () => {
  const document = { documentElement: { lang: 'ru' }, addEventListener() {} };
  const context = vm.createContext({ document, NarduVerify: verifier });
  context.window = context;
  vm.runInContext(read('roll-verification-ui.js'), context, { filename: 'roll-verification-ui.js' });
  const secret = 'PRIVATE" onclick="throw 1"><img src=x>&\'end';
  const markup = context.NarduVerifyUI.rollControls({ sha256: `0103${'ff'.repeat(30)}`, roll: '2:4', sha256Input: secret });
  assert.ok(markup.includes('data-verify-input='));
  assert.ok(markup.includes('&quot;') && markup.includes('&lt;') && markup.includes('&amp;') && markup.includes('&#39;'));
  assert.ok(!markup.includes(secret));
  assert.doesNotMatch(markup, /<img|" onclick=/);
  const href = markup.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&');
  assert.doesNotMatch(href, /(?:seed|preimage|password|token)=/i);
  assert.ok(!href.includes('PRIVATE') && !href.includes(encodeURIComponent(secret)));
  assert.equal(context.NarduVerifyUI.rollControls({ sha256: 'broken', roll: '2:4' }), '');
});
