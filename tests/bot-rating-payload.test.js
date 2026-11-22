const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'game-controller.js'), 'utf8');
const begin = source.indexOf('  function submitRoomRating(');
const end = source.indexOf('\n  function gameResultKey(', begin);
assert.ok(begin > 0 && end > begin);

function harness(mode, configured = true) {
  const calls = [];
  const state = {
    winner: 'white', score: { white: 1, dark: 0 }, off: { white: 15, dark: 8 },
    finishedAt: 1795364012994,
    history: Array.from({ length: 300 }, (_, i) => ({ at: i, roll: '3:4' })),
  };
  const context = {
    mode, state, playerColor: 'white', opponentName: 'Bot', opponentRating: 1500,
    remoteCode: 'LEM5-RES8', Date, window: { NarduSupabase: { configured: () => configured } },
    NarduRating: { record: (...args) => { calls.push(args); return 'receipt'; } },
    remoteStatePayload: () => {
      if (mode === 'bot' && configured) throw new Error('bot training ledger must not be copied for rating');
      return { ...state, analysis: { marker: 'remote-state' } };
    },
  };
  vm.runInNewContext(source.slice(begin, end), context);
  return { context, calls, state };
}

test('a saved bot result builds a tiny rating request without cloning its training state', () => {
  const { context, calls } = harness('bot');
  assert.equal(context.submitRoomRating('1795364012994:white:normal', true), 'receipt');
  const [, , didWin, mode, key, raw] = calls[0];
  const details = JSON.parse(JSON.stringify(raw));
  assert.equal(didWin, true);
  assert.equal(mode, 'bot');
  assert.equal(key, '1795364012994:white:normal');
  assert.equal(details.onlyIfMissing, true);
  assert.deepEqual(details.score.finalState, { finishedAt: 1795364012994 });
  assert.deepEqual(details.history, []);
  assert.equal(details.historyCount, 300);
  assert.ok(Buffer.byteLength(JSON.stringify(details)) < 512);
});

test('two-player rating keeps its existing state and move history', () => {
  const { context, calls, state } = harness('remote');
  context.submitRoomRating('1795364012994:white:normal');
  const details = JSON.parse(JSON.stringify(calls[0][5]));
  assert.deepEqual(details.score.finalState.analysis, { marker: 'remote-state' });
  assert.equal(details.score.finalState.history, undefined);
  assert.deepEqual(details.history, state.history);
  assert.equal(details.historyCount, 300);
});

test('a local bot game without the saved-room backend retains its existing result payload', () => {
  const { context, calls, state } = harness('bot', false);
  context.submitRoomRating('1795364012994:white:normal');
  const details = JSON.parse(JSON.stringify(calls[0][5]));
  assert.deepEqual(details.score.finalState.analysis, { marker: 'remote-state' });
  assert.deepEqual(details.history, state.history);
});
