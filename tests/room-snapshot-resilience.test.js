const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ROOM_SEARCH = '?mode=bot&game=SNAP-TEST&variant=long&difficulty=hard';
const ROOM_SIGNATURE = `/room.html${ROOM_SEARCH}`;
const ROOM_KEY = `narduh-room-state:${ROOM_SIGNATURE}`;
const ROOM_PREFIX = 'narduh-room-state:';

function controlledStorage() {
  const values = new Map();
  const setAttempts = new Map();
  let quotaFailures = 0;
  let failEveryWrite = false;
  let failurePredicate = () => true;

  function quotaError() {
    return Object.assign(new Error('The quota has been exceeded.'), {
      name: 'QuotaExceededError',
      code: 22,
    });
  }

  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      setAttempts.set(key, (setAttempts.get(key) || 0) + 1);
      if (failurePredicate(key) && (failEveryWrite || quotaFailures > 0)) {
        if (quotaFailures > 0) quotaFailures -= 1;
        throw quotaError();
      }
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
    clear() {
      values.clear();
      setAttempts.clear();
      quotaFailures = 0;
      failEveryWrite = false;
      failurePredicate = () => true;
    },
    seed(key, value) { values.set(key, String(value)); },
    keys() { return [...values.keys()]; },
    attempts(key) { return setAttempts.get(key) || 0; },
    failNextQuota(count = 1, predicate = () => true) {
      quotaFailures = count;
      failurePredicate = predicate;
    },
    failQuotaAlways(predicate = () => true) {
      failEveryWrite = true;
      failurePredicate = predicate;
    },
  };
}

