const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('BFCache pagehide invalidates spectator heartbeat without racing a leave', () => {
  const room = fs.readFileSync(path.join(root, 'room.html'), 'utf8');
  const start = room.indexOf("window.addEventListener('pagehide', event => {");
  const end = room.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start, 'pagehide lifecycle handler should exist');
  const lifecycle = room.slice(start, end);

  assert.match(lifecycle, /cancelSpectatorHeartbeatRequest\(\);/);
  assert.match(lifecycle, /if \(event\.persisted\) return;[\s\S]*NarduRooms\.leaveSpectator/);
});

test('spectator heartbeat has its own abortable watchdog', () => {
  const room = fs.readFileSync(path.join(root, 'room.html'), 'utf8');
  const start = room.indexOf('async function sendSpectatorHeartbeat()');
  const end = room.indexOf('function startSpectatorProtocol()', start);
  assert.ok(start >= 0 && end > start, 'spectator heartbeat lifecycle should exist');
  const heartbeat = room.slice(start, end);

  assert.match(heartbeat, /new AbortController\(\)/);
  assert.match(heartbeat, /setTimeout\(\(\) => controller\.abort\(\), ROOM_HEARTBEAT_REQUEST_STALE_MS\)/);
  assert.match(heartbeat, /NarduRooms\.watchRoom\([\s\S]*\{ signal: controller\?\.signal \}/);
  assert.match(heartbeat, /function cancelSpectatorHeartbeatRequest\(\)[\s\S]*spectatorAbortController\?\.abort\(\)/);
});
