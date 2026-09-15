const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function extractFunction(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const closingParen = source.indexOf(')', match.index + match[0].length);
  const openingBrace = source.indexOf('{', closingParen);
  assert.notEqual(openingBrace, -1, `function ${name} must have a body`);

  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`function ${name} body is incomplete`);
}

function createSupabaseHarness({ activeRows = [], closeResult = null, currentRoom = null } = {}) {
  const operations = [];

  function resultFor(operation) {
    if (operation.table === 'profiles') {
      if (operation.update) return { data: null, error: null };
      return {
        data: {
          id: 'user-1',
          nickname: 'Наблюдатель',
          email: 'observer@example.com',
          rating: 1390,
          rating_eligible: true,
        },
        error: null,
      };
    }
    if (operation.table === 'rooms' && operation.update) {
      return { data: closeResult, error: null };
    }
    if (operation.table === 'rooms' && operation.filters.some(filter => filter[1] === 'code')) {
      return { data: currentRoom, error: null };
    }
    if (operation.table === 'rooms') return { data: activeRows, error: null };
    return { data: null, error: null };
  }

  function from(table) {
    const operation = { table, filters: [] };
    operations.push(operation);
    const chain = {
      select(columns) { operation.select = columns; return chain; },
      update(values) { operation.update = values; return chain; },
      insert(values) { operation.insert = values; return chain; },
      eq(column, value) { operation.filters.push(['eq', column, value]); return chain; },
      neq(column, value) { operation.filters.push(['neq', column, value]); return chain; },
      is(column, value) { operation.filters.push(['is', column, value]); return chain; },
      in(column, value) { operation.filters.push(['in', column, value]); return chain; },
      or(value) { operation.filters.push(['or', 'expression', value]); return chain; },
      order(column, options) { operation.order = [column, options]; return chain; },
      limit(value) { operation.limit = value; return chain; },
      abortSignal(signal) { operation.signal = signal; return chain; },
      maybeSingle() { return Promise.resolve(resultFor(operation)); },
      single() { return Promise.resolve(resultFor(operation)); },
      then(resolve, reject) { return Promise.resolve(resultFor(operation)).then(resolve, reject); },
    };
    return chain;
  }

  const client = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: 'user-1' } } },
        error: null,
      }),
      refreshSession: async () => ({
        data: { session: { user: { id: 'user-1' } } },
        error: null,
      }),
      getUser: async () => ({
        data: {
          user: {
            id: 'user-1',
            email: 'observer@example.com',
            user_metadata: { nickname: 'Наблюдатель' },
          },
        },
        error: null,
      }),
      signOut: async () => ({ error: null }),
    },
    from,
  };
  return { client, operations };
}

function loadRoomsClient(client, localUser = null, options = {}) {
  const localStorage = options.localStorage || memoryStorage();
  const sessionStorage = options.sessionStorage || memoryStorage();
  const window = {
    NarduSupabase: {
      configured: () => options.configured !== false,
      client: async () => client,
    },
    NarduApp: {
      getUser: () => localUser || ({
        id: 'user-1',
        name: 'Наблюдатель',
        nickname: 'Наблюдатель',
        rating: 1390,
        ratingEligible: true,
        guest: false,
      }),
      guestRequestHeaders: () => {
        if (localUser?.guest !== true) return {};
        try {
          const credential = JSON.parse(localStorage.getItem('narduh-guest-credential-v1') || 'null');
          if (credential?.guestId !== localUser.id || !credential?.proof) return {};
          return { 'X-Guest-Id': credential.guestId, 'X-Guest-Proof': credential.proof };
        } catch {
          return {};
        }
      },
      shouldShowRatingToOthers: () => true,
      ratingTierFor: () => 'Silver',
    },
    crypto: globalThis.crypto,
    localStorage,
    sessionStorage,
  };
  window.window = window;
  const context = {
    window,
    localStorage,
    sessionStorage,
    console,
    Date,
    Map,
    Set,
    TextEncoder,
    Uint8Array,
    fetch: options.fetch || fetch,
    AbortController,
    DOMException,
  };
  context.globalThis = window;
  vm.createContext(context);
  vm.runInContext(read('rooms-client.js'), context, { filename: 'rooms-client.js' });
  return context.window.NarduRooms;
}

