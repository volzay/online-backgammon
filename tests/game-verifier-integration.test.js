const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const verifier = require('../game-verifier.js');
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const fairDice = require('../fair-dice.js');
const FIXTURE_KEY = '11'.repeat(32);
const FIXTURE_PUBLIC_KEY = fairDice.receiptPublicKey(FIXTURE_KEY);
function completeFairProof() {
  const request = { id: '11111111-1111-4111-8111-111111111111', roomCode: 'ABCD-EFGH',
    gameId: '22222222-2222-4222-8222-222222222222', nonce: 1, label: 'opening', color: 'none', variant: 'long', round: 1000,
    createdAt: new Date(fairDice.roundTime(1000) - 6000).toISOString(), positionHash: 'a'.repeat(64) };
  const beacon = { round: 1000, signature: 'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39',
    randomness: 'fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd' };
  const receipt = fairDice.signReservation(request, FIXTURE_KEY);
  const derived = fairDice.deriveDice(request, beacon.randomness);
  return { protocol: fairDice.PROTOCOL, ...receipt, chainHash: fairDice.CHAIN.hash, beacon,
    sha256: derived.hash, sha256Input: derived.input, dice: derived.dice, rerolls: derived.rerolls };
}

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

function createLocalUI({ hash = '', search = '', api = verifier, clipboard, loadCore = false, fairApi = fairDice, env, transfer } = {}) {
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
    NarduFairDice: fairApi,
    NarduRollProofTransfer: transfer,
    NARDU_ENV: env,
    AbortController,
    crypto: webcrypto,
    TextEncoder,
    navigator: { clipboard },
    localStorage: forbiddenStorage,
    sessionStorage: forbiddenStorage,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    fetch: () => { networkCalls += 1; throw new Error('verification must not send input data'); },
  });
  context.window = context;
  if (loadCore) vm.runInContext(read('game-verifier.js'), context, { filename: 'game-verifier.js' });
  vm.runInContext(read('verify-game-ui.js'), context, { filename: 'verify-game-ui.js' });
  return {
    context,
    nodes,
    document,
    languageButtons,
    themeButtons,
    async changeFragment(next) {
      context.location.hash = next;
      await windowEvents.trigger('hashchange');
      await this.flush();
    },
    async flush() {
      // The automatic channel import yields before queueing form submission.
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
        await Promise.all(pending.splice(0));
      }
    },
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
  assert.match(html, /src="runtime-config\.js"[\s\S]*src="fair-dice-crypto\.js"[\s\S]*src="fair-dice\.js"[\s\S]*src="game-verifier\.js"/);
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//);
  assert.doesNotMatch(html, /<script[^>]*src="(?:app|auth-client|rooms-client|supabase-client)\.js/);
  assert.doesNotMatch(html, /<(?:input|textarea)[^>]*\bname=/);
  assert.doesNotMatch(html, /<form[^>]*\baction=/);
  assert.match(html, /id="verify-portal-submit"[^>]*disabled/);
});

test('an unavailable core leaves the SHA-256 submission button disabled and explains the missing verifier', () => {
  const ui = createLocalUI({ api: null });
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, true);
  assert.equal(ui.nodes.get('verify-page-notice').hidden, false);
  assert.match(ui.nodes.get('verify-page-notice').textContent, /недоступен/);
  ui.assertLocal();
});

test('a public fragment imports only hash/dice and labels legacy consistency without a fair-source badge', async () => {
  const hash = `0103${'ff'.repeat(30)}`;
  const ui = createLocalUI({ hash: `#hash=${hash}&dice=2%3A4&color=white` });
  await ui.flush();
  assert.equal(ui.nodes.get('portal-hash').value, hash);
  assert.equal(ui.nodes.get('portal-die-one').value, '2');
  assert.equal(ui.nodes.get('portal-die-two').value, '4');
  assert.equal(ui.nodes.get('portal-preimage').value, '');
  assert.equal(firstStatus(portalResult(ui)), 'matched');
  assert.match(portalResult(ui).textContent, /Кости соответствуют хешу/);
  assert.match(portalResult(ui).textContent, /независимая подпись источника.*отсутствует/);
  assert.doesNotMatch(portalResult(ui).textContent, /Проверка пройдена|Доказательство неполное/);
  assert.equal(ui.nodes.get('portal-proof').value, '');
  ui.assertLocal();
});

