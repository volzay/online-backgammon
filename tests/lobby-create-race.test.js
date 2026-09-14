const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const lobby = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(signature) {
  const start = lobby.indexOf(signature);
  assert.notEqual(start, -1, `${signature} should exist`);
  const bodyStart = lobby.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < lobby.length; index += 1) {
    if (lobby[index] === '{') depth += 1;
    if (lobby[index] === '}') depth -= 1;
    if (depth === 0) return lobby.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${signature}`);
}

test('a stale create response is queued for serialized cleanup instead of racing a reopened room', async () => {
  const deleted = [];
  const stored = new Map();
  const context = {
    NarduRooms: {
      deleteRoom(code, options) {
        deleted.push({ code, options });
        return Promise.resolve({ ok: true });
      },
    },
    localStorage: {
      getItem(key) { return stored.has(key) ? stored.get(key) : null; },
      setItem(key, value) { stored.set(key, String(value)); },
      removeItem(key) { stored.delete(key); },
    },
    NarduApp: {
      safeStorageSet(key, value) {
        stored.set(key, String(value));
        return true;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`
    const ACTIVE_ROOM_KEY = 'narduh-active-room';
    const CREATE_GAME_KEY = 'narduh-created-game';
    const STALE_ROOM_CODES_KEY = 'narduh-stale-room-codes';
    let activeLobbyRoomCode = '';
    const pendingStaleRoomCodes = new Set();
    let lobbyCleanupPromise = Promise.resolve({ ok: true, closedCodes: [] });
    ${extractFunction('function staleRoomCodes')}
    ${extractFunction('function storedRoomCodes')}
    ${extractFunction('function markLobbyRoomActive')}
    ${extractFunction('function isCurrentLobbyRoomCode')}
    ${extractFunction('function cleanupStaleCreatedRoom')}
    markLobbyRoomActive({ code: 'ABCD-EFGH' });
    globalThis.cleanedCurrent = cleanupStaleCreatedRoom({ code: 'ABCD-EFGH' });
    globalThis.cleanedOrphan = cleanupStaleCreatedRoom({ code: 'WXYZ-2345' });
  `, context);
  await Promise.resolve();

  assert.equal(context.cleanedCurrent, false);
  assert.equal(context.cleanedOrphan, true);
  assert.equal(deleted.length, 0, 'cleanup must not launch a destructive request outside the lobby queue');
  assert.deepEqual(JSON.parse(stored.get('narduh-stale-room-codes')), ['WXYZ-2345']);
});
