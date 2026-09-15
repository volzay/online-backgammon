const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const ROOT = path.join(__dirname, '..');

function quotaStorage(initial = {}, limit = 900) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.get(key) || null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) {
      const next = new Map(values);
      next.set(key, String(value));
      const size = [...next.entries()].reduce((sum, [name, item]) => sum + name.length + item.length, 0);
      if (size > limit) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
      values.set(key, String(value));
    },
  };
}

async function loadClient(storage, {
  fetchImpl = globalThis.fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let clientOptions = null;
  const context = {
    window: {
      NARDU_ENV: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon' },
      supabase: {
        createClient(url, key, options) {
          clientOptions = options;
          return { url, key, options };
        },
      },
    },
    document: { querySelector() { return null; }, createElement() { return {}; }, head: { appendChild() {} } },
    localStorage: storage,
    console,
    Set,
    AbortController,
    fetch: fetchImpl,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
  };
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'supabase-client.js'), 'utf8'), context, { filename: 'supabase-client.js' });
  await context.window.NarduSupabase.client();
  return { storage: clientOptions.auth.storage, options: clientOptions, api: context.window.NarduSupabase };
}

test('Supabase auth token storage evicts reproducible game caches before losing a session', async () => {
  const storage = quotaStorage({
    'narduh-long-bot-server-experience-v15': 'x'.repeat(620),
    'narduh-long-bot-server-experience-v14': 'x'.repeat(620),
    'narduh-long-bot-server-experience-v13': 'x'.repeat(620),
    'narduh-long-bot-server-experience-v12': 'x'.repeat(620),
    'narduh-long-bot-server-experience-v11': 'x'.repeat(620),
    'narduh-long-bot-server-experience-v8': 'x'.repeat(620),
    'narduh-long-bot-server-experience-v7': 'x'.repeat(620),
    'narduh-short-bot-server-experience-v5': 'x'.repeat(620),
    'narduh-short-bot-server-experience-v6': 'x'.repeat(620),
    'narduh-short-bot-experience-v4': 'x'.repeat(620),
    'narduh-long-bot-experience-v8': 'current-memory',
    'narduh-long-bot-experience-v7': 'stale-memory',
    'narduh-long-bot-experience-v6': 'stale-memory',
    'narduh-long-bot-experience-v5': 'stale-memory',
    'narduh-long-bot-experience-v4': 'stale-memory',
    'narduh-long-bot-experience-v3': 'current-memory',
    'narduh-long-bot-experience-v2': 'stale-memory',
    'narduh-long-bot-experience-v1': 'legacy-memory',
    'narduh-user': JSON.stringify({ id: 'user-1', name: 'warlord', history: [] }),
    'sb-other-auth-token': 'active-session',
  });
  const client = await loadClient(storage);

  assert.doesNotThrow(() => client.storage.setItem('sb-project-auth-token', 'token'.repeat(40)));
  assert.equal(storage.getItem('narduh-long-bot-server-experience-v15'), null);
  assert.equal(storage.getItem('narduh-long-bot-server-experience-v14'), null);
  assert.equal(storage.getItem('narduh-long-bot-server-experience-v13'), null);
  assert.equal(storage.getItem('narduh-long-bot-server-experience-v12'), null);
  assert.equal(storage.getItem('narduh-long-bot-server-experience-v11'), null);
  assert.equal(storage.getItem('narduh-long-bot-server-experience-v8'), null);
  assert.equal(storage.getItem('narduh-long-bot-server-experience-v7'), null);
  assert.equal(storage.getItem('narduh-short-bot-server-experience-v5'), null);
  assert.equal(storage.getItem('narduh-short-bot-server-experience-v6'), null);
  assert.equal(storage.getItem('narduh-short-bot-experience-v4'), null);
  assert.equal(storage.getItem('narduh-long-bot-experience-v8'), null);
  assert.equal(storage.getItem('narduh-long-bot-experience-v7'), null);
  assert.equal(storage.getItem('narduh-long-bot-experience-v6'), null);
  assert.equal(storage.getItem('narduh-long-bot-experience-v5'), null);
  assert.equal(storage.getItem('narduh-long-bot-experience-v4'), null);
  assert.equal(storage.getItem('narduh-long-bot-experience-v3'), null);
  assert.equal(storage.getItem('narduh-long-bot-experience-v2'), null);
  assert.equal(storage.getItem('narduh-long-bot-experience-v1'), null);
  assert.equal(storage.getItem('sb-project-auth-token'), 'token'.repeat(40));
  assert.equal(storage.getItem('sb-other-auth-token'), 'active-session');
  assert.match(storage.getItem('narduh-user'), /warlord/);
});

