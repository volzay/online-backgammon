const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const nextTask = () => new Promise(resolve => setImmediate(resolve));

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
    currentScript: { src: 'https://example.test/game/short-bot-wildbg-client.js?v=test-build' },
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
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'short-bot-wildbg-client.js'), 'utf8'),
    context,
    { filename: 'short-bot-wildbg-client.js' },
  );
  return { api: window.NarduShortBotWildbg, FakeWorker };
}

async function readyClient() {
  const loaded = loadClient();
  const pending = loaded.api.preload();
  const worker = loaded.FakeWorker.instances[0];
  worker.emit('message', { id: worker.messages[0].id, ok: true, result: { ready: true } });
  await pending;
  return { ...loaded, worker };
}

test('WildBG client lazily creates one versioned module worker and deduplicates preload', async () => {
  const { api, FakeWorker } = loadClient();
  assert.equal(FakeWorker.instances.length, 0);

  const first = api.preload();
  const second = api.preload();
  assert.equal(first, second);
  assert.equal(FakeWorker.instances.length, 1);
  const worker = FakeWorker.instances[0];
  assert.equal(worker.options.type, 'module');
  assert.equal(worker.options.name, 'nardu-short-bot-wildbg');
  assert.equal(worker.url, 'https://example.test/game/short-bot-wildbg-worker.js?v=test-build');
  assert.equal(worker.messages.length, 1);
  assert.equal(worker.messages[0].type, 'preload');

  worker.emit('message', {
    id: worker.messages[0].id,
    ok: true,
    result: { ready: true },
  });
  assert.deepEqual(await first, { ready: true });
  assert.deepEqual(await second, { ready: true });
});

test('WildBG client correlates analysis replies by request id', async () => {
  const { api, worker } = await readyClient();
  const first = api.analyze({ board: Array(26).fill(0), die1: 1, die2: 2 });
  const second = api.analyze({ board: Array(26).fill(0), die1: 3, die2: 4 });
  await nextTask();
  const [firstMessage, secondMessage] = worker.messages.slice(1);
  assert.notEqual(firstMessage.id, secondMessage.id);

  worker.emit('message', { id: secondMessage.id, ok: true, result: { marker: 'second' } });
  worker.emit('message', { id: firstMessage.id, ok: true, result: { marker: 'first' } });
  assert.deepEqual(await first, { marker: 'first' });
  assert.deepEqual(await second, { marker: 'second' });
});

test('turn planner uses the analytic fallback exactly once after a worker error', async () => {
  const { api, worker } = await readyClient();
  let fallbackCalls = 0;
  let adapterCalls = 0;
  const resultPromise = api.plan({
    engine: {
      prepareWildbgRequest() {
        return { board: Array(26).fill(0), die1: 2, die2: 5, isOnePointer: true };
      },
      planFromWildbgAnalysis() { adapterCalls += 1; return [{ from: 1, die: 2 }]; },
    },
    state: { turn: 'dark' },
    isCurrent: () => true,
    fallback() { fallbackCalls += 1; return [{ from: 6, die: 5 }]; },
  });
  await nextTask();
  const request = worker.messages.at(-1);
  worker.emit('message', { id: request.id, ok: false, error: 'model unavailable' });

  const result = await resultPromise;
  assert.equal(result.stale, false);
  assert.equal(result.fallback, true);
  assert.equal(fallbackCalls, 1);
  assert.equal(adapterCalls, 0);
  assert.deepEqual(result.planned, [{ from: 6, die: 5 }]);
});

test('turn planner drops stale analysis without adapting or falling back', async () => {
  const { api, worker } = await readyClient();
  let current = true;
  let fallbackCalls = 0;
  let adapterCalls = 0;
  const resultPromise = api.plan({
    engine: {
      prepareWildbgRequest() {
        return { board: Array(26).fill(0), die1: 2, die2: 5, isOnePointer: true };
      },
      planFromWildbgAnalysis() { adapterCalls += 1; return []; },
    },
    state: { turn: 'dark' },
    isCurrent: () => current,
    fallback() { fallbackCalls += 1; return []; },
  });
  await nextTask();
  current = false;
  const request = worker.messages.at(-1);
  worker.emit('message', { id: request.id, ok: true, result: { moves: [] } });

  const result = await resultPromise;
  assert.equal(result.stale, true);
  assert.equal(fallbackCalls, 0);
  assert.equal(adapterCalls, 0);
});

test('an analysis timeout terminates the stuck worker and rejects its queue', async () => {
  const { api, worker, FakeWorker } = await readyClient();
  const first = api.analyze({ board: Array(26).fill(0), die1: 1, die2: 2 }, { timeoutMs: 5 });
  const second = api.analyze({ board: Array(26).fill(0), die1: 3, die2: 4 }, { timeoutMs: 100 });
  await assert.rejects(first, /timed out/);
  await assert.rejects(second, /timed out/);
  assert.equal(worker.terminated, true);

  const retry = api.preload();
  assert.equal(FakeWorker.instances.length, 2);
  const replacement = FakeWorker.instances[1];
  replacement.emit('message', {
    id: replacement.messages[0].id,
    ok: true,
    result: { ready: true },
  });
  await retry;
});

test('worker adapter accepts the production board/dice contract', () => {
  const worker = fs.readFileSync(path.join(ROOT, 'short-bot-wildbg-worker.js'), 'utf8');
  assert.match(worker, /import\(glueUrl\.href\)/);
  assert.match(worker, /glueUrl\.searchParams\.set\('v', version\)/);
  assert.match(worker, /wasmUrl\.searchParams\.set\('v', version\)/);
  assert.match(worker, /payload\?\.board \|\| payload\?\.pips/);
  assert.match(worker, /payload\?\.die1 \?\? payload\?\.dieOne/);
  assert.match(worker, /payload\?\.isOnePointer \?\? payload\?\.onePointer/);
  assert.match(worker, /new Int8Array|Int8Array\.from/);
});

test('room and Pages build include the WildBG browser runtime', () => {
  const room = fs.readFileSync(path.join(ROOT, 'room.html'), 'utf8');
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-github-pages.js'), 'utf8');
  const controller = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8');
  assert.ok(room.indexOf('short-bot-engine.js') < room.indexOf('short-bot-wildbg-client.js'));
  assert.ok(room.indexOf('short-bot-wildbg-client.js') < room.indexOf('game-controller.js'));
  assert.match(build, /"short-bot-wildbg-worker\.js"/);
  assert.match(build, /"vendor\/wildbg\/wildbg_wasm_browser\.js"/);
  assert.match(build, /"vendor\/wildbg\/wildbg_wasm_bg\.wasm"/);
  assert.match(build, /"vendor\/wildbg\/NOTICE\.md"/);
  assert.match(controller, /mode !== 'bot' \|\| variant !== 'short' \|\| botDifficulty !== 'hard'/);
  assert.match(controller, /botTurnActive/);
  assert.match(controller, /botTurnStateKey/);
  assert.match(controller, /Object\.entries\(source\?\.points \|\| \{\}\)/);
  assert.match(controller, /result\?\.stale/);
});
