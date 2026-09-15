const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PORT = 42143;
const BASE = `http://127.0.0.1:${PORT}`;
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function extractFunction(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `function ${name} must exist`);
  const openingBrace = source.indexOf('{', source.indexOf(')', match.index));
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
    if (char === '}' && --depth === 0) return source.slice(match.index, index + 1);
  }
  assert.fail(`function ${name} body is incomplete`);
}

function loadFreshBrowser(localStorage, sessionStorage, requests) {
  const document = {
    readyState: 'loading',
    documentElement: {
      setAttribute() {},
      style: { setProperty() {} },
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const window = {
    addEventListener() {},
    crypto: webcrypto,
    localStorage,
    sessionStorage,
  };
  window.window = window;

  const browserFetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${BASE}/`).toString();
    requests.push({ url, options });
    return fetch(url, options);
  };
  const context = {
    window,
    document,
    localStorage,
    sessionStorage,
    location: { href: '', replace(value) { this.href = value; } },
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
    TextEncoder,
    Uint8Array,
    URL,
    URLSearchParams,
    AbortController,
    DOMException,
    fetch: browserFetch,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
  };
  context.globalThis = window;
  vm.createContext(context);
  vm.runInContext(read('app.js'), context, { filename: 'app.js' });
  vm.runInContext(read('rooms-client.js'), context, { filename: 'rooms-client.js' });
  return { app: window.NarduApp, rooms: window.NarduRooms };
}

function renderLobbyRow(room, app) {
  const source = read('index.html');
  const context = {
    NarduApp: app,
    userName: () => app.getUser()?.name || 'Guest',
    tt: key => ({
      action: 'Действие',
      access: 'Доступ',
      close_room: 'Закрыть',
      game_variant: 'Вид нард',
      join: 'Войти',
      password: 'Пароль',
      return_to_room: 'Вернуться',
      session_state: 'Статус',
      spectators: 'Зрители',
    })[key] || key,
    escapeHtml: value => String(value ?? ''),
    labelFor: () => 'Длинные нарды',
    variantLabelKeys: {},
    ratingMeta: () => '',
    accessCell: () => '<span>Открытая</span>',
    passwordCell: () => '',
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction(source, 'normalizedName'),
    extractFunction(source, 'isRoomParticipant'),
    extractFunction(source, 'isRoomHost'),
    extractFunction(source, 'row'),
    'globalThis.renderRecoveredRow = row;',
  ].join('\n'), context, { filename: 'index-room-row.js' });

  return context.renderRecoveredRow({
    host: room.hostName,
    hostName: room.hostName,
    hostUserId: room.hostUserId,
    guestName: room.guestName || '',
    guestUserId: room.guestUserId || '',
    opponent: 'player',
    bot: false,
    rating: room.hostRating,
    tier: room.hostTier || '',
    mode: 'Длинные нарды',
    variant: room.variant,
    timer: 'Ожидает',
    access: room.access,
    watchers: 0,
    allowSpectators: false,
    roomCode: room.code,
    localRoom: true,
    playing: false,
    status: room.status,
  });
}

async function waitForServer(server, output) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited before startup\n${output()}`);
    try {
      const response = await fetch(`${BASE}/index.html`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(100);
  }
  throw new Error(`server did not start in time\n${output()}`);
}

test('a fresh browser recovers and can close its guest-owned waiting human room', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nardy-browser-recovery-'));
  let serverOutput = '';
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = chunk => { serverOutput = `${serverOutput}${chunk}`.slice(-16000); };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);

  try {
    await waitForServer(server, () => serverOutput);

    const proof = `gproof:${'5a'.repeat(32)}`;
    const guestId = `guest:sha256:${createHash('sha256')
      .update(`nardu/guest/v1:${proof}`)
      .digest('hex')}`;
    const guest = {
      id: guestId,
      name: 'Guest2468',
      nickname: 'Guest2468',
      rating: null,
      tier: '',
      ratingEligible: false,
      guest: true,
    };
    const persistentStorage = memoryStorage({
      'narduh-user': JSON.stringify(guest),
      'narduh-guest-entry-v1': '1',
      'narduh-guest-credential-v1': JSON.stringify({ version: 1, guestId, proof }),
    });

    const initialRequests = [];
    const initialBrowser = loadFreshBrowser(persistentStorage, memoryStorage(), initialRequests);
    assert.equal(initialBrowser.app.getUser().id, guestId);
    const created = await initialBrowser.rooms.createRoom({
      hostName: guest.name,
      hostUserId: guest.id,
      hostRatingEligible: false,
      variant: 'long',
      access: 'open',
      allowSpectators: false,
    });
    assert.equal(created.room.status, 'waiting');
    assert.equal(created.room.hostUserId, guestId);

    for (const key of ['narduh-active-room', 'narduh-created-game', 'narduh-stale-room-codes']) {
      persistentStorage.removeItem(key);
      assert.equal(persistentStorage.getItem(key), null, `${key} must not recover the room locally`);
    }
    const restartedSession = memoryStorage();
    assert.equal(restartedSession.length, 0, 'the restarted browser has empty sessionStorage');

    const recoveryRequests = [];
    const restartedBrowser = loadFreshBrowser(persistentStorage, restartedSession, recoveryRequests);
    assert.equal(restartedBrowser.app.getUser().id, guestId, 'the persistent guest credential restores the same user');

    const active = await restartedBrowser.rooms.getActiveRoom();
    assert.equal(active.room.code, created.room.code, 'canonical active-room lookup recovers the waiting room');
    assert.equal(active.room.hostUserId, guestId);
    const activeRequest = recoveryRequests.find(request => request.url.endsWith('/api/rooms/active'));
    assert.equal(activeRequest.options.headers['X-Guest-Id'], guestId);
    assert.equal(activeRequest.options.headers['X-Guest-Proof'], proof);

    const html = renderLobbyRow(active.room, restartedBrowser.app);
    assert.match(html, new RegExp(`data-join="${created.room.hostName}"`));
    assert.match(html, />Вернуться<\/button>/);
    assert.match(html, new RegExp(`data-close-room="${created.room.code}"`));
    assert.match(html, />Закрыть<\/button>/);

    const closed = await restartedBrowser.rooms.closeWaitingRoom(created.room.code);
    assert.equal(closed.removed, true);
    const closeRequest = recoveryRequests.find(request => (
      request.options.method === 'DELETE' && request.url.includes(`/api/rooms/${created.room.code}?waiting=1`)
    ));
    assert.ok(closeRequest, 'the recovered owner must issue the safe waiting-room close request');
    assert.equal(closeRequest.options.headers['X-Guest-Id'], guestId);
    assert.equal(closeRequest.options.headers['X-Guest-Proof'], proof, 'closing is authorized by the persistent private proof');

    const afterClose = await restartedBrowser.rooms.getActiveRoom();
    assert.equal(afterClose.room, null);
  } finally {
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
