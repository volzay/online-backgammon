const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const lobby = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function extractFunction(signature) {
  const start = lobby.indexOf(signature);
  assert.ok(start >= 0, `${signature} exists`);
  const body = lobby.indexOf('{', start);
  let depth = 0;
  for (let index = body; index < lobby.length; index += 1) {
    if (lobby[index] === '{') depth += 1;
    if (lobby[index] === '}') depth -= 1;
    if (!depth) return lobby.slice(start, index + 1);
  }
  throw new Error(`Unclosed ${signature}`);
}

function element(dataset = {}) {
  const classes = new Set();
  const attributes = new Map();
  return {
    dataset, hidden: false, disabled: false, value: '', textContent: '', handlers: {},
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      contains(value) { return classes.has(value); },
      toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
    },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    removeAttribute(name) { attributes.delete(name); },
    focus() {}, scrollIntoView() {},
  };
}

function harness({ cleanup } = {}) {
  const options = [
    ['opponent', 'player'], ['opponent', 'bot'],
    ['difficulty', 'easy'], ['difficulty', 'medium'], ['difficulty', 'hard'], ['difficulty', 'hard-neuro'],
    ['variant', 'long'], ['variant', 'short'],
    ['access', 'open'], ['access', 'closed'],
    ['allowSpectators', 'yes'], ['allowSpectators', 'no'],
  ].map(([createOption, value]) => element({ createOption, value }));
  const ids = new Map();
  for (const id of ['create-game-panel', 'create-game-form', 'create-password', 'create-game-summary', 'create-game-error', 'join-code-panel', 'join-code-form', 'join-code', 'join-password', 'join-code-error']) {
    ids.set(id, element());
  }
  const selectors = new Map();
  for (const selector of ['[data-bot-settings]', '[data-access-settings]', '[data-password-settings]', '[data-spectator-settings]', '[data-neuro-note]', '[data-neuro-long-only]', '[data-create-close]', '[data-code-close]']) {
    selectors.set(selector, element());
  }
  const submit = element();
  ids.get('create-game-form').querySelector = () => submit;
  const persisted = [];
  let cleanupCalls = 0;
  let activeCalls = 0;
  const context = {
    URLSearchParams,
    document: {
      getElementById(id) { return ids.get(id); },
      querySelectorAll(selector) { assert.equal(selector, '[data-create-option]'); return options; },
      querySelector(selector) {
        if (selector === '[data-create-option="difficulty"].active') return options.find(btn => btn.dataset.createOption === 'difficulty' && btn.classList.contains('active'));
        assert.ok(selectors.has(selector), selector);
        return selectors.get(selector);
      },
    },
    window: { addEventListener() {} },
    location: { href: '', search: '' },
    tt(key) {
      return ({ bot_hard_neuro: 'Сложный бот-нейро', difficulty_hard_neuro: 'Сложный бот-нейро', bot_neuro_long_only: 'Сложный бот-нейро доступен только в длинных нардах.' })[key] || key;
    },
    NarduApp: { persistBotGameConfig(config) { persisted.push(JSON.parse(JSON.stringify(config))); } },
    ensureLobbyCleanup: async () => { cleanupCalls += 1; return cleanup ? cleanup() : { ok: true }; },
    loadActiveRoomWithTimeout: async () => { activeCalls += 1; return null; },
    redirectForRoomAuthError: () => false,
    createLocalGameCode: () => 'NEUR-1234',
  };
  vm.createContext(context);
  const maps = ['opponentLabelKeys', 'difficultyLabelKeys', 'variantLabelKeys', 'accessLabelKeys', 'botNameKeys', 'botDifficulties']
    .map(name => lobby.match(new RegExp(`^  const ${name} = .+;$`, 'm'))?.[0]);
  assert.ok(maps.every(Boolean));
  const start = lobby.indexOf('  const createGamePanel =');
  const end = lobby.indexOf('\n  syncCreatePanel();', start) + '\n  syncCreatePanel();'.length;
  vm.runInContext([
    ...maps,
    extractFunction('function isSupportedBotVariant'),
    extractFunction('function labelFor'),
    lobby.slice(start, end),
    extractFunction('function goToExistingBotRoom'),
    'globalThis.state = createState;',
  ].join('\n'), context);
  return {
    context, options, ids, selectors, submit, persisted,
    get cleanupCalls() { return cleanupCalls; },
    get activeCalls() { return activeCalls; },
    click(key, value) { return options.find(btn => btn.dataset.createOption === key && btn.dataset.value === value).handlers.click(); },
    sync() { context.syncCreatePanel(); },
    create() { return ids.get('create-game-form').handlers.submit({ preventDefault() {} }); },
  };
}

test('portal offers a separate localized neural difficulty without replacing existing bots', () => {
  for (const difficulty of ['easy', 'medium', 'hard', 'hard-neuro']) {
    assert.match(lobby, new RegExp(`data-create-option="difficulty" data-value="${difficulty}"`));
  }
  assert.match(lobby, /data-value="hard-neuro"[^>]*style="grid-column: 1 \/ -1;"[^>]*>Сложный бот-нейро<\/button>/);
  for (const key of ['difficulty_hard_neuro', 'bot_hard_neuro']) {
    assert.match(app, new RegExp(`${key}: 'Сложный бот-нейро'`));
    assert.match(app, new RegExp(`${key}: 'Hard neural bot'`));
  }
  assert.match(app, /сила игры против игроков ещё не подтверждена/);
  assert.doesNotMatch(lobby, /62[.,]2\s*%|65\s*%|50\s*%/);
});