test('active-room lookup returns bot rooms and preserves participant IDs', async () => {
  const botRoom = {
    id: 'room-bot-1',
    code: 'EGXA-Z2PG',
    variant: 'long',
    access: 'open',
    status: 'joined',
    host_user_id: 'user-1',
    guest_user_id: 'bot-seat-1',
    host_name: 'Наблюдатель',
    guest_name: 'Бот сложный',
    host_rating: 1390,
    guest_rating: 1500,
    host_registered: true,
    guest_registered: false,
    allow_spectators: false,
    spectators: {},
    game_state: {
      mode: 'bot',
      analysis: {
        mode: 'bot',
        opponent: 'bot',
        difficulty: 'hard',
        playerColor: 'white',
      },
    },
    updated_at: '2026-09-14T20:00:00.000Z',
  };
  const { client, operations } = createSupabaseHarness({ activeRows: [botRoom] });
  const rooms = loadRoomsClient(client);

  const result = await rooms.getActiveRoom();

  assert.equal(result.room.code, 'EGXA-Z2PG');
  assert.equal(result.room.opponent, 'bot');
  assert.equal(result.room.botDifficulty, 'hard');
  assert.equal(result.room.hostUserId, 'user-1');
  assert.equal(result.room.guestUserId, 'bot-seat-1');
  const activeLookup = operations.find(operation => (
    operation.table === 'rooms'
    && operation.select === '*'
    && operation.filters.some(filter => filter[0] === 'or')
  ));
  assert.ok(activeLookup, 'the canonical active-room query must run');
  const statusFilter = activeLookup.filters.find(filter => filter[0] === 'in');
  assert.equal(statusFilter[1], 'status');
  assert.deepEqual(Array.from(statusFilter[2]), ['waiting', 'joined']);
});

test('a stable guest identity is included in the same active-room guard', async () => {
  const guestId = `guest:sha256:${'12'.repeat(32)}`;
  const activeRoom = {
    id: 'guest-room-1',
    code: 'GST1-R00M',
    variant: 'long',
    access: 'open',
    status: 'waiting',
    host_user_id: null,
    guest_user_id: null,
    host_guest_id: guestId,
    guest_guest_id: null,
    host_name: 'Guest4321',
    guest_name: null,
    host_registered: false,
    guest_registered: false,
    spectators: {},
  };
  const { client, operations } = createSupabaseHarness({ activeRows: [activeRoom] });
  const rooms = loadRoomsClient(client, {
    id: guestId,
    name: 'Guest4321',
    nickname: 'Guest4321',
    rating: null,
    ratingEligible: false,
    guest: true,
  });

  const found = await rooms.getActiveRoom();
  assert.equal(found.room.code, 'GST1-R00M');
  assert.equal(found.room.hostUserId, guestId);
  const guestLookup = operations.find(operation => (
    operation.table === 'rooms'
    && operation.filters.some(filter => filter[0] === 'or' && /host_guest_id/.test(filter[2]))
  ));
  assert.ok(guestLookup, 'guest room lookup must use the stable guest id');

  await assert.rejects(
    rooms.createRoom({ variant: 'long' }),
    error => error?.status === 409 && error?.data?.room?.code === 'GST1-R00M',
  );
  assert.equal(
    operations.filter(operation => operation.table === 'rooms' && operation.insert).length,
    0,
    'a guest with an active room must be rejected before INSERT',
  );
});