const TRANSFER_TOKEN = 'ab'.repeat(24);
function transferFragment(proof, token = TRANSFER_TOKEN) {
  return `#hash=${proof.sha256}&dice=${proof.dice.join(',')}&protocol=${proof.protocol}&transfer=${token}`;
}
function transferredProof(proof) {
  return { hash: proof.sha256, expectedDice: proof.dice, preimage: proof.sha256Input,
    proof, context: { roomCode: proof.request.roomCode, gameId: proof.request.gameId,
      variant: proof.request.variant, label: proof.request.label, color: proof.request.color,
      positionHash: proof.request.positionHash, nonce: proof.request.nonce } };
}

test('full drand link automatically imports a complete proof and verifies with only the configured pin and expected history context', async () => {
  const proof = completeFairProof();
  const payload = transferredProof(proof);
  const calls = [];
  const received = [];
  const ui = createLocalUI({ hash: transferFragment(proof), loadCore: true,
    env: { fairDicePublicKey: FIXTURE_PUBLIC_KEY },
    transfer: { receive: async (token, options) => { received.push({ token, options }); return payload; } },
    fairApi: { ...fairDice, verifyProof: (value, options) => { calls.push(options); return fairDice.verifyProof(value, options); } } });
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, true);
  assert.match(ui.nodes.get('verify-page-notice').textContent, /Получаем данные броска/);
  await ui.flush();
  assert.equal(received.length, 1);
  assert.equal(received[0].token, TRANSFER_TOKEN);
  assert.ok(received[0].options.signal instanceof AbortSignal);
  assert.equal(firstStatus(portalResult(ui)), 'verified');
  assert.equal(ui.nodes.get('portal-proof').value, JSON.stringify(proof));
  assert.equal(ui.nodes.get('portal-preimage').value, proof.sha256Input);
  assert.deepEqual(plain(calls[0].context), payload.context);
  assert.equal(calls[0].publicKey, FIXTURE_PUBLIC_KEY);
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, false);
  ui.assertLocal();
});

test('automatic proof transfer cannot adopt a receipt key from its payload without the configured portal pin', async () => {
  const proof = { ...completeFairProof(), publicKey: FIXTURE_PUBLIC_KEY };
  const ui = createLocalUI({ hash: transferFragment(proof), loadCore: true,
    transfer: { receive: async () => ({ ...transferredProof(proof), publicKey: FIXTURE_PUBLIC_KEY }) } });
  await ui.flush();
  assert.equal(firstStatus(portalResult(ui)), 'incomplete');
  assert.match(portalResult(ui).textContent, /Ключ проверки серверной записи не настроен/);
  assert.doesNotMatch(portalResult(ui).textContent, /Проверка пройдена/);
  ui.assertLocal();
});

test('missing, expired or rejected transfers explain recovery and never interpret a signed hash using legacy dice mapping', async () => {
  const proof = completeFairProof();
  for (const transfer of [undefined, { receive: async () => undefined }, { receive: async () => { throw new Error('expired'); } }]) {
    let legacyCalls = 0;
    let signedCalls = 0;
    const history = { sha256: proof.sha256, roll: proof.dice.join(':'), fairDiceProof: proof };
    const actualFragment = verifier.verificationUrl(history).split('#')[1];
    const ui = createLocalUI({ hash: `#${actualFragment}&transfer=${TRANSFER_TOKEN}`, transfer,
      api: { verifyPortalRoll: () => { legacyCalls += 1; }, verifyFairRoll: () => { signedCalls += 1; } } });
    await ui.flush();
    assert.equal(portalResult(ui).childNodes.length, 0);
    assert.match(ui.nodes.get('verify-page-notice').textContent, /Вернитесь к броску.*Полная проверка.*Проверить/);
    assert.equal(ui.nodes.get('portal-proof-manual').open, true);
    assert.equal(ui.nodes.get('portal-proof').focused, true);
    assert.equal(ui.nodes.get('verify-portal-submit').disabled, false);
    await ui.nodes.get('verify-portal-form').trigger('submit');
    assert.equal(legacyCalls, 0);
    assert.equal(signedCalls, 0);
    ui.assertLocal();
  }
});

