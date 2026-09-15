const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ROOM_SOURCE = fs.readFileSync(path.join(ROOT, 'room.html'), 'utf8');
const BOT_ROOM_CODE = 'DAK9-ETEA';
const FOREIGN_ROOM_CODE = 'SAFE-RQME';

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

function createExitHarness(closeBotRoom) {
  const activeKey = 'narduh-active-room';
  const createdKey = 'narduh-created-game';
  const exactBotKey = `narduh-bot-game:${BOT_ROOM_CODE}`;
  const foreignBotKey = `narduh-bot-game:${FOREIGN_ROOM_CODE}`;
  const unrelatedKey = 'narduh-room-state:foreign-room';
  const localStorage = memoryStorage({
    [activeKey]: JSON.stringify({ game: BOT_ROOM_CODE, role: 'host' }),
    [createdKey]: JSON.stringify({ code: BOT_ROOM_CODE, opponent: 'bot' }),
    [exactBotKey]: JSON.stringify({ game: BOT_ROOM_CODE, difficulty: 'hard' }),
    [foreignBotKey]: JSON.stringify({ game: FOREIGN_ROOM_CODE, difficulty: 'hard' }),
    [unrelatedKey]: 'keep-me',
  });
  const calls = [];
  const location = {
    href: `room.html?mode=bot&game=${BOT_ROOM_CODE}`,
  };
  const roomUrl = new URL(`https://volzay.github.io/online-backgammon/${location.href}`);
  const networkPanels = [];
  const context = {
    localStorage,
    location,
    roomUrl,
    URL,
    JSON,
    console: { warn() {} },
    NarduApp: {
      getUser: () => ({ name: 'Наблюдатель' }),
      redirectForAuthError: () => false,
    },
    NarduRooms: {
      async closeBotRoom(code) {
        calls.push(code);
        return closeBotRoom(code);
      },
    },
    t: key => key,
    earlyRoomText: key => key,
    showNetworkPanel: panel => networkPanels.push(panel),
    startPresenceProtocol() {},
    startSpectatorProtocol() {},
    cancelPresenceHeartbeatRequest() {},
    reportActiveRemoteLeave: async () => false,
    clearInterval() {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`
    const ACTIVE_ROOM_KEY = ${JSON.stringify(activeKey)};
    const CREATE_GAME_KEY = ${JSON.stringify(createdKey)};
    const roomCode = roomUrl.searchParams.get('room') || '';
    const displayRoomCode = roomCode || roomUrl.searchParams.get('game') || '';
    const isWaitingHost = false;
    const isSpectatorRoom = false;
    let waitingRoomExitStarted = false;
    let waitingPoll = null;
    let presenceTimer = null;
    let spectatorTimer = null;
    ${extractFunction(ROOM_SOURCE, 'clearCurrentRoomStorage')}
    ${extractFunction(ROOM_SOURCE, 'removeCurrentWaitingRoom')}
    ${extractFunction(ROOM_SOURCE, 'stopWaitingRoomWatchForExit')}
    ${extractFunction(ROOM_SOURCE, 'leaveToLobby')}
    globalThis.runLeaveToLobby = leaveToLobby;
  `, context);
  return {
    context,
    localStorage,
    location,
    calls,
    networkPanels,
    keys: { activeKey, createdKey, exactBotKey, foreignBotKey, unrelatedKey },
  };
}

test('bot exit uses the ?game code and clears only that successfully closed room', async () => {
  const harness = createExitHarness(async code => ({
    ok: true,
    removed: true,
    closed: true,
    code,
  }));

  await harness.context.runLeaveToLobby();

  assert.deepEqual(harness.calls, [BOT_ROOM_CODE]);
  assert.equal(harness.location.href, 'index.html');
  assert.equal(harness.localStorage.getItem(harness.keys.activeKey), null);
  assert.equal(harness.localStorage.getItem(harness.keys.createdKey), null);
  assert.equal(harness.localStorage.getItem(harness.keys.exactBotKey), null);
  assert.ok(
    harness.localStorage.getItem(harness.keys.foreignBotKey),
    'closing one bot room must not erase another room config',
  );
  assert.equal(harness.localStorage.getItem(harness.keys.unrelatedKey), 'keep-me');
});

test('a CAS-losing bot close preserves recovery storage and stays on the board', async () => {
  const harness = createExitHarness(async code => ({
    ok: true,
    removed: false,
    closed: false,
    code,
    room: { code, status: 'joined', version: 148 },
  }));
  const originalHref = harness.location.href;

  await harness.context.runLeaveToLobby();

  assert.deepEqual(harness.calls, [BOT_ROOM_CODE]);
  assert.equal(harness.location.href, originalHref);
  assert.ok(harness.localStorage.getItem(harness.keys.activeKey));
  assert.ok(harness.localStorage.getItem(harness.keys.createdKey));
  assert.ok(harness.localStorage.getItem(harness.keys.exactBotKey));
  assert.ok(harness.localStorage.getItem(harness.keys.foreignBotKey));
  assert.equal(harness.localStorage.getItem(harness.keys.unrelatedKey), 'keep-me');
});

test('a failed bot close preserves recovery storage and stays on the board', async () => {
  const harness = createExitHarness(async () => {
    throw new Error('RPC unavailable');
  });
  const originalHref = harness.location.href;

  await harness.context.runLeaveToLobby();

  assert.deepEqual(harness.calls, [BOT_ROOM_CODE]);
  assert.equal(harness.location.href, originalHref);
  assert.ok(harness.localStorage.getItem(harness.keys.activeKey));
  assert.ok(harness.localStorage.getItem(harness.keys.createdKey));
  assert.ok(harness.localStorage.getItem(harness.keys.exactBotKey));
  assert.ok(harness.localStorage.getItem(harness.keys.foreignBotKey));
  assert.equal(harness.localStorage.getItem(harness.keys.unrelatedKey), 'keep-me');
  assert.equal(harness.networkPanels.length, 1);
});
