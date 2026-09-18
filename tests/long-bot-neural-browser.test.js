const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MAX_MODEL_BYTES, readModelFile, createDemoSession, mount } = require('../experiments/long-neural/demo');

function rules() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../game.js'), 'utf8'), context);
  return context.window.NarduGame;
}
const model = () => ({ schema: 'browser-test-model', weights: [0.5] });
function network(game, override = {}) {
  return {
    validateModel(value) {
      assert.equal(value?.schema, 'browser-test-model', 'bad model schema');
      assert.deepEqual(Object.keys(value).sort(), ['schema', 'weights']);
      assert.ok(Array.isArray(value.weights) && value.weights.length === 1 && Number.isFinite(value.weights[0]));
      return value;
    },
    createNeuralBot() {
      return { plan(state) { return game.bestMoveSequences(state)[0].map(move => ({ from: move.from, die: move.die })); } };
    },
    predict() { return 0.5; },
    ...override,
  };
}
function file(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { size: Buffer.byteLength(text), text: async () => text };
}

test('neural laboratory refuses oversized model files before reading their contents', async () => {
  let reads = 0;
  await assert.rejects(readModelFile({ size: MAX_MODEL_BYTES + 1, text: async () => { reads++; return '{}'; } }, network(rules())), /2 МиБ/);
  assert.equal(reads, 0);
  for (const size of [undefined, -1, 0, 1, 2.5, Infinity]) {
    await assert.rejects(readModelFile({ size, text: async () => '{}' }, network(rules())), /2 МиБ/);
  }
});

test('neural laboratory repeats UTF-8 size check after reading and rejects malformed JSON', async () => {
  await assert.rejects(readModelFile({ size: 20, text: async () => 'я'.repeat(MAX_MODEL_BYTES) }, network(rules())), /размер/);
  for (const invalid of ['{', '{}', '[]', 'null', 'true', '"code"']) {
    await assert.rejects(readModelFile(file(invalid), network(rules())));
  }
});

test('neural laboratory accepts only validated bare model or known inert training envelope', async () => {
  const neural = network(rules());
  assert.deepEqual(await readModelFile(file(model()), neural), model());
  const artifact = { schema: 'long-neural-training-artifact-v1', model: model(),
    trainingManifest: { unverifiedClaim: '65% is not trusted' }, inertUnknownField: 'not evaluated' };
  assert.deepEqual(await readModelFile(file(artifact), neural), model());
  for (const bad of [
    { ...artifact, schema: 'foreign-artifact' }, { ...artifact, trainingManifest: null },
    { ...artifact, trainingManifest: [] }, { ...artifact, model: null },
    { ...artifact, model: { schema: 'arbitrary-model', weights: [0.5] } },
  ]) await assert.rejects(readModelFile(file(bad), neural));
});

test('neural laboratory accepts v2 cumulative wrapper without trusting or executing its metadata', async () => {
  const neural = network(rules());
  const artifact = { schema: 'long-neural-training-artifact-v2', model: model(),
    trainingManifest: { algorithm: 'file-supplied', cumulativeGames: 2000,
      claimedWinRate: 0.99, instructions: 'metadata remains inert' },
    checkpoints: [{ modelFingerprint: 'unverified-file-value' }],
    unknownField: { code: 'throw new Error("must never execute")' } };
  assert.deepEqual(await readModelFile(file(artifact), neural), model());
  for (const bad of [
    { ...artifact, schema: 'long-neural-training-artifact-v3' },
    { ...artifact, trainingManifest: undefined }, { ...artifact, trainingManifest: [] },
    { ...artifact, trainingManifest: 'claimed manifest' }, { ...artifact, model: [] },
    { ...artifact, model: { ...model(), injectedWeights: [] } },
  ]) await assert.rejects(readModelFile(file(bad), neural));
});

test('v2 model acceptance remains bounded and invalid replacement clears a previously selected turn', async () => {
  const game = rules();
  const neural = network(game);
  const session = createDemoSession(game, neural);
  const artifact = { schema: 'long-neural-training-artifact-v2', model: model(), trainingManifest: {} };
  session.setModel(await readModelFile(file(artifact), neural));
  session.choose(2, 4);
  assert.throws(() => session.setModel({ ...artifact, model: { schema: 'foreign-model' } }));
  assert.equal(session.hasModel(), false);
  assert.equal(session.hasPlan(), false);
  await assert.rejects(readModelFile(file({ ...artifact,
    metadata: 'x'.repeat(MAX_MODEL_BYTES) }), neural), /2 МиБ/);
});