test('malformed or mismatched transfer anchors and proof protocol never fill private inputs or auto-submit', async () => {
  const proof = completeFairProof();
  for (const mutate of [
    payload => { payload.hash = '00'.repeat(32); },
    payload => { payload.expectedDice.reverse(); },
    payload => { payload.expectedDice = payload.expectedDice.map(String); },
    payload => { payload.proof.protocol = 'system-csprng-v1'; },
    payload => { delete payload.proof; },
    payload => { payload.preimage = 'x'.repeat(4097); },
    payload => { payload.context = []; },
  ]) {
    let calls = 0;
    const payload = plain(transferredProof(proof));
    mutate(payload);
    const ui = createLocalUI({ hash: transferFragment(proof), transfer: { receive: async () => payload },
      api: { verifyPortalRoll: () => { calls += 1; }, verifyFairRoll: () => { calls += 1; } } });
    await ui.flush();
    assert.equal(calls, 0);
    assert.equal(ui.nodes.get('portal-preimage').value, '');
    assert.equal(ui.nodes.get('portal-proof').value, '');
    assert.match(ui.nodes.get('verify-page-notice').textContent, /не соответствуют|не получены/);
    ui.assertLocal();
  }
});

test('invalid transfer token, missing dice, duplicates and URL secrets are rejected before channel reception', async () => {
  const proof = completeFairProof();
  let calls = 0;
  for (const fragment of [
    transferFragment(proof, 'short'), transferFragment(proof, TRANSFER_TOKEN.toUpperCase()),
    transferFragment(proof).replace(`dice=${proof.dice.join(',')}&`, ''),
    `${transferFragment(proof)}&transfer=${TRANSFER_TOKEN}`,
    `${transferFragment(proof)}&proof=%7B%7D`, `${transferFragment(proof)}&serverSeed=secret`,
    `${transferFragment(proof)}&${'x'.repeat(385)}`,
  ]) {
    const ui = createLocalUI({ hash: fragment, transfer: { receive: async () => { calls += 1; } } });
    await ui.flush();
    assert.equal(ui.nodes.get('portal-hash').value, '');
    assert.match(ui.nodes.get('verify-page-notice').textContent, /не прошли проверку/);
    ui.assertLocal();
  }
  assert.equal(calls, 0);
});

test('editing any field cancels a pending import so late data cannot overwrite manual input or auto-verify', async () => {
  const proof = completeFairProof();
  let finish;
  let signal;
  let calls = 0;
  const wait = new Promise(resolve => { finish = resolve; });
  const ui = createLocalUI({ hash: transferFragment(proof),
    transfer: { receive: (token, options) => { signal = options.signal; return wait; } },
    api: { verifyPortalRoll: () => { calls += 1; }, verifyFairRoll: () => { calls += 1; } } });
  ui.nodes.get('portal-proof').value = '{"manual":true}';
  await ui.nodes.get('verify-portal-form').trigger('input');
  assert.equal(signal.aborted, true);
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, false);
  finish(transferredProof(proof));
  await ui.flush();
  assert.equal(ui.nodes.get('portal-proof').value, '{"manual":true}');
  assert.equal(ui.nodes.get('portal-preimage').value, '');
  assert.equal(calls, 0);
  ui.assertLocal();
});

test('a later hashchange import wins a race and cancels the previous transfer without restoring its private proof', async () => {
  const proof = completeFairProof();
  let finish;
  let signal;
  const wait = new Promise(resolve => { finish = resolve; });
  const ui = createLocalUI({ hash: transferFragment(proof),
    transfer: { receive: (token, options) => { signal = options.signal; return wait; } } });
  const legacy = `0103${'ff'.repeat(30)}`;
  await ui.changeFragment(`#hash=${legacy}&dice=2:4`);
  assert.equal(signal.aborted, true);
  assert.equal(firstStatus(portalResult(ui)), 'matched');
  finish(transferredProof(proof));
  await ui.flush();
  assert.equal(ui.nodes.get('portal-hash').value, legacy);
  assert.equal(ui.nodes.get('portal-proof').value, '');
  assert.equal(ui.nodes.get('portal-preimage').value, '');
  assert.equal(firstStatus(portalResult(ui)), 'matched');
  ui.assertLocal();
});