test('Supabase REST mutations carry the guest id and its private proof', async () => {
  const guestProof = `gproof:${'21'.repeat(32)}`;
  const guestId = `guest:sha256:${createHash('sha256')
    .update(`nardu/guest/v1:${guestProof}`)
    .digest('hex')}`;
  const storage = quotaStorage({
    'narduh-user': JSON.stringify({ id: guestId, name: 'Guest4321', guest: true }),
    'narduh-guest-credential-v1': JSON.stringify({ version: 1, guestId, proof: guestProof }),
  }, 3000);
  const requests = [];
  const client = await loadClient(storage, {
    fetchImpl: async (input, init) => {
      requests.push({ input: String(input), init });
      return { ok: true };
    },
  });

  await client.options.global.fetch('https://example.supabase.co/rest/v1/rooms');
  await client.options.global.fetch('https://example.supabase.co/auth/v1/user');
  const restHeaders = requests[0].init.headers;
  const header = name => typeof restHeaders?.get === 'function'
    ? restHeaders.get(name)
    : restHeaders?.[name];
  assert.equal(header('X-Guest-Id'), guestId);
  assert.equal(header('X-Guest-Proof'), guestProof);
  const authHeaders = requests[1].init.headers || {};
  assert.equal(typeof authHeaders?.get === 'function' ? authHeaders.get('X-Guest-Proof') : authHeaders['X-Guest-Proof'], undefined);
});

test('Supabase transport aborts a stalled request at its deadline', async () => {
  const timers = new Map();
  let nextTimerId = 0;
  let fetchCalls = 0;
  let forwardedSignal = null;
  const client = await loadClient(quotaStorage(), {
    fetchImpl: async (_input, init) => {
      fetchCalls += 1;
      forwardedSignal = init.signal;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    setTimeoutImpl(handler, delay) {
      const id = ++nextTimerId;
      timers.set(id, { handler, delay });
      return id;
    },
    clearTimeoutImpl(id) {
      timers.delete(id);
    },
  });

  const pending = client.options.global.fetch('https://example.supabase.co/rest/v1/profiles');
  assert.equal(timers.size, 1);
  const [{ handler, delay }] = timers.values();
  assert.equal(delay, 6000);
  handler();

  await assert.rejects(pending, error => {
    assert.equal(error.name, 'TimeoutError');
    assert.equal(error.code, 'SUPABASE_FETCH_TIMEOUT');
    return true;
  });
  assert.equal(forwardedSignal.aborted, true);
  assert.equal(fetchCalls, 1, 'the shared transport must never retry a request');
  assert.equal(timers.size, 0);
});

test('Supabase transport keeps its deadline through a stalled response body', async () => {
  const timers = new Map();
  let nextTimerId = 0;
  let bodySignal = null;
  const client = await loadClient(quotaStorage(), {
    fetchImpl: async (_input, init) => ({
      ok: true,
      clone() {
        bodySignal = init.signal;
        return {
          arrayBuffer() {
            return new Promise((_, reject) => {
              init.signal.addEventListener('abort', () => {
                const error = new Error('body aborted');
                error.name = 'AbortError';
                reject(error);
              }, { once: true });
            });
          },
        };
      },
    }),
    setTimeoutImpl(handler, delay) {
      const id = ++nextTimerId;
      timers.set(id, { handler, delay });
      return id;
    },
    clearTimeoutImpl(id) {
      timers.delete(id);
    },
  });

  const pending = client.options.global.fetch('https://example.supabase.co/rest/v1/profiles');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 1);
  const [{ handler, delay }] = timers.values();
  assert.equal(delay, 6000);
  assert.equal(bodySignal.aborted, false);
  handler();

  await assert.rejects(pending, error => {
    assert.equal(error.name, 'TimeoutError');
    assert.equal(error.code, 'SUPABASE_FETCH_TIMEOUT');
    return true;
  });
  assert.equal(bodySignal.aborted, true);
  assert.equal(timers.size, 0);
});

test('Supabase transport forwards an external abort without classifying it as a timeout', async () => {
  const timers = new Map();
  let nextTimerId = 0;
  let forwardedSignal = null;
  const client = await loadClient(quotaStorage(), {
    fetchImpl: async (_input, init) => {
      forwardedSignal = init.signal;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('caller cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    setTimeoutImpl(handler, delay) {
      const id = ++nextTimerId;
      timers.set(id, { handler, delay });
      return id;
    },
    clearTimeoutImpl(id) {
      timers.delete(id);
    },
  });
  const external = new AbortController();

  const pending = client.options.global.fetch(
    'https://example.supabase.co/rest/v1/profiles',
    { signal: external.signal },
  );
  assert.notEqual(forwardedSignal, external.signal);
  const [{ handler: timeoutHandler }] = timers.values();
  external.abort();
  timeoutHandler();

  await assert.rejects(pending, error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, undefined);
    return true;
  });
  assert.equal(forwardedSignal.aborted, true);
  assert.equal(timers.size, 0);
});

test('Supabase transport streams a large non-auth response without a timer or body clone', async () => {
  let timerCalls = 0;
  let cloneCalls = 0;
  let forwardedSignal = null;
  const largeResponse = {
    ok: true,
    clone() {
      cloneCalls += 1;
      return { arrayBuffer: async () => new ArrayBuffer(8 * 1024 * 1024) };
    },
  };
  const client = await loadClient(quotaStorage(), {
    fetchImpl: async (_input, init) => {
      forwardedSignal = init.signal;
      return largeResponse;
    },
    setTimeoutImpl() {
      timerCalls += 1;
      return timerCalls;
    },
    clearTimeoutImpl() {},
  });
  const external = new AbortController();

  const response = await client.options.global.fetch(
    'https://example.supabase.co/storage/v1/object/public/chat-audio/large-message.webm',
    { signal: external.signal },
  );

  assert.equal(response, largeResponse);
  assert.equal(forwardedSignal, external.signal);
  assert.equal(cloneCalls, 0);
  assert.equal(timerCalls, 0);
});