test('bot reservation never downgrades a registered user to anonymous', () => {
  const ensureBotRoom = extractFunction(read('rooms-client.js'), 'ensureBotAnalysisRoom');
  assert.doesNotMatch(ensureBotRoom, /allowLocalFallback/);
  assert.match(ensureBotRoom, /const identity = playerIdentity\(authUser\)/);
  assert.match(ensureBotRoom, /host_guest_id: guest \? identity\.guestId : null/);
});

test('a guest keeps the private bot owner proof across a complete browser restart', async () => {
  const guestProof = `gproof:${'12'.repeat(32)}`;
  const guest = {
    id: `guest:sha256:${createHash('sha256')
      .update(`nardu/guest/v1:${guestProof}`)
      .digest('hex')}`,
    name: 'Guest4321',
    nickname: 'Guest4321',
    rating: null,
    ratingEligible: false,
    guest: true,
  };
  const persistentStorage = memoryStorage({
    'narduh-guest-credential-v1': JSON.stringify({
      version: 1,
      guestId: guest.id,
      proof: guestProof,
    }),
  });
  const firstSession = memoryStorage();
  const creationRequests = [];
  const firstRooms = loadRoomsClient(null, guest, {
    configured: false,
    localStorage: persistentStorage,
    sessionStorage: firstSession,
    fetch: async (url, options = {}) => {
      creationRequests.push({ url, options });
      return {
        ok: true,
        async json() { return { ok: true, version: 0 }; },
      };
    },
  });

  const created = await firstRooms.ensureBotAnalysisRoom({
    code: 'BRTX-2233',
    variant: 'long',
    botName: 'Бот сложный',
    difficulty: 'hard',
    playerColor: 'white',
    state: { phase: 'opening', points: {} },
  });
  const originalToken = JSON.parse(creationRequests[0].options.body).ownerToken;
  assert.match(originalToken, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(created, 'ownerToken'), false, 'the private proof must not be exposed in a public result');

  const persistentKey = `narduh-bot-analysis-owner-v2:${guest.id}:BRTX-2233`;
  const persisted = JSON.parse(persistentStorage.getItem(persistentKey));
  assert.deepEqual({ ...persisted }, {
    version: 1,
    guestId: guest.id,
    token: originalToken,
  });

  const otherGuest = { ...guest, id: `guest:sha256:${'87'.repeat(32)}`, name: 'Guest9876' };
  const otherGuestRequests = [];
  const otherGuestRooms = loadRoomsClient(null, otherGuest, {
    configured: false,
    localStorage: persistentStorage,
    sessionStorage: memoryStorage(),
    fetch: async (url, options = {}) => {
      otherGuestRequests.push({ url, options });
      return {
        ok: true,
        async json() { return { state: { phase: 'moving' }, version: 4 }; },
      };
    },
  });
  await otherGuestRooms.getGameState('BRTX-2233');
  assert.notEqual(
    otherGuestRequests[0].options.headers['X-Bot-Owner'],
    originalToken,
    'another guest on the same browser cannot reuse the owner proof',
  );
  assert.equal(JSON.parse(persistentStorage.getItem(persistentKey)).token, originalToken);

  // A new VM and empty sessionStorage model a fully closed and reopened browser.
  const restartedSession = memoryStorage();
  const restartRequests = [];
  const restartedRooms = loadRoomsClient(null, guest, {
    configured: false,
    localStorage: persistentStorage,
    sessionStorage: restartedSession,
    fetch: async (url, options = {}) => {
      restartRequests.push({ url, options });
      const closed = options.method === 'DELETE';
      return {
        ok: true,
        async json() {
          return closed
            ? { ok: true, removed: true }
            : { state: { phase: 'moving' }, version: 4 };
        },
      };
    },
  });

  const restored = await restartedRooms.getGameState('BRTX-2233');
  assert.equal(restored.version, 4);
  assert.equal(restartRequests[0].options.headers['X-Bot-Owner'], originalToken);
  assert.equal(restartRequests[0].options.headers['X-Guest-Id'], guest.id);
  assert.doesNotMatch(restartRequests[0].url, new RegExp(originalToken), 'the proof must never enter the URL');
  assert.equal(
    restartedSession.getItem('narduh-bot-analysis-owner:BRTX-2233'),
    originalToken,
    'the restored proof remains compatible with existing sessionStorage readers',
  );

  const closed = await restartedRooms.closeBotRoom('BRTX-2233');
  assert.equal(closed.removed, true);
  assert.equal(restartRequests[1].options.headers['X-Bot-Owner'], originalToken);
  assert.equal(restartRequests[1].options.headers['X-Guest-Id'], guest.id);
  assert.equal(persistentStorage.getItem(persistentKey), null, 'closing the room erases its durable proof');
  assert.equal(restartedSession.getItem('narduh-bot-analysis-owner:BRTX-2233'), null);
});