test('a transferred legacy disclosed input is checked automatically without being put in the URL', async () => {
  const preimage = 'completed one-use roll|never-in-address';
  const hash = sha256(preimage);
  const expectedDice = verifier.diceFromHash(hash).dice;
  const ui = createLocalUI({ hash: `#hash=${hash}&dice=${expectedDice.join(',')}&transfer=${TRANSFER_TOKEN}`,
    transfer: { receive: async () => ({ hash, expectedDice, preimage }) } });
  await ui.flush();
  assert.equal(firstStatus(portalResult(ui)), 'matched');
  assert.equal(ui.nodes.get('portal-preimage').value, preimage);
  assert.match(portalResult(ui).textContent, /Раскрытое исходное значение соответствует SHA-256/);
  assert.equal(ui.context.location.hash.includes(preimage), false);
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
    `hash=${hash}&dice=2:4&proof=%7B%22private%22%3A%22secret%22%7D`,
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
  for (const id of ['portal-hash', 'portal-preimage', 'portal-die-one', 'portal-die-two', 'portal-proof']) assert.equal(ui.nodes.get(id).value, '');
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
  assert.equal(firstStatus(portalResult(ui)), 'matched');
  assert.match(portalResult(ui).textContent, /Исходная строка SHA-256 \(целиком\)/);
  assert.ok(portalResult(ui).textContent.includes(seed));
  assert.doesNotMatch(portalResult(ui).textContent, /Проверка пройдена/);
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

test('the removed HMAC and Server Seed section has no fields, translated content, or UI handlers left behind', () => {
  const html = read('verify-game.html');
  const script = read('verify-game-ui.js');
  assert.doesNotMatch(html, /id="(?:verify-(?:hmac|seed)-(?:form|submit|result)|(?:hmac|seed)-(?:server-seed|client-seed|game-id|nonce))"/i);
  assert.doesNotMatch(html, /(?:verify-(?:seed|hmac)|hmac-)[\w-]*/);
  assert.deepEqual([...html.matchAll(/<form\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]), ['verify-portal-form']);
  // v37 legitimately displays revealed seeds as read-only proof details;
  // the removed unrelated manual HMAC form must not be restored.
  assert.doesNotMatch(script, /\b(?:verifySeed|verifyHmacRoll|readNonce)\b/i);
  assert.doesNotMatch(script, /(?:verify-(?:seed|hmac)|hmac-)[\w-]*/);
});

test('a portal-only API initializes without the deleted forms and still supports language, theme and exact SHA-256 submission', async () => {
  const calls = [];
  const api = { verifyPortalRoll: input => { calls.push(input); return verifier.verifyPortalRoll(input); } };
  const ui = createLocalUI({ api });
  assert.equal(ui.nodes.has('verify-seed-form'), false);
  assert.equal(ui.nodes.has('verify-hmac-form'), false);
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, false);
  const input = '  room|ВащеППЦ|🎲|<img src=x>\n';
  const hash = sha256(input);
  const dice = verifier.diceFromHash(hash).dice;
  setFields(ui, { 'portal-hash': hash, 'portal-die-one': String(dice[0]), 'portal-die-two': String(dice[1]), 'portal-preimage': input });
  await ui.languageButtons[1].trigger('click');
  await ui.themeButtons[0].trigger('click');
  assert.equal(ui.document.documentElement.lang, 'en');
  assert.equal(ui.document.documentElement.dataset.theme, 'day');
  await ui.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].preimage, input);
  assert.equal(calls[0].hash, hash);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].expectedDice)), dice);
  assert.equal(firstStatus(portalResult(ui)), 'matched');
  assert.match(portalResult(ui).textContent, /Dice match the hash/);
  assert.match(portalResult(ui).textContent, /does not include an independent source signature/);
  await ui.languageButtons[0].trigger('click');
  assert.equal(firstStatus(portalResult(ui)), 'matched');
  assert.match(portalResult(ui).textContent, /Кости соответствуют хешу/);
  assert.equal(ui.document.documentElement.dataset.theme, 'day');
  ui.assertLocal();
});

