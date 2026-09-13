const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const room = fs.readFileSync(path.join(ROOT, 'room.html'), 'utf8');
const controller = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${signature}`);
}

test('the game screen exposes an assertive visual status backed by engine state', () => {
  assert.match(room, /class="game-turn-status"[^>]*data-turn-status[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(controller, /function currentTurnStatus\(\)/);
  assert.match(controller, /state\.phase === 'waiting'/);
  assert.match(controller, /state\.phase === 'opening'/);
  assert.match(controller, /state\.phase === 'opening-result'/);
  assert.match(controller, /state\.phase === 'roll' \|\| isRolling/);
  assert.match(controller, /state\.phase === 'move' && !NarduGame\.hasAnyMoves\(state\)/);
  assert.match(controller, /state\.phase === 'over' \|\| state\.winner/);
  assert.match(controller, /paintTurnStatus\(status\.text, status\.tone\)/);
});

test('a spectator sees the actual winner instead of the spectator identity', () => {
  const sources = [
    extractFunction(controller, 'function turnName'),
    extractFunction(controller, 'function currentTurnStatus'),
  ].join('\n');
  const evaluate = new Function(
    'state', 'spectatorMode', 'mode', 'playerColor', 'window', 'localizedName',
    'opponentName', 'tr', 'sideName', 'NarduGame', 'isRolling',
    `${sources}\nreturn currentTurnStatus();`,
  );
  const status = evaluate(
    {
      phase: 'over',
      winner: 'white',
      turn: 'white',
      openingRoll: {
        host: { color: 'white', name: 'tester1' },
        guest: { color: 'dark', name: 'warlord' },
      },
    },
    true,
    'remote',
    'white',
    { NarduApp: { getUser: () => ({ name: 'Наблюдатель' }) } },
    value => value,
    'tester1 против warlord',
    (key, values = {}) => key === 'turn_finished' ? `Победитель: ${values.winner}` : key,
    color => color === 'white' ? 'Белые' : 'Тёмные',
    { hasAnyMoves: () => true },
    false,
  );

  assert.equal(status.text, 'Победитель: tester1');
  assert.doesNotMatch(status.text, /Наблюдатель/);
});

test('waiting-room invitation contains a join deep link and never puts its password in the URL', () => {
  assert.match(room, /data-copy-invite[^>]*data-i18n="copy_invite"/);
  assert.match(room, /type="url" readonly data-invite-url/);
  assert.match(room, /inviteUrl\.searchParams\.set\('join', code\)/);
  assert.doesNotMatch(room, /inviteUrl\.searchParams\.set\(['"]password['"]/);
  assert.match(room, /button\.dataset\.inviteAccess === 'closed' && password/);
  assert.match(room, /lines\.push\(`\$\{t\('password'\)\}: \$\{password\}`\)/);
  assert.match(room, /navigator\.clipboard\?\.writeText/);
  assert.match(room, /document\.execCommand\('copy'\)/);
  assert.match(room, /inviteField\?\.focus\(\)/);
  assert.match(room, /inviteField\?\.select\(\)/);
  assert.match(room, /t\('invite_copy_manual'\)/);
});

test('the match-to-five display remains wired to the persisted rematch score', () => {
  assert.match(room, /data-stat="match"/);
  assert.match(controller, /function formatMatchScore\(color\)/);
  assert.match(controller, /return `\$\{score\[color\] \|\| 0\}\/\$\{score\.target\}`/);
  assert.match(controller, /matchScore\[state\.winner\] = \(matchScore\[state\.winner\] \|\| 0\) \+ 1/);
});