test('selecting the neural bot shows an experimental note and preserves the separate summary identity', () => {
  const h = harness();
  h.click('opponent', 'bot');
  h.click('difficulty', 'hard-neuro');
  assert.equal(h.context.state.difficulty, 'hard-neuro');
  assert.equal(h.selectors.get('[data-neuro-note]').hidden, false);
  assert.equal(h.selectors.get('[data-neuro-long-only]').hidden, true);
  assert.match(h.ids.get('create-game-summary').textContent, /Сложный бот-нейро/);
  const button = h.options.find(btn => btn.dataset.value === 'hard-neuro');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
});

test('switching to short resets the neural selection to hard, disables it and explains long-only support', () => {
  const h = harness();
  h.click('opponent', 'bot');
  h.click('difficulty', 'hard-neuro');
  h.click('variant', 'short');
  assert.equal(h.context.state.difficulty, 'hard');
  assert.equal(h.selectors.get('[data-neuro-note]').hidden, true);
  assert.equal(h.selectors.get('[data-neuro-long-only]').hidden, false);
  const button = h.options.find(btn => btn.dataset.value === 'hard-neuro');
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  h.click('difficulty', 'hard-neuro');
  assert.equal(h.context.state.difficulty, 'hard', 'even a synthetic disabled click cannot select an unsupported bot');
  h.click('variant', 'long');
  assert.equal(button.disabled, false);
  assert.equal(h.selectors.get('[data-neuro-long-only]').hidden, true);
});

test('direct short neural creation is rejected before cleanup, room writes or navigation', async () => {
  const h = harness();
  Object.assign(h.context.state, { opponent: 'bot', difficulty: 'hard-neuro', variant: 'short' });
  await h.create();
  assert.equal(h.cleanupCalls, 0);
  assert.equal(h.activeCalls, 0);
  assert.equal(h.persisted.length, 0);
  assert.equal(h.context.location.href, '');
  assert.match(h.ids.get('create-game-error').textContent, /только в длинных/);
  assert.equal(h.submit.disabled, false);
});

test('long neural creation persists its identifier and launches the correct named room', async () => {
  const h = harness();
  h.click('opponent', 'bot');
  h.click('difficulty', 'hard-neuro');
  await h.create();
  assert.equal(h.cleanupCalls, 1);
  assert.equal(h.activeCalls, 1);
  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0].difficulty, 'hard-neuro');
  assert.equal(h.persisted[0].variant, 'long');
  const url = new URL(h.context.location.href, 'https://portal.example/');
  assert.equal(url.pathname, '/room.html');
  assert.equal(url.searchParams.get('difficulty'), 'hard-neuro');
  assert.equal(url.searchParams.get('variant'), 'long');
  assert.equal(url.searchParams.get('opp'), 'Сложный бот-нейро');
  assert.equal(url.searchParams.get('oppR'), '1500');
});

test('unsupported neural variant introduced during async cleanup is rejected before persistence', async () => {
  let release;
  const h = harness({ cleanup: () => new Promise(resolve => { release = resolve; }) });
  h.click('opponent', 'bot');
  h.click('difficulty', 'hard-neuro');
  const creating = h.create();
  h.context.state.variant = 'short';
  release({ ok: true });
  await creating;
  assert.equal(h.persisted.length, 0);
  assert.equal(h.context.location.href, '');
  assert.match(h.ids.get('create-game-error').textContent, /только в длинных/);
  assert.equal(h.submit.disabled, false);
  assert.equal(h.ids.get('create-game-form').getAttribute('aria-busy'), undefined);
});

test('returning to an existing neural room does not downgrade it to an easy or hard bot', () => {
  const h = harness();
  assert.equal(h.context.goToExistingBotRoom({ code: 'NEUR-4567', opponent: 'bot', botDifficulty: 'hard-neuro', variant: 'long', playerColor: 'dark' }), true);
  assert.equal(h.persisted[0].difficulty, 'hard-neuro');
  assert.equal(h.persisted[0].botName, 'Сложный бот-нейро');
  const url = new URL(h.context.location.href, 'https://portal.example/');
  assert.equal(url.searchParams.get('difficulty'), 'hard-neuro');
  assert.equal(url.searchParams.get('color'), 'dark');
  assert.equal(url.searchParams.get('oppR'), '1500');
});

test('an unsupported restored short neural room cannot navigate or persist a disguised ordinary bot', () => {
  const h = harness();
  assert.equal(h.context.goToExistingBotRoom({ code: 'NEUR-4567', opponent: 'bot', botDifficulty: 'hard-neuro', variant: 'short' }), false);
  assert.equal(h.persisted.length, 0);
  assert.equal(h.context.location.href, '');
});

test('ordinary bots still launch with their unchanged identities in short backgammon', async () => {
  for (const [difficulty, rating] of [['easy', '900'], ['medium', '1200'], ['hard', '1500']]) {
    const h = harness();
    h.click('opponent', 'bot');
    h.click('variant', 'short');
    h.click('difficulty', difficulty);
    await h.create();
    const url = new URL(h.context.location.href, 'https://portal.example/');
    assert.equal(url.searchParams.get('difficulty'), difficulty);
    assert.equal(url.searchParams.get('variant'), 'short');
    assert.equal(url.searchParams.get('oppR'), rating);
    assert.equal(h.selectors.get('[data-neuro-note]').hidden, true);
  }
});