test('neural laboratory cannot choose or apply a move without a validated model', () => {
  const game = rules();
  const session = createDemoSession(game, network(game));
  assert.equal(session.snapshot().variant, 'long');
  assert.equal(session.hasModel(), false);
  assert.throws(() => session.choose(2, 4), /модель/);
  assert.throws(() => session.apply(), /хода/);
});

test('neural laboratory uses actual long rules, expands doubles and atomically applies a legal complete turn', () => {
  const game = rules();
  const session = createDemoSession(game, network(game));
  session.setModel(model());
  const before = session.snapshot();
  const result = session.choose(3, 3);
  assert.deepEqual(result.dice, [3, 3, 3, 3]);
  assert.deepEqual(session.snapshot(), before, 'planning must not mutate the board');
  const canonical = game.bestMoveSequences({ ...before, phase: 'move', rolled: [3, 3, 3, 3], dice: [3, 3, 3, 3] });
  assert.ok(canonical.some(sequence => JSON.stringify(sequence.map(move => [move.from, move.to, move.die]))
    === JSON.stringify(result.moves.map(move => [move.from, move.to, move.die]))));
  const after = session.apply();
  assert.equal(after.turn, 'dark');
  assert.equal(after.phase, 'roll');
  assert.equal(session.hasPlan(), false);
  assert.notDeepEqual(after.points, before.points);
  assert.throws(() => session.apply(), /хода/);
});

test('neural laboratory alternates both sides with supplied synthetic dice and never calls random roll methods', () => {
  const game = rules();
  const isolated = { ...game, rollDice() { assert.fail('must not generate portal dice'); },
    decideOpeningRoll() { assert.fail('must not generate opening dice'); } };
  const session = createDemoSession(isolated, network(game));
  session.setModel(model());
  for (let turn = 0; turn < 8; turn++) {
    assert.equal(session.choose(2, 4).color, turn % 2 ? 'dark' : 'white');
    session.apply();
  }
  assert.equal(session.snapshot().turn, 'white');
});

test('neural laboratory rejects illegal or incomplete bot plans without changing position', () => {
  const game = rules();
  for (const plan of [null, {}, Array(5).fill({ from: 24, die: 1 }),
    [{ from: 12, die: 3 }], [{ from: 24, die: 0 }], [{ from: 24, die: 3 }], [], [{ from: 25, die: 4 }]]) {
    const session = createDemoSession(game, network(game, { createNeuralBot: () => ({ plan: () => plan }) }));
    session.setModel(model());
    const before = session.snapshot();
    assert.throws(() => session.choose(3, 4));
    assert.deepEqual(session.snapshot(), before);
    assert.equal(session.hasPlan(), false);
  }
});

test('failed replacement model and failed roll cannot retain an enabled stale action', () => {
  const game = rules();
  const session = createDemoSession(game, network(game));
  session.setModel(model());
  session.choose(2, 4);
  assert.throws(() => session.choose(0, 4), /кубики/);
  assert.equal(session.hasPlan(), false);
  session.choose(2, 4);
  assert.throws(() => session.setModel({ schema: 'bad' }));
  assert.equal(session.hasModel(), false);
  assert.equal(session.hasPlan(), false);
  assert.throws(() => session.apply());
});

test('laboratory snapshots and passed model are isolated from caller mutation; reset preserves only valid model', () => {
  const game = rules();
  const supplied = model();
  let networkModel;
  const session = createDemoSession(game, network(game, {
    createNeuralBot(_rules, passed) { networkModel = passed; return network(game).createNeuralBot(); },
  }));
  session.setModel(supplied);
  supplied.weights[0] = 99;
  assert.equal(networkModel.weights[0], 0.5);
  const exposed = session.snapshot();
  exposed.points[24].count = 1;
  assert.equal(session.snapshot().points[24].count, 15);
  session.choose(2, 4);
  session.apply();
  session.reset();
  assert.equal(session.snapshot().points[24].count, 15);
  assert.equal(session.snapshot().turn, 'white');
  assert.equal(session.hasModel(), true);
  assert.equal(session.hasPlan(), false);
});