test('closeWaitingRoom closes only the exact waiting room owned by the caller and propagates AbortSignal', async () => {
  const { client, operations } = createSupabaseHarness({ closeResult: { code: '2CKX-5HW7' } });
  const rooms = loadRoomsClient(client);
  const controller = new AbortController();

  const result = await rooms.closeWaitingRoom('2ckx5hw7', { signal: controller.signal });

  assert.deepEqual({ ...result }, {
    ok: true,
    removed: true,
    closed: true,
    code: '2CKX-5HW7',
  });
  const close = operations.find(operation => operation.table === 'rooms' && operation.update);
  assert.ok(close, 'an exact room update must be issued');
  assert.equal(close.update.status, 'closed');
  assert.equal(close.update.closed_reason, 'waiting_host_exit');
  assert.deepEqual(new Set(close.filters.map(filter => JSON.stringify(filter))), new Set([
    ['eq', 'code', '2CKX-5HW7'],
    ['eq', 'host_user_id', 'user-1'],
    ['eq', 'status', 'waiting'],
    ['is', 'guest_user_id', null],
    ['is', 'guest_guest_id', null],
  ].map(filter => JSON.stringify(filter))));
  assert.equal(close.signal, controller.signal);

  const updateCount = operations.filter(operation => operation.table === 'rooms' && operation.update).length;
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    rooms.closeWaitingRoom('ABCD-EFGH', { signal: aborted.signal }),
    error => error?.name === 'AbortError',
  );
  assert.equal(
    operations.filter(operation => operation.table === 'rooms' && operation.update).length,
    updateCount,
    'an already-aborted close must not issue a mutation',
  );
});

test('closing a bot room invalidates the exact game version held by stale tabs', async () => {
  const currentRoom = {
    id: 'room-bot-close-1',
    code: 'BOTC-LOSE',
    variant: 'long',
    access: 'open',
    status: 'joined',
    host_user_id: 'user-1',
    guest_user_id: null,
    host_guest_id: null,
    guest_guest_id: null,
    host_name: 'Наблюдатель',
    guest_name: 'Бот сложный',
    host_registered: true,
    guest_registered: false,
    game_version: 12,
    game_state: {
      mode: 'bot',
      analysis: { mode: 'bot', opponent: 'bot', difficulty: 'hard' },
    },
  };
  const { client, operations } = createSupabaseHarness({
    currentRoom,
    closeResult: { code: 'BOTC-LOSE' },
  });
  const rooms = loadRoomsClient(client);

  const result = await rooms.closeBotRoom('botclose');

  assert.equal(result.closed, true);
  const close = operations.find(operation => operation.table === 'rooms' && operation.update);
  assert.equal(close.update.status, 'closed');
  assert.equal(close.update.game_version, 13);
  assert.ok(
    close.filters.some(filter => filter[0] === 'eq' && filter[1] === 'game_version' && filter[2] === 12),
    'the close must compare-and-swap the version it invalidates',
  );
});

