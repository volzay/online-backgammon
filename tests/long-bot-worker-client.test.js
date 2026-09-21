const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadClient() {
  class FakeWorker {
    static instances = [];

    constructor(url, options) {
      this.url = String(url);
      this.options = options;
      this.listeners = new Map();
      this.messages = [];
      this.terminated = false;
      FakeWorker.instances.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(type, data = {}) {
      (this.listeners.get(type) || []).forEach(listener => listener(
        type === 'message' ? { data } : data,
      ));
    }
  }

  const document = {
    baseURI: 'https://example.test/game/',
    currentScript: { src: 'https://example.test/game/long-bot-worker-client.js?v=test-build' },
  };
  const window = {};
  const context = {
    window,
    document,
    location: { href: 'https://example.test/game/room.html' },
    URL,
    Worker: FakeWorker,
    Error,
    Promise,
    Object,
    Array,
    Map,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'long-bot-worker-client.js'), 'utf8'),
    context,
    { filename: 'long-bot-worker-client.js' },
  );
  return { api: window.NarduLongBotWorker, FakeWorker };
}

function makeEngine(overrides = {}) {
  return {
    version: 'long-analytic-test',
    policyImplementationId: 'policy-test',
    experienceReplaySnapshot() {
      return {
        fingerprint: 'experience-test',
        patterns: [{ key: 'opening', adjustment: 1.25 }],
      };
    },
    ...overrides,
  };
}

function workerResult(message, overrides = {}) {
  return {
    moves: [{ from: 12, die: 3 }],
    decision: { id: `decision-${message.id}`, source: 'engine' },
    engineVersion: message.payload.expected.engineVersion,
    policyImplementationId: message.payload.expected.policyImplementationId,
    experienceFingerprint: message.payload.expected.experienceFingerprint,
    ...overrides,
  };
}

test('long-bot client creates one versioned worker and sends immutable provenance', async () => {
  const { api, FakeWorker } = loadClient();
  assert.equal(FakeWorker.instances.length, 0);

  const engine = makeEngine();
  const state = {
    variant: 'long', turn: 'dark', dice: [3, 2],
    history: [{ fairDiceProof: { large: true } }],
    analysis: { botMemory: { decisions: [{ large: true }] } },
  };
  const pending = api.plan({ engine, state, isCurrent: () => true });
  assert.equal(FakeWorker.instances.length, 1);

  const worker = FakeWorker.instances[0];
  assert.equal(worker.url, 'https://example.test/game/long-bot-worker.js?v=test-build');
  assert.equal(worker.options.name, 'nardu-long-hard-bot');
  assert.equal(worker.messages.length, 1);
  const request = worker.messages[0];
  assert.equal(request.type, 'plan');
  assert.notEqual(request.payload.state, state);
  assert.deepEqual(JSON.parse(JSON.stringify(request.payload.state)), {
    variant: 'long', turn: 'dark', dice: [3, 2], history: [],
  });
  assert.equal(state.history.length, 1);
  assert.equal(state.analysis.botMemory.decisions.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(request.payload.expected)), {
    engineVersion: 'long-analytic-test',
    policyImplementationId: 'policy-test',
    experienceFingerprint: 'experience-test',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(request.payload.experience)), {
    fingerprint: 'experience-test',
    patterns: [{ key: 'opening', adjustment: 1.25 }],
  });

  const decision = { id: 'decision-provenance', source: 'engine', score: 17 };
  worker.emit('message', {
    id: request.id,
    ok: true,
    result: workerResult(request, {
      moves: [{ from: '12', die: '3', ignored: true }],
      decision,
    }),
  });
  const result = await pending;
  assert.equal(result.stale, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.moves)), [{ from: 12, die: 3 }]);
  assert.equal(result.decision, decision);
});

test('long-bot client correlates concurrent plans by request id', async () => {
  const { api, FakeWorker } = loadClient();
  const engine = makeEngine();
  const first = api.plan({
    engine,
    state: { marker: 'first' },
    isCurrent: () => true,
  });
  const second = api.plan({
    engine,
    state: { marker: 'second' },
    isCurrent: () => true,
  });
  const worker = FakeWorker.instances[0];
  const [firstMessage, secondMessage] = worker.messages;
  assert.notEqual(firstMessage.id, secondMessage.id);
  assert.equal(FakeWorker.instances.length, 1);

  worker.emit('message', {
    id: secondMessage.id,
    ok: true,
    result: workerResult(secondMessage, {
      moves: [{ from: 8, die: 4 }],
      decision: { id: 'second' },
    }),
  });
  worker.emit('message', {
    id: firstMessage.id,
    ok: true,
    result: workerResult(firstMessage, {
      moves: [{ from: 6, die: 2 }],
      decision: { id: 'first' },
    }),
  });

  assert.equal((await first).decision.id, 'first');
  assert.equal((await second).decision.id, 'second');
});