test('portal verification results and errors insert hostile text only as text nodes, never HTML', async () => {
  const hostile = '<img src=x onerror="throw 1">';
  const result = {
    status: 'incomplete', hash: hostile, hashStatus: 'unavailable', diceStatus: 'verified', dice: [2, 4], sourceBytes: [],
  };
  const fields = { 'portal-hash': `0103${'ff'.repeat(30)}`, 'portal-die-one': '2', 'portal-die-two': '4' };
  const ui = createLocalUI({ api: { verifyPortalRoll: async () => result } });
  setFields(ui, fields);
  await ui.nodes.get('verify-portal-form').trigger('submit');
  assert.ok(portalResult(ui).textContent.includes(hostile));
  ui.assertLocal();
  const errorUI = createLocalUI({ api: { verifyPortalRoll: async () => { throw new Error(hostile); } } });
  setFields(errorUI, fields);
  await errorUI.nodes.get('verify-portal-form').trigger('submit');
  assert.ok(portalResult(errorUI).textContent.includes(hostile));
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
  assert.equal(firstStatus(portalResult(ui)), 'matched');
  assert.match(portalResult(ui).textContent, /Dice match the hash/);
  assert.match(portalResult(ui).textContent, /does not include an independent source signature/);
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
  ui.nodes.get('portal-proof').value = '{"private":"explicitly pasted old proof"}';
  await ui.changeFragment(`#hash=${second}`);
  assert.equal(ui.nodes.get('portal-hash').value, second);
  assert.equal(ui.nodes.get('portal-preimage').value, '');
  assert.equal(ui.nodes.get('portal-proof').value, '');
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
  assert.equal(firstStatus(portalResult(ui)), 'matched');
  assert.ok(portalResult(ui).textContent.includes(second));
  finishOld({ status: 'verified', hashStatus: 'verified', diceStatus: 'verified', hash: first, dice: [2, 4], sourceBytes: [] });
  await oldSubmit;
  assert.equal(firstStatus(portalResult(ui)), 'matched');
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
  for (const id of ['portal-hash', 'portal-die-one', 'portal-die-two', 'portal-preimage', 'portal-proof']) {
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
    remoteCode: '',
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
    remoteCode: '',
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

test('the actual protected roll producer uses the signed proof for opening and ordinary rolls without local entropy or a legacy fallback', async () => {
  const source = read('game-controller.js');
  for (const opening of [true, false]) {
    const proof = completeFairProof();
    const calls = [];
    const state = { roomCode: 'ABCD-EFGH', history: [], turn: 'dark' };
    const original = JSON.stringify(state);
    const context = vm.createContext({
      state, remoteCode: 'ABCD-EFGH', mode: 'remote', fairDiceError: '', fairDiceInFlight: false,
      window: { NarduRooms: {
        fairDiceConfigured: () => true,
        fairDicePolicy: async roomCode => { calls.push(['policy', roomCode]); return { required: true }; },
        requestFairDice: async (roomCode, intent) => { calls.push(['proof', roomCode, plain(intent)]); return proof; },
      } },
      render: () => calls.push(['render']),
      publishRemoteState: async () => calls.push(['publish']),
      randomHex: () => { throw new Error('protected rolls must not select local entropy'); },
      sha256Hex: () => { throw new Error('protected rolls must not fall back to legacy SHA generation'); },
    });
    vm.runInContext([
      extractDeclaration(source, 'function diceValuesFromHash('),
      extractDeclaration(source, 'function expandRollValues('),
      extractDeclaration(source, 'async function shaDiceRoll('),
      'this.generate = shaDiceRoll;',
    ].join('\n'), context);
    const generated = await context.generate({ label: opening ? 'opening' : 'turn-roll', color: 'dark', noTie: opening });
    assert.equal(generated.proof, proof);
    assert.equal(generated.hash, proof.sha256);
    assert.equal(generated.input, proof.sha256Input);
    assert.deepEqual(plain(generated.values), proof.dice);
    assert.deepEqual(calls, [['policy', 'ABCD-EFGH'], ['render'], ['publish'],
      ['proof', 'ABCD-EFGH', { label: opening ? 'opening' : 'roll', color: opening ? 'none' : 'dark' }]]);
    assert.equal(context.fairDiceInFlight, false);
    assert.equal(JSON.stringify(state), original);
    context.window.NarduRooms.requestFairDice = async () => { throw new Error('source temporarily unavailable'); };
    await assert.rejects(context.generate({ label: 'turn-roll', color: 'dark' }), /source temporarily unavailable/);
  }
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
  assert.match(markup, /data-open-roll-verifier/);
  assert.match(markup, /Полная проверка/);
  const href = markup.match(/data-verifier-url="([^"]+)"/)[1].replaceAll('&amp;', '&');
  assert.doesNotMatch(href, /(?:seed|preimage|password|token)=/i);
  assert.ok(!href.includes('PRIVATE') && !href.includes(encodeURIComponent(secret)));
  assert.equal(context.NarduVerifyUI.rollControls({ sha256: 'broken', roll: '2:4' }), '');
});

test('a complete manually pasted signed proof shows an unambiguous success and every source/input value without duplicate fields', async () => {
  const proof = completeFairProof();
  const writes = [];
  const ui = createLocalUI({ loadCore: true, env: { fairDicePublicKey: FIXTURE_PUBLIC_KEY }, clipboard: { writeText: async value => { writes.push(value); } } });
  setFields(ui, { 'portal-proof': JSON.stringify(proof) });
  await ui.nodes.get('verify-portal-form').trigger('submit');
  const out = portalResult(ui);
  assert.equal(firstStatus(out), 'verified');
  assert.equal(out.childNodes[0].childNodes[0].textContent, 'Проверка пройдена');
  assert.match(out.textContent, /Источник броска подтверждён, кости рассчитаны верно\./);
  assert.match(out.textContent, /независимый drand, а не игрок или бот/);
  for (const value of [proof.chainHash, String(proof.beacon.round), proof.beacon.signature, proof.sha256Input, proof.sha256]) {
    assert.ok(out.textContent.includes(value), `complete value must be available: ${value}`);
  }
  assert.equal(writes.length, 0, 'no automatic clipboard writes');
  const inputDetails = out.childNodes.find(node => node.tagName === 'DETAILS' && node.childNodes[0]?.textContent === 'Исходная строка SHA-256 (целиком)');
  assert.ok(inputDetails);
  const inputCopy = inputDetails.childNodes.find(node => node.tagName === 'BUTTON');
  await inputCopy.trigger('click');
  assert.deepEqual(writes, [proof.sha256Input]);
  assert.equal(inputCopy.textContent, 'Скопировано');
  await ui.languageButtons[1].trigger('click');
  assert.equal(firstStatus(out), 'verified');
  assert.match(out.textContent, /Verification passed/);
  assert.match(out.textContent, /random value comes from independent drand, not a player or bot/);
  assert.match(out.textContent, /externally observed publication time/);
  ui.assertLocal();
});

test('a source-authentic signed proof without a configured receipt pin cannot display the success badge or a verified server reservation', async () => {
  const proof = { ...completeFairProof(), publicKey: FIXTURE_PUBLIC_KEY };
  const ui = createLocalUI({ loadCore: true });
  setFields(ui, { 'portal-proof': JSON.stringify(proof) });
  await ui.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(firstStatus(portalResult(ui)), 'incomplete');
  assert.match(portalResult(ui).textContent, /Подпись drand подтверждена/);
  assert.match(portalResult(ui).textContent, /Ключ проверки серверной записи не настроен/);
  assert.doesNotMatch(portalResult(ui).textContent, /Проверка пройдена|Подписанная серверная запись подтверждена/);
  assert.doesNotMatch(portalResult(ui).textContent, /Подтверждены подпись drand и подписанная/);
  ui.assertLocal();
});

test('a signed proof with a wrong pinned receipt or wrong external dice never falls back to positive legacy consistency', async () => {
  const proof = completeFairProof();
  const badReceipt = { ...proof, receiptSignature: '0'.repeat(128) };
  const ui = createLocalUI({ loadCore: true, env: { fairDicePublicKey: FIXTURE_PUBLIC_KEY } });
  setFields(ui, { 'portal-proof': JSON.stringify(badReceipt), 'portal-hash': proof.sha256,
    'portal-die-one': String(proof.dice[0]), 'portal-die-two': String(proof.dice[1]) });
  await ui.nodes.get('verify-portal-form').trigger('submit');
  assert.notEqual(firstStatus(portalResult(ui)), 'verified');
  assert.match(portalResult(ui).textContent, /Подпись серверной записи не соответствует настроенному ключу/);
  assert.doesNotMatch(portalResult(ui).textContent, /Проверка пройдена|Кости соответствуют хешу/);
  setFields(ui, { 'portal-proof': JSON.stringify(proof), 'portal-die-one': String(proof.dice[1]), 'portal-die-two': String(proof.dice[0]) });
  await ui.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(firstStatus(portalResult(ui)), 'mismatch');
  assert.match(portalResult(ui).textContent, /Обнаружено несовпадение/);
  assert.doesNotMatch(portalResult(ui).textContent, /Проверка пройдена/);
  ui.assertLocal();
});

test('malformed or partial signed inputs are rejected locally before invoking either verification method', async () => {
  let calls = 0;
  const api = { verifyPortalRoll: async () => { calls += 1; }, verifyFairRoll: async () => { calls += 1; } };
  for (const proof of ['bad JSON', '[]', 'null', '0', '{"value":"' + 'x'.repeat(16384) + '"}']) {
    const ui = createLocalUI({ api });
    setFields(ui, { 'portal-proof': proof });
    await ui.nodes.get('verify-portal-form').trigger('submit');
    assert.notEqual(firstStatus(portalResult(ui)), 'verified');
    assert.equal(ui.nodes.get('portal-proof').getAttribute('aria-invalid'), 'true');
    assert.equal(ui.nodes.get('portal-proof').focused, true);
    ui.assertLocal();
  }
  const partial = createLocalUI({ api });
  setFields(partial, { 'portal-proof': JSON.stringify(completeFairProof()), 'portal-die-one': '2', 'portal-die-two': '' });
  await partial.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(partial.nodes.get('portal-die-two').getAttribute('aria-invalid'), 'true');
  assert.equal(calls, 0);
});

test('signed proof details render hostile JSON fields as text and copy only explicitly selected complete proof data', async () => {
  const hostile = '<img src=x onerror="throw 1">';
  const proof = { ...completeFairProof(), note: hostile };
  const writes = [];
  const ui = createLocalUI({ loadCore: true, env: { fairDicePublicKey: FIXTURE_PUBLIC_KEY }, clipboard: { writeText: async value => writes.push(value) } });
  setFields(ui, { 'portal-proof': JSON.stringify(proof) });
  await ui.nodes.get('verify-portal-form').trigger('submit');
  const out = portalResult(ui);
  assert.equal(firstStatus(out), 'verified');
  assert.ok(out.textContent.includes('<img src=x onerror='));
  const details = out.childNodes.find(node => node.tagName === 'DETAILS' && node.childNodes[0]?.textContent === 'JSON-доказательство броска');
  assert.ok(details);
  assert.equal(details.childNodes.find(node => node.tagName === 'CODE').textContent, JSON.stringify(proof, null, 2));
  assert.equal(writes.length, 0);
  await details.childNodes.find(node => node.tagName === 'BUTTON').trigger('click');
  assert.deepEqual(JSON.parse(writes[0]), proof);
  ui.assertLocal();
});

test('editing a pending signed proof or navigating to a public fragment invalidates its old positive result and clears private JSON', async () => {
  const proof = completeFairProof();
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const ui = createLocalUI({ api: { ...verifier, verifyFairRoll: () => wait } });
  setFields(ui, { 'portal-proof': JSON.stringify(proof) });
  const submitted = ui.nodes.get('verify-portal-form').trigger('submit');
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, true);
  ui.nodes.get('portal-proof').value = '{"edited":true}';
  await ui.nodes.get('verify-portal-form').trigger('input');
  const hash = `0103${'ff'.repeat(30)}`;
  await ui.changeFragment(`#hash=${hash}&dice=2:4`);
  assert.equal(ui.nodes.get('portal-proof').value, '');
  assert.equal(firstStatus(portalResult(ui)), 'matched');
  finish({ status: 'verified', protocol: 'drand', sourceVerified: true, reservationVerified: true,
    hashStatus: 'verified', diceStatus: 'verified', hash: proof.sha256, input: proof.sha256Input, dice: proof.dice, proof });
  await submitted;
  assert.equal(firstStatus(portalResult(ui)), 'matched');
  assert.doesNotMatch(portalResult(ui).textContent, /Проверка пройдена/);
  assert.ok(!portalResult(ui).textContent.includes(proof.sha256Input));
  assert.equal(ui.nodes.get('verify-portal-submit').disabled, false);
  ui.assertLocal();
});
