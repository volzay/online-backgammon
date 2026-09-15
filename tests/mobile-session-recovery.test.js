const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const MOBILE_GUEST_PROOF = `gproof:${'51'.repeat(32)}`;
const MOBILE_GUEST_ID = `guest:sha256:${createHash('sha256')
  .update(`nardu/guest/v1:${MOBILE_GUEST_PROOF}`)
  .digest('hex')}`;

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function eventTarget(extra = {}) {
  const handlers = new Map();
  return {
    ...extra,
    addEventListener(name, handler) {
      const current = handlers.get(name) || [];
      current.push(handler);
      handlers.set(name, current);
    },
    removeEventListener(name, handler) {
      handlers.set(name, (handlers.get(name) || []).filter(item => item !== handler));
    },
    dispatch(name, event = {}) {
      (handlers.get(name) || []).forEach(handler => handler(event));
    },
  };
}

test('returning a frozen mobile page to the foreground forces profile presence', async () => {
  let nowMs = 2_000_000;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  }
  const localStorage = memoryStorage({
    'narduh-user': JSON.stringify({
      id: 'player-1',
      name: 'ВащеППЦ',
      nickname: 'ВащеППЦ',
      guest: false,
      rating: 1225,
    }),
  });
  let profileUpdates = 0;
  const profileQuery = {
    update() {
      profileUpdates += 1;
      return profileQuery;
    },
    or() { return profileQuery; },
    eq() {
      return Promise.resolve({ error: null });
    },
  };
  const document = eventTarget({
    readyState: 'loading',
    visibilityState: 'visible',
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const window = eventTarget({
    dispatchEvent() {},
    NarduSupabase: {
      configured: () => true,
      client: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: 'player-1' } }, error: null }) },
        from: table => {
          assert.equal(table, 'profiles');
          return profileQuery;
        },
      }),
    },
  });
  window.window = window;
  const context = {
    window,
    document,
    localStorage,
    sessionStorage: memoryStorage(),
    location: { href: '', search: '', hash: '' },
    console,
    Date: TestDate,
    Math,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    CustomEvent: class {},
  };
  context.globalThis = window;
  vm.createContext(context);
  vm.runInContext(read('app.js'), context, { filename: 'app.js' });

  document.dispatch('DOMContentLoaded');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(profileUpdates, 1);

  window.dispatch('focus');
  window.dispatch('pageshow', { persisted: true });
  window.dispatch('online');
  document.dispatch('visibilitychange');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(profileUpdates, 1, 'a foreground event burst should be coalesced');

  nowMs += 1001;
  window.dispatch('pageshow', { persisted: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(profileUpdates, 2, 'a later foreground return must bypass the 30-second timer throttle');
});

test('a timed-out profile heartbeat is retried while the mobile page stays visible', async () => {
  const localStorage = memoryStorage({
    'narduh-user': JSON.stringify({ id: 'player-1', name: 'ВащеППЦ', guest: false }),
  });
  let getUserCalls = 0;
  let profileUpdates = 0;
  const profileQuery = {
    update() { profileUpdates += 1; return profileQuery; },
    or() { return profileQuery; },
    eq() { return Promise.resolve({ error: null }); },
  };
  const client = {
    auth: {
      getUser() {
        getUserCalls += 1;
        if (getUserCalls === 1) return new Promise(() => {});
        return Promise.resolve({ data: { user: { id: 'player-1' } }, error: null });
      },
    },
    from() { return profileQuery; },
  };
  const document = eventTarget({
    readyState: 'loading',
    visibilityState: 'visible',
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const window = eventTarget({
    dispatchEvent() {},
    NarduSupabase: {
      configured: () => true,
      client: async () => client,
    },
  });
  window.window = window;
  const context = {
    window,
    document,
    localStorage,
    sessionStorage: memoryStorage(),
    location: { href: '', search: '', hash: '' },
    console,
    Date,
    Math,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    CustomEvent: class {},
  };
  context.globalThis = window;
  vm.createContext(context);
  vm.runInContext(
    read('app.js').replace(
      'const PROFILE_PRESENCE_ATTEMPT_TIMEOUT_MS = 10000;',
      'const PROFILE_PRESENCE_ATTEMPT_TIMEOUT_MS = 10;',
    ),
    context,
    { filename: 'app.js' },
  );

  document.dispatch('DOMContentLoaded');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(getUserCalls, 1);
  assert.equal(await window.NarduApp.touchProfilePresence({ force: true }), true);
  assert.equal(getUserCalls, 2);
  assert.equal(profileUpdates, 1);
});

test('profile presence refreshes an expired auth session once and retries the canonical heartbeat', async () => {
  const localStorage = memoryStorage({
    'narduh-user': JSON.stringify({ id: 'player-1', name: 'ВащеППЦ', guest: false }),
  });
  let getUserCalls = 0;
  let refreshCalls = 0;
  let profileUpdates = 0;
  const profileQuery = {
    update() { profileUpdates += 1; return profileQuery; },
    or() { return profileQuery; },
    eq() { return Promise.resolve({ error: null }); },
  };
  const document = eventTarget({
    readyState: 'loading',
    visibilityState: 'visible',
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'player-1' } } }, error: null }),
      getUser: async () => {
        getUserCalls += 1;
        if (getUserCalls === 1) return { data: { user: null }, error: new Error('JWT expired') };
        return { data: { user: { id: 'player-1' } }, error: null };
      },
      refreshSession: async () => {
        refreshCalls += 1;
        return { data: { session: { user: { id: 'player-1' } } }, error: null };
      },
    },
    from(table) {
      assert.equal(table, 'profiles');
      return profileQuery;
    },
  };
  const window = eventTarget({
    dispatchEvent() {},
    NarduSupabase: { configured: () => true, client: async () => client },
  });
  window.window = window;
  const context = {
    window,
    document,
    localStorage,
    sessionStorage: memoryStorage(),
    location: { href: '', search: '', hash: '' },
    console,
    Date,
    Math,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    CustomEvent: class {},
  };
  context.globalThis = window;
  vm.createContext(context);
  vm.runInContext(read('app.js'), context, { filename: 'app.js' });

  assert.equal(await window.NarduApp.touchProfilePresence({ force: true }), true);
  assert.equal(getUserCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(profileUpdates, 1);
});