test('lobby offers an owner-only Close action and returns to owned rooms before cleanup', () => {
  const lobby = read('index.html');
  const rowFunction = extractFunction(lobby, 'row');
  assert.match(rowFunction, /const canClose = t\.roomCode && isRoomHost\(t\)[\s\S]*status === 'waiting'[\s\S]*t\.opponent === 'bot'/);
  assert.match(rowFunction, /data-close-room=/);
  assert.match(rowFunction, /tt\('close_room'\)/);

  const handlerStart = lobby.indexOf("document.getElementById('tables-list').addEventListener('click'");
  const handlerEnd = lobby.indexOf("\n  const createGamePanel", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'session-list click handler must exist');
  const handler = lobby.slice(handlerStart, handlerEnd);
  const returnBranch = handler.indexOf("if (row.dataset.status === 'joined' || row.dataset.status === 'waiting')");
  const cleanup = handler.indexOf('const cleanup = await ensureLobbyCleanup();');
  assert.ok(returnBranch >= 0 && cleanup > returnBranch, 'return routing must run before destructive cleanup');
  assert.match(handler.slice(returnBranch, cleanup), /isRoomParticipant\(room\)/);
  assert.match(handler.slice(returnBranch, cleanup), /goToExistingRoom\(room\);\s*return;/);
  assert.match(handler, /if \(closeBtn\)[\s\S]*row\.dataset\.opponent === 'bot'[\s\S]*closeBotRoomWithTimeout\(code\)[\s\S]*closeWaitingRoomWithTimeout\(code\)/);
  assert.match(handler, /if \(result\?\.removed \|\| result\?\.closed === true\)/);
});

test('automatic lobby cleanup consumes only explicit stale-room markers', () => {
  const lobby = read('index.html');
  const cleanupCodesFunction = extractFunction(lobby, 'cleanupRoomCodes');
  const cleanupFunction = extractFunction(lobby, 'closeOwnRoomsOnLobbyEntry');

  const context = { Set, result: null };
  vm.createContext(context);
  vm.runInContext(`
    const pendingStaleRoomCodes = new Set(['RACE-1111']);
    function staleRoomCodes() { return ['EXIT-2222']; }
    const ACTIVE_ROOM_KEY = 'active';
    const CREATE_GAME_KEY = 'create';
    ${cleanupCodesFunction}
    result = cleanupRoomCodes();
  `, context);
  assert.deepEqual(Array.from(context.result), ['RACE-1111', 'EXIT-2222']);
  assert.match(cleanupFunction, /const capturedCodes = cleanupRoomCodes\(\);/);
  assert.doesNotMatch(cleanupFunction, /storedRoomCodes|ACTIVE_ROOM_KEY|CREATE_GAME_KEY/);
  assert.match(cleanupFunction, /NarduRooms\.closeWaitingRoom\(code,/);
  assert.match(cleanupFunction, /Promise\.allSettled/);
  assert.match(cleanupFunction, /Number\(error\?\.status\) === 403\)[\s\S]*settledCodes\.push\(code\)/);
});