test('offline HTML and controller are separate from production, truthful and free of credential or network calls', () => {
  const html = fs.readFileSync(path.join(__dirname, '../experiments/long-neural/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../experiments/long-neural/demo.js'), 'utf8');
  assert.match(html, /локальный учебный стенд/);
  assert.match(html, /необученная сеть/);
  assert.match(html, /не подтверждённое происхождение/);
  assert.match(html, /id="choose"[^>]*disabled/);
  assert.match(html, /src="\.\.\/\.\.\/game\.js"/);
  assert.match(html, /src="\.\.\/\.\.\/lib\/long-bot-neural\.js"/);
  assert.doesNotMatch(js, /\bfetch\s*\(|XMLHttpRequest|Math\.random|localStorage|sessionStorage|supabase|RoomsClient|innerHTML|\beval\s*\(|new Function/);
  assert.doesNotMatch(html, /supabase-client|rooms-client|strong-bot\.js|controller\.js|https?:\/\//);
});

test('missing DOM mount is inert in server-side and diagnostic contexts', () => {
  assert.equal(mount(null, null, null), undefined);
  assert.equal(mount({ getElementById: () => null }, null, null), undefined);
});

function fakeDocument() {
  const make = () => ({ disabled: false, textContent: '', value: '', files: [], children: [], listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute() {}, append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  });
  const elements = Object.fromEntries(['model-file', 'model-status', 'choose', 'apply', 'reset',
    'turn-status', 'board', 'board-summary', 'plan-output', 'turn-form', 'die-one', 'die-two']
    .map(id => [id, make()]));
  elements['die-one'].value = '2';
  elements['die-two'].value = '4';
  return { elements, getElementById: id => elements[id], createElement: make };
}

test('mounted laboratory enables actions only after validation and disables them on rejected replacement', async () => {
  const game = rules();
  const document = fakeDocument();
  mount(document, game, network(game));
  const elements = document.elements;
  assert.equal(elements.board.children.length, 24);
  assert.equal(elements.choose.disabled, true);
  assert.equal(elements.apply.disabled, true);
  elements['model-file'].files = [file(model())];
  await elements['model-file'].listeners.change();
  assert.equal(elements.choose.disabled, false);
  assert.match(elements['model-status'].textContent, /Сила игры не сертифицирована/);
  elements['turn-form'].listeners.submit({ preventDefault() {} });
  assert.equal(elements.apply.disabled, false);
  assert.match(elements['plan-output'].textContent, /выбранные_законные_ходы/);
  elements['model-file'].files = [file('{')];
  await elements['model-file'].listeners.change();
  assert.match(elements['model-status'].textContent, /отклонена/);
  assert.equal(elements.choose.disabled, true);
  assert.equal(elements.apply.disabled, true);
});

test('mounted laboratory never lets an older asynchronous upload overwrite the latest validated file', async () => {
  const game = rules();
  const document = fakeDocument();
  mount(document, game, network(game));
  const elements = document.elements;
  let resolveOlder;
  elements['model-file'].files = [{ size: 20, text: () => new Promise(resolve => { resolveOlder = resolve; }) }];
  const older = elements['model-file'].listeners.change();
  assert.equal(elements.choose.disabled, true);
  elements['model-file'].files = [file(model())];
  await elements['model-file'].listeners.change();
  resolveOlder('{');
  await older;
  assert.equal(elements.choose.disabled, false);
  assert.match(elements['model-status'].textContent, /проверен/);
});

test('real neural model and real long rules load, choose and preserve the exact frozen-policy value', async () => {
  const neural = require('../lib/long-bot-neural');
  const game = rules();
  const actual = neural.createModel({ seed: 7341, hiddenSize: 8 });
  const session = createDemoSession(game, neural);
  session.setModel(await readModelFile(file(actual), neural));
  for (let turn = 0; turn < 4; turn++) {
    const result = session.choose(3, 4);
    const input = session.snapshot();
    game.applyRoll(input, [3, 4]);
    const ranked = neural.createNeuralBot(game, actual).rank(input);
    assert.deepEqual(result.moves.map(({ from, die }) => ({ from, die })), JSON.parse(JSON.stringify(ranked[0].moves)));
    assert.equal(result.prediction, ranked[0].value);
    assert.equal(result.coverage.truncated, false);
    session.apply();
  }
});

test('browser reports actual uploaded zero-step neural weights as untrained, not a strong model', async () => {
  const neural = require('../lib/long-bot-neural');
  const document = fakeDocument();
  mount(document, rules(), neural);
  document.elements['model-file'].files = [file(neural.createModel({ seed: 9, hiddenSize: 4 }))];
  await document.elements['model-file'].listeners.change();
  assert.match(document.elements['model-status'].textContent, /НЕОБУЧЕНА/);
  assert.equal(document.elements.choose.disabled, false, 'valid untrained weights can be inspected offline only');
});

test('browser accepts real v2 checkpoint weights but never labels training steps as certified strength', async () => {
  const neural = require('../lib/long-bot-neural');
  const actual = neural.createModel({ seed: 23, hiddenSize: 4 });
  actual.trainingSteps = 120;
  const document = fakeDocument();
  mount(document, rules(), neural);
  document.elements['model-file'].files = [file({ schema: 'long-neural-training-artifact-v2',
    model: actual, trainingManifest: { claimedReadyForProduction: true } })];
  await document.elements['model-file'].listeners.change();
  assert.equal(document.elements.choose.disabled, false);
  assert.match(document.elements['model-status'].textContent, /Сила игры не сертифицирована/);
  assert.doesNotMatch(document.elements['model-status'].textContent, /сильный|65%|готова|production/i);
});

test('offline lab server CLI is bounded, has no external host option and rejects ambiguous arguments', () => {
  const server = require('../scripts/serve-long-bot-neural-demo');
  assert.deepEqual(server.parseOptions([]), { port: 3909 });
  assert.deepEqual(server.parseOptions(['--port', '4321']), { port: 4321 });
  assert.deepEqual(server.parseOptions(['--help']), { help: true });
  for (const argv of [['--host', '0.0.0.0'], ['--port', '0'], ['--port', '65536'],
    ['--port', '-1'], ['--port', '1.5'], ['--port', '3909', '--port', '3910'], ['--help', '--port', '3909']]) {
    assert.throws(() => server.parseOptions(argv));
  }
  const source = fs.readFileSync(path.join(__dirname, '../scripts/serve-long-bot-neural-demo.js'), 'utf8');
  assert.match(source, /server\.listen\(options\.port, '127\.0\.0\.1'/);
  assert.doesNotMatch(source, /writeFile|createWriteStream|supabase|auth-users|process\.env/);
});

function staticRequest(url, method = 'GET') {
  const { requestHandler } = require('../scripts/serve-long-bot-neural-demo');
  return new Promise(resolve => {
    const output = {};
    requestHandler({ url, method }, {
      writeHead(status, headers) { output.status = status; output.headers = headers; },
      end(body) { output.body = body; resolve(output); },
    });
  });
}

test('offline lab serves exactly allowlisted files and denies repo data, APIs and path tricks', async () => {
  const { FILES, ENTRY } = require('../scripts/serve-long-bot-neural-demo');
  assert.equal(Object.keys(FILES).length, 5);
  const index = await staticRequest('/');
  assert.equal(index.status, 302);
  assert.equal(index.headers.Location, ENTRY);
  for (const route of Object.keys(FILES)) {
    const response = await staticRequest(route);
    assert.equal(response.status, 200);
    assert.ok(response.body.length > 0);
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(response.headers['Content-Security-Policy'], /connect-src 'none'/);
    assert.match(response.headers['Content-Security-Policy'], /form-action 'none'/);
    const head = await staticRequest(route, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, undefined);
  }
  for (const route of ['/data/auth-users.json', '/.env', '/package.json', '/api/rooms',
    '/lib', '/lib/long-bot-neural.js/extra', '/%2e%2e/.env', '/lib/../../data/auth-users.json',
    '/__proto__', '/toString', '/experiments/long-neural/']) {
    assert.equal((await staticRequest(route)).status, 404, route);
  }
  assert.equal((await staticRequest(ENTRY, 'POST')).status, 405);
});
