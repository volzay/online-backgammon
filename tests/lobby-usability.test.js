const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function lobbySource() {
  return fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
}

test('lobby renders only server-backed rooms without placeholder people or statistics', () => {
  const lobby = lobbySource();

  assert.doesNotMatch(lobby, /id="qs-online"|id="qs-games"/);
  assert.doesNotMatch(lobby, /id="lb-list"|id="friends-list"|id="friends-count"/);
  assert.doesNotMatch(lobby, /const\s+(?:tables|lb|friends)\s*=\s*\[/);
  assert.doesNotMatch(lobby, /Tigran|Sereja91|irina_b|mukhtar|Александра|Bot medium|Bot easy/);
  assert.match(lobby, /let playerRooms = \[\];/);
  assert.match(lobby, /return playerRooms\.filter\(matchesSessionFilter\);/);
});

test('session list has an honest loading state before the first server response', () => {
  const lobby = lobbySource();

  assert.match(lobby, /let roomsLoaded = false;/);
  assert.match(lobby, /if \(!roomsLoaded\) \{[\s\S]*sessions_loading/);
  assert.match(lobby, /const mergedRooms = \[\.\.\.\(data\.rooms \|\| \[\]\)\];[\s\S]*playerRooms = mergedRooms;[\s\S]*roomsLoaded = true;/);
  assert.match(lobby, /id="sessions-status"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('lobby actions match the behavior they advertise in Russian and English', () => {
  const lobby = lobbySource();

  for (const action of ['browse', 'bot', 'create', 'code']) {
    assert.match(lobby, new RegExp(`data-action="${action}"`));
  }
  assert.match(lobby, /play_find_opponent: 'Найти соперника'/);
  assert.match(lobby, /play_find_opponent: 'Find an opponent'/);
  assert.match(lobby, /play_bot: 'Играть с ботом'/);
  assert.match(lobby, /play_bot: 'Play against a bot'/);
  assert.match(lobby, /a === 'bot'[\s\S]*createState\.opponent = 'bot';[\s\S]*showCreatePanel\(\)/);
  assert.match(lobby, /a === 'create'[\s\S]*createState\.opponent = 'player';[\s\S]*showCreatePanel\(\)/);
  assert.match(lobby, /a === 'browse'[\s\S]*game-sessions-title[\s\S]*scrollIntoView/);
});

test('the former quick-match control cannot silently start a medium bot', () => {
  const lobby = lobbySource();

  assert.doesNotMatch(lobby, /data-action="quick"|data-quick-variant|quickState/);
  assert.doesNotMatch(lobby, /if \(a === 'quick'\)[\s\S]*difficulty:\s*'medium'/);
  assert.doesNotMatch(lobby, /Подберём соперника по рейтингу|We will find you a rated opponent/);
});

test('room invitation deep links open the join panel with a normalized code only', () => {
  const lobby = lobbySource();

  assert.match(lobby, /new URLSearchParams\(location\.search\)\.get\('join'\)/);
  assert.match(lobby, /normalizeInviteCode[\s\S]*toUpperCase\(\)[\s\S]*replace\(\/\[\^A-Z0-9\]\//);
  assert.match(lobby, /joinCodeInput\.value = invitedCode;/);
  assert.match(lobby, /joinPasswordInput\.value = '';/);
  assert.match(lobby, /joinPasswordInput\.value = '';\s+showJoinCodePanel\(\);/);
  assert.doesNotMatch(lobby, /(?:get|has)\(['"]password['"]\)/);
});