test('bot navigation is gated by cleanup and the canonical active-room check', () => {
  const lobby = read('index.html');
  const submitStart = lobby.indexOf("createGameForm.addEventListener('submit'");
  const botStart = lobby.indexOf("if (createState.opponent === 'bot')", submitStart);
  const humanStart = lobby.indexOf("\n    try {\n      const cleanup = await ensureLobbyCleanup();", botStart + 1);
  assert.ok(submitStart >= 0 && botStart > submitStart && humanStart > botStart, 'bot submit branch must exist');
  const botBranch = lobby.slice(botStart, humanStart);
  const cleanup = botBranch.indexOf('await ensureLobbyCleanup()');
  const activeLookup = botBranch.indexOf('await loadActiveRoomWithTimeout()');
  const conflictGuard = botBranch.indexOf('if (activeRoom)');
  const persist = botBranch.indexOf('NarduApp.persistBotGameConfig(settings)');
  const navigate = botBranch.indexOf("location.href = 'room.html?' + params.toString()");

  assert.ok(cleanup >= 0, 'bot creation must serialize pending waiting-room cleanup');
  assert.ok(activeLookup > cleanup, 'the active room must be checked after cleanup');
  assert.ok(conflictGuard > activeLookup, 'an existing online or bot room must gate creation');
  assert.ok(persist > conflictGuard, 'bot config must not be persisted before the conflict guard');
  assert.ok(navigate > persist, 'navigation must happen only after the active-room guard');
  assert.match(botBranch, /if \(activeRoom\.opponent === 'bot' && goToExistingBotRoom\(activeRoom\)\) return;/);
  assert.match(botBranch, /createError\.textContent = tt\('active_room_conflict'\);/);

  const refresh = extractFunction(lobby, 'refreshPlayerRooms');
  assert.match(refresh, /NarduRooms\.listRooms\(\)[\s\S]*NarduRooms\.getActiveRoom\(\)/);
  assert.match(refresh, /mergedRooms\.unshift\(activeRoom\)/);
});

test('a waiting-host timeout queues an exact retry and still reaches the lobby', async () => {
  const room = read('room.html');
  const sources = [
    extractFunction(room, 'readStaleRoomCodes'),
    extractFunction(room, 'rememberWaitingRoomForCleanup'),
    extractFunction(room, 'forgetWaitingRoomCleanup'),
    extractFunction(room, 'clearCurrentRoomStorage'),
    extractFunction(room, 'removeCurrentWaitingRoom'),
    extractFunction(room, 'stopWaitingRoomWatchForExit'),
    extractFunction(room, 'leaveToLobby'),
  ].join('\n');
  const activeKey = 'narduh-active-room';
  const createKey = 'narduh-create-game';
  const staleKey = 'narduh-stale-room-codes-v1';
  const localStorage = memoryStorage({
    [activeKey]: JSON.stringify({ code: 'WAIT-ROOM' }),
    [createKey]: JSON.stringify({ code: 'WAIT-ROOM' }),
  });
  const location = { href: 'room.html?room=WAIT-ROOM' };
  const context = {
    localStorage,
    location,
    console: { warn() {} },
    JSON,
    Set,
    NarduApp: {
      safeStorageSet(key, value) { localStorage.setItem(key, value); },
      redirectForAuthError: () => false,
      getUser: () => ({ name: 'Наблюдатель' }),
    },
    NarduRooms: { closeWaitingRoom() {} },
    clearInterval() {},
  };
  vm.createContext(context);
  vm.runInContext(`
    const roomCode = 'WAIT-ROOM';
    const ACTIVE_ROOM_KEY = ${JSON.stringify(activeKey)};
    const CREATE_GAME_KEY = ${JSON.stringify(createKey)};
    const STALE_ROOM_CODES_KEY = ${JSON.stringify(staleKey)};
    const isWaitingHost = true;
    const isSpectatorRoom = false;
    let waitingPoll = null;
    let waitingRoomExitStarted = false;
    let presenceTimer = 1;
    let spectatorTimer = 2;
    function cancelPresenceHeartbeatRequest() {}
    async function closeWaitingRoomWithTimeout() {
      const error = new Error('Waiting room close timed out.');
      error.code = 'WAITING_ROOM_CLOSE_TIMEOUT';
      throw error;
    }
    ${sources}
    globalThis.runLeave = leaveToLobby;
  `, context);

  await context.runLeave();

  assert.equal(location.href, 'index.html');
  assert.deepEqual(JSON.parse(localStorage.getItem(staleKey)), ['WAIT-ROOM']);
  assert.ok(localStorage.getItem(activeKey), 'recovery metadata remains until the retry succeeds');
  assert.ok(localStorage.getItem(createKey), 'creation metadata remains until the retry succeeds');
});