function controllerHarness() {
  const localStorage = controlledStorage();
  const sessionStorage = controlledStorage();
  const warnings = [];
  const document = {
    hidden: false,
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const window = {
    addEventListener() {},
    setTimeout() { return 1; },
    NarduApp: {
      getUser() { return { id: 'user-1', name: 'Snapshot tester', guest: false }; },
      paintUser() {},
    },
  };
  window.window = window;
  const quietConsole = Object.create(console);
  quietConsole.warn = (...args) => warnings.push(args.join(' '));
  const context = {
    window,
    document,
    console: quietConsole,
    Date,
    Math,
    JSON,
    URL,
    Uint8Array,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    requestAnimationFrame(callback) { callback(); return 1; },
    localStorage,
    sessionStorage,
    location: {
      href: `https://example.test/room.html${ROOM_SEARCH}`,
      pathname: '/room.html',
      search: ROOM_SEARCH,
      hostname: 'example.test',
    },
    history: { replaceState() {} },
    NarduSound: { click() {}, move() {}, bearOff() {}, win() {}, lose() {}, prime() {} },
    NarduRating: { record() { return null; } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context, {
    filename: 'game.js',
  });
  context.NarduGame = window.NarduGame;
  const source = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8').replace(
    '    preferredMoveAction,\n  };',
    '    preferredMoveAction,\n    __snapshotTest: { writeRoomSnapshot, persistRoomSnapshot, pruneRoomSnapshots },\n  };',
  );
  vm.runInContext(source, context, { filename: 'game-controller.js' });
  const controller = window.NarduController;
  controller.init({
    mode: 'bot',
    roomCode: 'SNAP-TEST',
    variant: 'long',
    difficulty: 'hard',
    opponent: 'Hard bot',
    opponentRating: 1500,
    skipAutoStart: true,
  });
  localStorage.clear();
  sessionStorage.clear();
  return { controller, localStorage, sessionStorage, warnings };
}

function storedSnapshot(at = Date.now()) {
  return JSON.stringify({
    v: 1,
    at,
    signature: '/room.html?mode=bot',
    mode: 'bot',
    playerColor: 'white',
    roomCode: 'OLD-ROOM',
    state: { phase: 'move', points: [] },
  });
}

test('every ordinary room persist writes the same recovery snapshot to both storage tiers', () => {
  const harness = controllerHarness();

  assert.equal(harness.controller.__snapshotTest.persistRoomSnapshot(), true);
  const persistent = JSON.parse(harness.localStorage.getItem(ROOM_KEY));
  const session = JSON.parse(harness.sessionStorage.getItem('narduh-room-reload-snapshot'));

  assert.equal(persistent.signature, ROOM_SIGNATURE);
  assert.equal(session.signature, ROOM_SIGNATURE);
  assert.deepEqual(session.state.points, persistent.state.points);
  assert.equal(harness.controller.getState().analysis.roomSnapshotPersistence.status, 'ready');
});

test('snapshot pruning is bounded to app-owned records and keeps only the newest room history', () => {
  const harness = controllerHarness();
  const now = Date.now();
  harness.localStorage.seed('unrelated-app-data', 'must survive');
  harness.localStorage.seed(`${ROOM_PREFIX}invalid`, '{broken');
  harness.localStorage.seed(
    `${ROOM_PREFIX}expired`,
    storedSnapshot(now - (97 * 60 * 60 * 1000)),
  );
  for (let index = 0; index < 10; index += 1) {
    harness.localStorage.seed(`${ROOM_PREFIX}recent-${index}`, storedSnapshot(now - index * 1000));
  }

  assert.equal(harness.controller.__snapshotTest.persistRoomSnapshot(), true);

  const roomKeys = harness.localStorage.keys().filter(key => key.startsWith(ROOM_PREFIX));
  assert.equal(roomKeys.length, 8, 'the current room plus seven newest prior rooms are retained');
  assert.ok(roomKeys.includes(ROOM_KEY));
  for (let index = 0; index < 7; index += 1) {
    assert.ok(roomKeys.includes(`${ROOM_PREFIX}recent-${index}`));
  }
  assert.equal(harness.localStorage.getItem('unrelated-app-data'), 'must survive');
  assert.equal(harness.localStorage.getItem(`${ROOM_PREFIX}invalid`), null);
  assert.equal(harness.localStorage.getItem(`${ROOM_PREFIX}expired`), null);
});

test('a quota failure prunes the oldest app snapshots and retries the persistent write once', () => {
  const harness = controllerHarness();
  const now = Date.now();
  harness.localStorage.seed(`${ROOM_PREFIX}older`, storedSnapshot(now - 2000));
  harness.localStorage.seed(`${ROOM_PREFIX}newer`, storedSnapshot(now - 1000));
  harness.localStorage.failNextQuota(1, key => key === ROOM_KEY);

  assert.equal(harness.controller.__snapshotTest.persistRoomSnapshot(), true);
  assert.equal(harness.localStorage.attempts(ROOM_KEY), 2);
  assert.equal(harness.localStorage.getItem(ROOM_KEY) !== null, true);
  assert.equal(harness.localStorage.getItem(`${ROOM_PREFIX}older`), null);
  const telemetry = harness.controller.getState().analysis.roomSnapshotPersistence;
  assert.equal(telemetry.status, 'ready');
  assert.equal(telemetry.persistentSaved, true);
  assert.equal(telemetry.retried, true);
  assert.ok(telemetry.pruned >= 1);
});

test('a persistent quota outage remains recoverable from sessionStorage and is reported as degraded', () => {
  const harness = controllerHarness();
  harness.localStorage.seed('unrelated-app-data', 'must survive');
  harness.localStorage.failQuotaAlways(key => key === ROOM_KEY);

  assert.equal(harness.controller.__snapshotTest.persistRoomSnapshot(), true);
  assert.equal(harness.sessionStorage.getItem('narduh-room-reload-snapshot') !== null, true);
  assert.equal(harness.localStorage.getItem(ROOM_KEY), null);
  assert.equal(harness.localStorage.getItem('unrelated-app-data'), 'must survive');
  const telemetry = harness.controller.getState().analysis.roomSnapshotPersistence;
  assert.equal(telemetry.status, 'degraded');
  assert.equal(telemetry.sessionSaved, true);
  assert.equal(telemetry.persistentSaved, false);
  assert.equal(telemetry.error, 'persistent:quota-exceeded');
});

test('a complete storage outage returns false and leaves explicit failure telemetry', () => {
  const harness = controllerHarness();
  harness.localStorage.seed('unrelated-app-data', 'must survive');
  harness.localStorage.failQuotaAlways();
  harness.sessionStorage.failQuotaAlways();

  assert.equal(harness.controller.__snapshotTest.persistRoomSnapshot(), false);
  assert.equal(harness.localStorage.getItem('unrelated-app-data'), 'must survive');
  const telemetry = harness.controller.getState().analysis.roomSnapshotPersistence;
  assert.equal(telemetry.status, 'failed');
  assert.equal(telemetry.sessionSaved, false);
  assert.equal(telemetry.persistentSaved, false);
  assert.equal(telemetry.retried, true);
  assert.match(telemetry.error, /session:quota-exceeded/);
  assert.match(telemetry.error, /persistent:quota-exceeded/);
  assert.equal(harness.warnings.length, 1);
});