test('an older profile heartbeat cannot overwrite a newer foreground timestamp', async () => {
  let nowMs = 1_000;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  }
  const localStorage = memoryStorage({
    'narduh-user': JSON.stringify({ id: 'player-1', name: 'ВащеППЦ', guest: false }),
  });
  let storedLastSeen = null;
  let updateCalls = 0;
  let releaseOldUpdate;
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: 'player-1' } }, error: null }),
    },
    from(table) {
      assert.equal(table, 'profiles');
      return {
        update(payload) {
          const timestamp = payload.last_seen_at;
          return {
            or(filter) {
              assert.match(filter, /last_seen_at\.is\.null,last_seen_at\.lt\./);
              return this;
            },
            eq() {
              updateCalls += 1;
              const apply = () => {
                if (!storedLastSeen || storedLastSeen < timestamp) storedLastSeen = timestamp;
                return { error: null };
              };
              if (updateCalls === 1) {
                return new Promise(resolve => {
                  releaseOldUpdate = () => resolve(apply());
                });
              }
              return Promise.resolve(apply());
            },
          };
        },
      };
    },
  };
  const document = eventTarget({
    readyState: 'loading',
    visibilityState: 'visible',
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const window = eventTarget({
    dispatchEvent() {},
    NarduSupabase: { configured: () => true, client: async () => client },
  });
  window.window = window;
  const context = {
    window,
    document,
    localStorage,
    sessionStorage: memoryStorage(),
    location: { href: '', search: '', hash: '' },
    console,
    Date: TestDate,
    Math,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    CustomEvent: class {},
  };
  context.globalThis = window;
  vm.createContext(context);
  vm.runInContext(read('app.js'), context, { filename: 'app.js' });

  const oldHeartbeat = window.NarduApp.touchProfilePresence({ force: true });
  nowMs = 12_000;
  assert.equal(await window.NarduApp.touchProfilePresence({ force: true }), true);
  const newestTimestamp = new TestDate(12_000).toISOString();
  assert.equal(storedLastSeen, newestTimestamp);
  nowMs = 13_000;
  releaseOldUpdate();
  assert.equal(await oldHeartbeat, true);
  assert.equal(storedLastSeen, newestTimestamp);
});