test('choosing the lobby permanently disarms an in-flight waiting-room join redirect', async () => {
  const room = read('room.html');
  const sources = [
    extractFunction(room, 'readStaleRoomCodes'),
    extractFunction(room, 'rememberWaitingRoomForCleanup'),
    extractFunction(room, 'forgetWaitingRoomCleanup'),
    extractFunction(room, 'clearCurrentRoomStorage'),
    extractFunction(room, 'removeCurrentWaitingRoom'),
    extractFunction(room, 'stopWaitingRoomWatchForExit'),
    extractFunction(room, 'leaveToLobby'),
    extractFunction(room, 'watchWaitingRoom'),
  ].join('\n');
  const activeKey = 'narduh-active-room';
  const createKey = 'narduh-create-game';
  const staleKey = 'narduh-stale-room-codes-v1';
  const localStorage = memoryStorage({
    [activeKey]: JSON.stringify({ code: 'RACE-ROOM' }),
    [createKey]: JSON.stringify({ code: 'RACE-ROOM' }),
  });
  let resolveWaitingPoll;
  const waitingPollResult = new Promise(resolve => { resolveWaitingPoll = resolve; });
  let intervalCallback = null;
  const clearedIntervals = [];
  const location = { href: 'room.html?waiting=1&room=RACE-ROOM' };
  const context = {
    localStorage,
    location,
    console: { warn() {} },
    JSON,
    Set,
    URLSearchParams,
    pollResult: waitingPollResult,
    setInterval(callback) {
      intervalCallback = callback;
      return 77;
    },
    clearInterval(id) { clearedIntervals.push(id); },
    NarduApp: {
      safeStorageSet(key, value) { localStorage.setItem(key, value); },
      redirectForAuthError: () => false,
      getUser: () => ({ name: 'Наблюдатель' }),
    },
    NarduRooms: {},
  };
  vm.createContext(context);
  vm.runInContext(`
    const roomCode = 'RACE-ROOM';
    const ACTIVE_ROOM_KEY = ${JSON.stringify(activeKey)};
    const CREATE_GAME_KEY = ${JSON.stringify(createKey)};
    const STALE_ROOM_CODES_KEY = ${JSON.stringify(staleKey)};
    const isWaitingHost = true;
    const isSpectatorRoom = false;
    const localPlayerColor = 'white';
    let waitingPoll = null;
    let waitingPollBusy = false;
    let waitingRoomExitStarted = false;
    let presenceTimer = 1;
    let spectatorTimer = 2;
    function cancelPresenceHeartbeatRequest() {}
    function startPresenceProtocol() {}
    function startSpectatorProtocol() {}
    async function reportActiveRemoteLeave() { return false; }
    async function activeRoom() { return globalThis.pollResult; }
    async function closeWaitingRoomWithTimeout() {
      return { ok: true, removed: false, room: { status: 'joined' } };
    }
    function t(key) { return key; }
    ${sources}
    globalThis.runWatch = watchWaitingRoom;
    globalThis.runLeave = leaveToLobby;
  `, context);

  context.runWatch();
  assert.equal(typeof intervalCallback, 'function');
  const inFlightPoll = intervalCallback();
  await Promise.resolve();

  await context.runLeave();
  assert.equal(location.href, 'index.html');
  assert.ok(clearedIntervals.includes(77), 'the waiting timer is cleared as soon as exit starts');
  assert.equal(localStorage.getItem(staleKey), null, 'a joined close race is not queued as a stale waiting room');
  assert.ok(localStorage.getItem(activeKey), 'joined-room recovery data is preserved');
  assert.ok(localStorage.getItem(createKey), 'joined-room creation data is preserved');

  resolveWaitingPoll({
    code: 'RACE-ROOM',
    status: 'joined',
    guestName: 'Соперник',
    variant: 'long',
  });
  await inFlightPoll;
  assert.equal(location.href, 'index.html', 'the late joined response cannot pull the user back into the room');
});