test('long-bot client rejects mismatched worker provenance', async () => {
  const { api, FakeWorker } = loadClient();
  const pending = api.plan({
    engine: makeEngine(),
    state: { turn: 'dark' },
    isCurrent: () => true,
  });
  const worker = FakeWorker.instances[0];
  const request = worker.messages[0];
  worker.emit('message', {
    id: request.id,
    ok: true,
    result: workerResult(request, { experienceFingerprint: 'other-experience' }),
  });
  await assert.rejects(pending, /provenance mismatch/);
});

test('long-bot client drops a completed plan when the turn became stale', async () => {
  const { api, FakeWorker } = loadClient();
  let current = true;
  const pending = api.plan({
    engine: makeEngine(),
    state: { turn: 'dark' },
    isCurrent: () => current,
  });
  const worker = FakeWorker.instances[0];
  const request = worker.messages[0];
  current = false;
  worker.emit('message', {
    id: request.id,
    ok: true,
    result: workerResult(request),
  });

  const result = await pending;
  assert.equal(result.stale, true);
  assert.equal(result.moves.length, 0);
  assert.equal(result.decision, null);
});

test('long-bot timeout terminates the stuck worker and rejects its whole queue', async () => {
  const { api, FakeWorker } = loadClient();
  const engine = makeEngine();
  const first = api.plan({
    engine,
    state: { marker: 'first' },
    isCurrent: () => true,
    timeoutMs: 5,
  });
  const second = api.plan({
    engine,
    state: { marker: 'second' },
    isCurrent: () => true,
    timeoutMs: 100,
  });
  const worker = FakeWorker.instances[0];
  const settled = await Promise.allSettled([first, second]);
  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[1].status, 'rejected');
  assert.match(settled[0].reason.message, /timed out after 5 ms/);
  assert.match(settled[1].reason.message, /timed out after 5 ms/);
  assert.equal(worker.terminated, true);

  const retry = api.plan({
    engine,
    state: { marker: 'retry' },
    isCurrent: () => true,
  });
  assert.equal(FakeWorker.instances.length, 2);
  const replacement = FakeWorker.instances[1];
  const retryMessage = replacement.messages[0];
  worker.emit('message', {
    id: worker.messages[0].id,
    ok: true,
    result: workerResult(worker.messages[0], { decision: { id: 'late-old-worker' } }),
  });
  replacement.emit('message', {
    id: retryMessage.id,
    ok: true,
    result: workerResult(retryMessage, { decision: { id: 'replacement' } }),
  });
  assert.equal((await retry).decision.id, 'replacement');
});

test('long-bot worker imports versioned runtime and returns decision provenance', () => {
  const worker = fs.readFileSync(path.join(ROOT, 'long-bot-worker.js'), 'utf8');
  assert.match(worker, /current\.searchParams\.get\('v'\)/);
  assert.match(worker, /url\.searchParams\.set\('v', version\)/);
  assert.match(worker, /assetUrl\('game\.js'\)/);
  assert.match(worker, /assetUrl\('long-bot-engine\.js'\)/);
  assert.match(worker, /assetUrl\('strong-bot\.js'\)/);
  assert.match(worker, /plan\(payload\.state, \{ liveTurnLatencyBudget: true \}\)/);
  assert.match(worker, /setExperience\?\.\(payload\.experience\.patterns/);
  assert.match(worker, /consumeLastDecision\?\.\(\)/);
  assert.match(worker, /experienceFingerprint:/);
  assert.match(worker, /policyImplementationId:/);
});

test('stale-turn watchdog is scoped to the long hard worker and cannot cancel WildBG or neural turns', () => {
  const controller = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8');
  const start = controller.indexOf('function ensureBotTurnLiveness()');
  const end = controller.indexOf('\n  function randomHex(', start);
  assert.ok(start >= 0 && end > start);
  const watchdog = controller.slice(start, end);
  assert.match(watchdog, /variant === 'long'/);
  assert.match(watchdog, /botDifficulty === 'hard'/);
  assert.match(watchdog, /NarduLongBotWorker\?\.plan/);
  assert.match(watchdog, /if \(guardedLongWorkerTurn && botTurnActive/);
  assert.doesNotMatch(watchdog, /WILDBG_ANALYSIS_TIMEOUT_MS/);
  assert.doesNotMatch(watchdog, /hard-neuro/);
});

test('room and Pages build include the long-bot worker runtime in load order', () => {
  const room = fs.readFileSync(path.join(ROOT, 'room.html'), 'utf8');
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-github-pages.js'), 'utf8');
  const controller = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8');
  assert.ok(room.indexOf('long-bot-engine.js') < room.indexOf('long-bot-worker-client.js'));
  assert.ok(room.indexOf('strong-bot.js') < room.indexOf('long-bot-worker-client.js'));
  assert.ok(room.indexOf('long-bot-worker-client.js') < room.indexOf('game-controller.js'));
  assert.match(build, /"long-bot-worker-client\.js"/);
  assert.match(build, /"long-bot-worker\.js"/);
  assert.match(controller, /const longClient = window\.NarduLongBotWorker/);
  assert.match(controller, /rememberBotDecision\(result\.decision\)/);
  assert.match(controller, /window\.NarduLongBotWorker\?\.cancel\?\.\(\)/);
});