test('a resumed guest heartbeat cannot roll presence back to its suspended timestamp', async () => {
  let nowMs = 1_000;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  }
  const localStorage = memoryStorage({
    'narduh-user': JSON.stringify({ id: MOBILE_GUEST_ID, name: 'Mobile guest', guest: true }),
    'narduh-guest-credential-v1': JSON.stringify({
      version: 1,
      guestId: MOBILE_GUEST_ID,
      proof: MOBILE_GUEST_PROOF,
    }),
  });
  let releaseFirstInsert;
  const firstInsert = new Promise(resolve => { releaseFirstInsert = resolve; });
  let insertCalls = 0;
  const updateTimes = [];
  const client = {
    from(table) {
      assert.equal(table, 'guest_presence');
      return {
        insert() {
          insertCalls += 1;
          if (insertCalls === 1) return firstInsert;
          return Promise.resolve({ error: { code: '23505' } });
        },
        update(payload) {
          updateTimes.push(payload.last_seen_at);
          return {
            eq: async () => ({ error: null }),
          };
        },
      };
    },
  };
  const document = eventTarget({
    readyState: 'loading',
    visibilityState: 'visible',
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const window = eventTarget({
    dispatchEvent() {},
    NarduSupabase: { configured: () => true, client: async () => client },
  });
  window.window = window;
  const context = {
    window,
    document,
    localStorage,
    sessionStorage: memoryStorage(),
    location: { href: '', search: '', hash: '' },
    console,
    Date: TestDate,
    Math,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    CustomEvent: class {},
  };
  context.globalThis = window;
  vm.createContext(context);
  vm.runInContext(read('app.js'), context, { filename: 'app.js' });

  const suspended = window.NarduApp.touchGuestPresence({ force: true });
  nowMs = 2_000;
  assert.equal(await window.NarduApp.touchGuestPresence({ force: true }), true);
  nowMs = 3_000;
  releaseFirstInsert({ error: { code: '23505' } });
  assert.equal(await suspended, true);
  assert.deepEqual(updateTimes, [
    new TestDate(2_000).toISOString(),
    new TestDate(3_000).toISOString(),
  ]);
});

test('a guest alias does not hide a failed canonical profile heartbeat or suppress its retry', async () => {
  const localStorage = memoryStorage({
    'narduh-user': JSON.stringify({ id: 'player-1', name: 'ВащеППЦ', guest: false }),
  });
  let getUserCalls = 0;
  let refreshCalls = 0;
  let aliasInserts = 0;
  const document = eventTarget({
    readyState: 'loading',
    visibilityState: 'visible',
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => {
        getUserCalls += 1;
        return { data: { user: null }, error: new Error('Network request failed') };
      },
      refreshSession: async () => {
        refreshCalls += 1;
        return { data: { session: null }, error: null };
      },
    },
    from(table) {
      assert.equal(table, 'guest_presence');
      return {
        insert() {
          aliasInserts += 1;
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const window = eventTarget({
    dispatchEvent() {},
    NarduSupabase: { configured: () => true, client: async () => client },
  });
  window.window = window;
  const context = {
    window,
    document,
    localStorage,
    sessionStorage: memoryStorage(),
    location: { href: '', search: '', hash: '' },
    console,
    Date,
    Math,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    CustomEvent: class {},
  };
  context.globalThis = window;
  vm.createContext(context);
  vm.runInContext(read('app.js'), context, { filename: 'app.js' });

  assert.equal(await window.NarduApp.touchProfilePresence({ force: true }), false);
  assert.equal(await window.NarduApp.touchProfilePresence(), false);
  assert.equal(getUserCalls, 2, 'failed canonical presence must remain immediately retryable');
  assert.equal(refreshCalls, 0, 'ordinary network errors must not rotate refresh tokens');
  assert.equal(aliasInserts, 2);
});

test('a stalled Supabase CDN load times out and the next client call retries', async () => {
  const scripts = [];
  const document = {
    querySelector() { return null; },
    createElement() {
      const script = eventTarget({
        src: '',
        async: false,
        remove() {
          const index = scripts.indexOf(script);
          if (index >= 0) scripts.splice(index, 1);
        },
      });
      return script;
    },
    head: {
      appendChild(script) { scripts.push(script); },
    },
  };
  let timeoutId = 0;
  const context = {
    window: {
      NARDU_ENV: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon' },
    },
    document,
    localStorage: memoryStorage(),
    console,
    Set,
    Promise,
    setTimeout(handler) {
      const id = ++timeoutId;
      queueMicrotask(handler);
      return id;
    },
    clearTimeout() {},
  };
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(read('supabase-client.js'), context, { filename: 'supabase-client.js' });

  await assert.rejects(context.window.NarduSupabase.client(), /Не удалось загрузить Supabase SDK/);
  assert.equal(timeoutId, 2, 'both CDN candidates should receive a bounded attempt');

  await assert.rejects(context.window.NarduSupabase.client(), /Не удалось загрузить Supabase SDK/);
  assert.equal(timeoutId, 4, 'a rejected singleton promise must not poison later retries');
});

test('a stalled primary CDN falls back to a working secondary CDN', async () => {
  const timers = new Map();
  const scripts = [];
  let timerId = 0;
  let context;
  const document = {
    querySelector() { return null; },
    createElement() {
      const script = eventTarget({
        src: '',
        async: false,
        remove() {
          const index = scripts.indexOf(script);
          if (index >= 0) scripts.splice(index, 1);
        },
      });
      return script;
    },
    head: {
      appendChild(script) {
        scripts.push(script);
        if (!script.src.includes('unpkg.com')) return;
        context.window.supabase = {
          createClient(url, key) { return { url, key }; },
        };
        queueMicrotask(() => script.dispatch('load'));
      },
    },
  };
  context = {
    window: {
      NARDU_ENV: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon' },
    },
    document,
    localStorage: memoryStorage(),
    console,
    Set,
    Promise,
    setTimeout(handler) {
      const id = ++timerId;
      timers.set(id, handler);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(read('supabase-client.js'), context, { filename: 'supabase-client.js' });

  const clientPromise = context.window.NarduSupabase.client();
  assert.equal(scripts.length, 1);
  timers.get(1)();
  await new Promise(resolve => setImmediate(resolve));

  const client = await clientPromise;
  assert.equal(client.url, 'https://example.supabase.co');
  assert.equal(timerId, 2);
  assert.equal(scripts[0].src, 'https://unpkg.com/@supabase/supabase-js@2');
});

test('a settled lobby cleanup failure is retried instead of poisoning later actions', async () => {
  const lobby = read('index.html');
  const start = lobby.indexOf('let lobbyCleanupPromise;');
  const end = lobby.indexOf('setInterval(refreshPlayerRooms, 2500);', start);
  assert.ok(start >= 0 && end > start);
  const lifecycle = lobby.slice(start, end);
  let attempts = 0;
  let refreshCalls = 0;
  const firstRefresh = new Promise(() => {});
  const context = {
    closeOwnRoomsOnLobbyEntry: async () => ({
      ok: ++attempts > 1,
      closedCodes: attempts === 1 ? ['OLD-ROOM'] : [],
    }),
    refreshPlayerRooms: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) await firstRefresh;
    },
    window: { addEventListener() {} },
    playerRooms: [{ code: 'OLD-ROOM' }, { code: 'OPEN-ROOM' }],
    renderTables() {},
    LOBBY_ROOM_REFRESH_TIMEOUT_MS: 10,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(`${lifecycle}\n;globalThis.testEnsureCleanup = ensureLobbyCleanup; globalThis.testCleanup = () => lobbyCleanupPromise; globalThis.testRooms = () => playerRooms;`, context);

  const initialCleanup = context.testCleanup();
  let cleanupSettled = false;
  initialCleanup.then(() => { cleanupSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanupSettled, false, 'lobby actions must wait for the post-cleanup room refresh');
  assert.equal((await initialCleanup).ok, false);
  assert.deepEqual(Array.from(context.testRooms(), room => room.code), ['OPEN-ROOM']);
  assert.equal((await context.testEnsureCleanup()).ok, true);
  assert.equal(attempts, 2);
  assert.equal(refreshCalls, 2);
});

test('a late lobby response cannot replace a newer room list', async () => {
  const lobby = read('index.html');
  const start = lobby.indexOf('async function refreshPlayerRooms()');
  const end = lobby.indexOf('function storedRoomCodes()', start);
  assert.ok(start >= 0 && end > start);
  const refreshFunction = lobby.slice(start, end);
  let releaseOldRefresh;
  const oldRefresh = new Promise(resolve => { releaseOldRefresh = resolve; });
  let requests = 0;
  const context = {
    document: {
      activeElement: null,
    },
    NarduRooms: {
      listRooms() {
        requests += 1;
        if (requests === 1) return oldRefresh;
        return Promise.resolve({ rooms: [{ code: 'NEW-ROOM' }] });
      },
      getActiveRoom() {
        return Promise.resolve({ room: null });
      },
    },
    redirectForRoomAuthError: () => false,
    renderTables() {},
  };
  vm.createContext(context);
  vm.runInContext(`
    let playerRooms = [];
    let roomsLoaded = false;
    let roomsLoadFailed = false;
    let roomsRefreshGeneration = 0;
    ${refreshFunction}
    globalThis.testRefresh = refreshPlayerRooms;
    globalThis.testRooms = () => playerRooms;
  `, context);

  const first = context.testRefresh();
  await context.testRefresh();
  releaseOldRefresh({ rooms: [{ code: 'OLD-ROOM' }] });
  await first;
  assert.deepEqual(Array.from(context.testRooms(), room => room.code), ['NEW-ROOM']);
});

test('BFCache restoration invalidates stale create actions without duplicating an in-flight join', () => {
  const lobby = read('index.html');
  const start = lobby.indexOf('let lobbyActionGeneration = 0;');
  const end = lobby.indexOf('function syncCreatePanel()', start);
  assert.ok(start >= 0 && end > start);
  const lifecycle = lobby.slice(start, end);
  const window = eventTarget();
  let ariaBusyRemoved = false;
  const context = {
    window,
    createSubmit: { disabled: true },
    createGameForm: { removeAttribute() { ariaBusyRemoved = true; } },
  };
  vm.createContext(context);
  vm.runInContext(`
    let joinRequestPending = false;
    ${lifecycle}
    globalThis.testBeginAction = beginLobbyAction;
    globalThis.testCurrentAction = isLobbyActionCurrent;
    globalThis.testSetPending = () => {
      createRequestPending = true;
      joinRequestPending = true;
    };
    globalThis.testPending = () => ({ createRequestPending, joinRequestPending });
  `, context);

  const staleGeneration = context.testBeginAction();
  context.testSetPending();
  window.dispatch('pageshow', { persisted: true });
  assert.equal(context.testCurrentAction(staleGeneration), false);
  assert.deepEqual({ ...context.testPending() }, {
    createRequestPending: false,
    joinRequestPending: true,
  });
  assert.equal(context.createSubmit.disabled, false);
  assert.equal(ariaBusyRemoved, true);
  assert.match(lobby, /const actionGeneration = beginLobbyAction\(\);[\s\S]*await ensureLobbyCleanup\(\);[\s\S]*if \(!isLobbyActionCurrent\(actionGeneration\)\) return;/);
  assert.match(lobby, /await NarduRooms\.createRoom\([\s\S]*if \(!isLobbyActionCurrent\(actionGeneration\)\) \{[\s\S]*cleanupStaleCreatedRoom\(data\.room\)/);
  assert.doesNotMatch(lifecycle, /joinRequestPending = false/);
});

test('a timed-out join reconciles a committed room and remains single-flight', async () => {
  const lobby = read('index.html');
  const start = lobby.indexOf('function lobbyJoinTimeoutError()');
  const end = lobby.indexOf("joinCodeForm.addEventListener('submit'", start);
  assert.ok(start >= 0 && end > start);
  const joinLifecycle = lobby.slice(start, end);
  let joinCalls = 0;
  let getRoomCalls = 0;
  let joinAbortSeen = false;
  let lookupSignalSeen = false;
  let openedRoom = null;
  const committedRoom = {
    code: 'JOIN-ROOM',
    status: 'joined',
    hostName: 'Host',
    guestName: 'Mobile player',
    variant: 'long',
  };
  const context = {
    NarduRooms: {
      joinRoom(code, payload, options) {
        joinCalls += 1;
        assert.equal(code, 'JOIN-ROOM');
        assert.equal(payload.guestName, 'Mobile player');
        assert.ok(options.signal);
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            joinAbortSeen = true;
            const error = new Error('response was lost after commit');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
      getRoom(code, options) {
        getRoomCalls += 1;
        assert.equal(code, 'JOIN-ROOM');
        lookupSignalSeen = Boolean(options.signal);
        return Promise.resolve({ room: committedRoom });
      },
    },
    ensureLobbyCleanup: async () => ({ ok: true }),
    userName: () => 'Mobile player',
    userRating: () => 1200,
    userId: () => 'player-1',
    userRatingEligible: () => true,
    isRoomParticipant: room => room.guestName === 'Mobile player',
    goToExistingPlayerRoom(room) { openedRoom = room; },
    redirectForRoomAuthError: () => false,
    refreshPlayerRooms: async () => {},
    tt: key => key,
    setTimeout,
    clearTimeout,
    AbortController,
    Promise,
    Error,
  };
  vm.createContext(context);
  vm.runInContext(`
    const LOBBY_JOIN_TIMEOUT_MS = 5;
    const LOBBY_JOIN_RECONCILE_TIMEOUT_MS = 20;
    const LOBBY_JOIN_RECONCILE_POLL_MS = 1;
    let joinRequestPending = false;
    let createRequestPending = false;
    ${joinLifecycle}
    globalThis.testJoin = joinPlayerRoom;
    globalThis.testJoinPending = () => joinRequestPending;
  `, context);

  const firstJoin = context.testJoin('JOIN-ROOM', 'secret');
  await Promise.resolve();
  const duplicate = await context.testJoin('JOIN-ROOM', 'secret');
  assert.equal(duplicate.ok, false);
  assert.equal(joinCalls, 1, 'BFCache/user retries must not issue a second mutating join');

  const result = await firstJoin;
  assert.equal(result.ok, true);
  assert.equal(joinAbortSeen, true);
  assert.equal(getRoomCalls, 1);
  assert.equal(lookupSignalSeen, true);
  assert.equal(openedRoom, committedRoom);
  assert.equal(context.testJoinPending(), false);
});

test('join reconciliation catches a commit that lands during its grace window', async () => {
  const lobby = read('index.html');
  const start = lobby.indexOf('function lobbyJoinTimeoutError()');
  const end = lobby.indexOf("joinCodeForm.addEventListener('submit'", start);
  assert.ok(start >= 0 && end > start);
  const joinLifecycle = lobby.slice(start, end);
  let joinCalls = 0;
  let getRoomCalls = 0;
  let openedRoom = null;
  const committedRoom = {
    code: 'JOIN-ROOM',
    status: 'joined',
    hostName: 'Host',
    guestName: 'Mobile player',
    variant: 'long',
  };
  const context = {
    NarduRooms: {
      joinRoom(code, payload, options) {
        joinCalls += 1;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('join timeout');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
      getRoom() {
        getRoomCalls += 1;
        if (getRoomCalls === 1) {
          return Promise.resolve({
            room: { code: 'JOIN-ROOM', status: 'waiting', hostName: 'Host', guestName: '' },
          });
        }
        return Promise.resolve({ room: committedRoom });
      },
    },
    ensureLobbyCleanup: async () => ({ ok: true }),
    userName: () => 'Mobile player',
    userRating: () => 1200,
    userId: () => 'player-1',
    userRatingEligible: () => true,
    isRoomParticipant: room => room.guestName === 'Mobile player',
    goToExistingPlayerRoom(room) { openedRoom = room; },
    redirectForRoomAuthError: () => false,
    refreshPlayerRooms: async () => {},
    tt: key => key,
    setTimeout,
    clearTimeout,
    AbortController,
    Promise,
    Error,
    Date,
    Math,
  };
  vm.createContext(context);
  vm.runInContext(`
    const LOBBY_JOIN_TIMEOUT_MS = 5;
    const LOBBY_JOIN_RECONCILE_TIMEOUT_MS = 30;
    const LOBBY_JOIN_RECONCILE_POLL_MS = 1;
    let joinRequestPending = false;
    let createRequestPending = false;
    ${joinLifecycle}
    globalThis.testJoin = joinPlayerRoom;
  `, context);

  const result = await context.testJoin('JOIN-ROOM', 'secret');
  assert.equal(result.ok, true);
  assert.equal(joinCalls, 1, 'reconciliation must never repeat the mutating join');
  assert.equal(getRoomCalls, 2);
  assert.equal(openedRoom, committedRoom);
});

test('a timed-out uncommitted join and its reconciliation both release the lobby', async () => {
  const lobby = read('index.html');
  const start = lobby.indexOf('function lobbyJoinTimeoutError()');
  const end = lobby.indexOf("joinCodeForm.addEventListener('submit'", start);
  assert.ok(start >= 0 && end > start);
  const joinLifecycle = lobby.slice(start, end);
  let joinCalls = 0;
  let lookupAbortSeen = false;
  let refreshCalls = 0;
  const context = {
    NarduRooms: {
      joinRoom(code, payload, options) {
        joinCalls += 1;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('join timeout');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
      getRoom(code, options) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            lookupAbortSeen = true;
            const error = new Error('lookup timeout');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    },
    ensureLobbyCleanup: async () => ({ ok: true }),
    userName: () => 'Mobile player',
    userRating: () => 1200,
    userId: () => 'player-1',
    userRatingEligible: () => true,
    isRoomParticipant: () => false,
    goToExistingPlayerRoom() { throw new Error('uncommitted room must not open'); },
    redirectForRoomAuthError: () => false,
    refreshPlayerRooms() {
      refreshCalls += 1;
      return new Promise(() => {});
    },
    tt: key => key,
    setTimeout,
    clearTimeout,
    AbortController,
    Promise,
    Error,
  };
  vm.createContext(context);
  vm.runInContext(`
    const LOBBY_JOIN_TIMEOUT_MS = 5;
    const LOBBY_JOIN_RECONCILE_TIMEOUT_MS = 5;
    const LOBBY_JOIN_RECONCILE_POLL_MS = 1;
    let joinRequestPending = false;
    let createRequestPending = false;
    ${joinLifecycle}
    globalThis.testJoin = joinPlayerRoom;
    globalThis.testJoinPending = () => joinRequestPending;
  `, context);

  const result = await context.testJoin('JOIN-ROOM', 'secret');
  assert.equal(result.ok, false);
  assert.equal(result.message, 'err_session');
  assert.equal(joinCalls, 1);
  assert.equal(lookupAbortSeen, true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(refreshCalls, 1);
  assert.equal(context.testJoinPending(), false, 'a dead join and dead lookup must not poison later lobby actions');
});

test('a regular join failure releases the lobby without waiting for room refresh', async () => {
  const lobby = read('index.html');
  const start = lobby.indexOf('function lobbyJoinTimeoutError()');
  const end = lobby.indexOf("joinCodeForm.addEventListener('submit'", start);
  assert.ok(start >= 0 && end > start);
  const joinLifecycle = lobby.slice(start, end);
  let refreshCalls = 0;
  const context = {
    NarduRooms: {
      joinRoom: async () => { throw new Error('join failed'); },
      getRoom() { throw new Error('reconciliation must not run for a regular failure'); },
    },
    ensureLobbyCleanup: async () => ({ ok: true }),
    userName: () => 'Mobile player',
    userRating: () => 1200,
    userId: () => 'player-1',
    userRatingEligible: () => true,
    isRoomParticipant: () => false,
    goToExistingPlayerRoom() { throw new Error('failed room must not open'); },
    redirectForRoomAuthError: () => false,
    refreshPlayerRooms() {
      refreshCalls += 1;
      return new Promise(() => {});
    },
    tt: key => key,
    setTimeout,
    clearTimeout,
    AbortController,
    Promise,
    Error,
  };
  vm.createContext(context);
  vm.runInContext(`
    const LOBBY_JOIN_TIMEOUT_MS = 20;
    const LOBBY_JOIN_RECONCILE_TIMEOUT_MS = 5;
    const LOBBY_JOIN_RECONCILE_POLL_MS = 1;
    let joinRequestPending = false;
    let createRequestPending = false;
    ${joinLifecycle}
    globalThis.testJoin = joinPlayerRoom;
    globalThis.testJoinPending = () => joinRequestPending;
  `, context);

  const result = await context.testJoin('JOIN-ROOM', 'secret');
  assert.equal(result.ok, false);
  assert.equal(result.message, 'join failed');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(refreshCalls, 1);
  assert.equal(context.testJoinPending(), false);
});

test('the room heartbeat reports its own watchdog timeout but ignores lifecycle cancellation', async () => {
  const room = read('room.html');
  const start = room.indexOf('async function sendPresenceHeartbeat()');
  const end = room.indexOf('function startPresenceProtocol()', start);
  assert.ok(start >= 0 && end > start);
  const heartbeatLifecycle = room.slice(start, end);
  const networkPanels = [];
  const context = {
    window: { NarduController: { getState: () => ({ phase: 'move' }) } },
    NarduRooms: {
      updatePresence(code, payload, options) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('watchdog timeout');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    },
    NarduApp: { getUser: () => ({ name: 'Mobile player' }) },
    isActiveRemoteRoom: () => true,
    handlePresence() {},
    showNetworkPanel(data) { networkPanels.push(data); },
    t: key => key,
    setTimeout,
    clearTimeout,
    AbortController,
    networkPanels,
  };
  vm.createContext(context);
  vm.runInContext(`
    let presenceBusy = false;
    let presenceRequestId = 0;
    let presenceAbortController = null;
    let presenceAbortTimer = null;
    const ROOM_HEARTBEAT_REQUEST_STALE_MS = 5;
    const roomCode = 'ROOM-CODE';
    const localPlayerColor = 'white';
    ${heartbeatLifecycle}
    globalThis.testHeartbeat = sendPresenceHeartbeat;
    globalThis.testCancelHeartbeat = cancelPresenceHeartbeatRequest;
  `, context);

  await context.testHeartbeat();
  assert.equal(networkPanels.length, 1);
  assert.equal(networkPanels[0].text, 'server_unreachable_text');

  const cancelled = context.testHeartbeat();
  context.testCancelHeartbeat();
  await cancelled;
  assert.equal(networkPanels.length, 1, 'foreground/pagehide cancellation must stay silent');
});

test('bot startup is guarded by the server room while room presence remains resumable', () => {
  const lobby = read('index.html');
  const room = read('room.html');
  const controller = read('game-controller.js');
  const roomsClient = read('rooms-client.js');
  const botBranch = lobby.indexOf("if (createState.opponent === 'bot')");
  const botCleanup = lobby.indexOf('const cleanup = await ensureLobbyCleanup();', botBranch);
  const activeRoomGuard = lobby.indexOf('const activeRoom = await loadActiveRoomWithTimeout();', botCleanup);
  const botNavigation = lobby.indexOf('const gameCode = createLocalGameCode();', activeRoomGuard);

  assert.ok(botBranch >= 0 && botCleanup > botBranch);
  assert.ok(activeRoomGuard > botCleanup && botNavigation > activeRoomGuard, 'bot navigation must wait for the server active-room guard');
  assert.match(lobby, /async function ensureLobbyCleanup\(\)[\s\S]*if \(cleanup\?\.ok \|\| cleanup\?\.redirected\) return cleanup;[\s\S]*return runLobbyCleanup\(\);/);
  assert.match(lobby, /LOBBY_CLEANUP_TIMEOUT_MS = 8000[\s\S]*Promise\.allSettled\(capturedCodes\.map\(code => NarduRooms\.closeWaitingRoom/);
  const cleanupCodes = lobby.match(/function cleanupRoomCodes\(\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.doesNotMatch(cleanupCodes, /ACTIVE_ROOM_KEY|CREATE_GAME_KEY/);
  assert.match(lobby, /const code = room\?\.code \|\| room\?\.game/);
  assert.match(lobby, /function resetLobbyPendingActions\(\)[\s\S]*createRequestPending = false;[\s\S]*createSubmit\.disabled = false/);
  assert.match(lobby, /pageshow[\s\S]*event\.persisted\) resetLobbyPendingActions\(\)/);
  assert.doesNotMatch(lobby, /lobbyCleanupPromise = closeOwnRoomsOnLobbyEntry\(\)\s*\.finally\(refreshPlayerRooms\)/);
  assert.match(roomsClient, /async function getActiveRoom\(options = \{\}\)/);
  assert.match(roomsClient, /async function closeWaitingRoom\(code, options = \{\}\)/);
  assert.match(roomsClient, /async function closeWaitingRoom[\s\S]*client\.rpc\("close_own_waiting_room", \{[\s\S]*p_room_code: normalizedCode/);
  assert.doesNotMatch(
    roomsClient.match(/async function closeWaitingRoom[\s\S]*?\n  async function closeBotRoom/)?.[0] || '',
    /\.from\("rooms"\)[\s\S]*status: "closed"/,
  );
  assert.match(controller, /LONG_BOT_EXPERIENCE_STARTUP_WAIT_MS =\s*LONG_BOT_EXPERIENCE_LOAD_TIMEOUT_MS \* LONG_BOT_EXPERIENCE_LOAD_ATTEMPTS \+ 500/);
  assert.doesNotMatch(controller, /BOT_ANALYSIS_STARTUP_WAIT_MS/);
  assert.match(controller, /BOT_ANALYSIS_RESTORE_TIMEOUT_MS = 12000/);
  assert.match(controller, /promiseWithTimeout\(\s*restoreBotAnalysisState[\s\S]*BOT_ANALYSIS_RESTORE_TIMEOUT_MS/);
  assert.match(controller, /error\?\.status === 404[\s\S]*ensureBotAnalysisRoomReady\(botAnalysisPayload\(\)\)/);
  assert.match(controller, /ensureAutoProgressAfterExperience\(\s*650,\s*LONG_BOT_EXPERIENCE_STARTUP_WAIT_MS/);
  assert.match(controller, /const loadExperience = loadLongBotExperienceBeforeStart\(\)/);
  assert.match(controller, /Promise\.race\(\[\s*loadExperience,[\s\S]*Number\(maxExperienceWaitMs\)/);
  assert.match(controller, /botAnalysisOwnershipUnknown = true/);
  assert.match(controller, /Promise\.resolve\(botPublishPromise\)\.then\(persisted => \{[\s\S]*!persisted \|\| botAnalysisOwnershipUnknown[\s\S]*recordRating\(\)/);
  assert.match(controller, /BOT_ANALYSIS_WRITE_TIMEOUT_MS = 5000/);
  assert.match(controller, /BOT_GAME_EXIT_WAIT_MS = 12500/);
  assert.match(room, /window\.addEventListener\('pageshow', resumeRoomPresence\)/);
  assert.match(room, /document\.addEventListener\('visibilitychange', resumeRoomPresence\)/);
  assert.match(room, /function resumeRoomPresence\(\)[\s\S]*startPresenceProtocol\(\)/);
  assert.match(room, /cancelPresenceHeartbeatRequest\(\)[\s\S]*presenceAbortController\?\.abort\(\)/);
  assert.match(room, /pagehide[\s\S]*lastRoomPresenceResumeAt = 0/);
  assert.match(roomsClient, /async function updatePresence\(code, payload = \{\}, options = \{\}\)[\s\S]*const \{ signal \} = options;[\s\S]*withAbortSignal\(loadQuery, signal\)/);
  assert.match(room, /catch \(error\) \{[\s\S]*startPresenceProtocol\(\);[\s\S]*startSpectatorProtocol\(\);/);
});
