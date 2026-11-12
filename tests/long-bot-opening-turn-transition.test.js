const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const context = vm.createContext({ window: {}, Date, Math });
vm.runInContext(fs.readFileSync(path.join(root, 'game.js'), 'utf8'), context);
const bundle = fs.readFileSync(path.join(root, 'long-bot-engine.js'), 'utf8');
const instrumented = bundle.replace(
  /\n\}\(\)\);\s*$/,
  '\nwindow.openingTurnTest = { prepareReplyState, createNarduGameAdapter };\n}());\n',
);
assert.notEqual(instrumented, bundle, 'locate the generated engine scope');
vm.runInContext(instrumented, context);

const game = context.window.NarduGame;
const { prepareReplyState, createNarduGameAdapter } = context.window.openingTurnTest;
const adapter = createNarduGameAdapter(game, { generatedSequenceFastPath: true });
const clone = state => JSON.parse(JSON.stringify(state));

function realReply(after, dice) {
  const state = clone(after);
  game.endTurn(state);
  game.applyRoll(state, dice);
  return state;
}

function maxHeadRelease(state) {
  const head = game.headPoint(state.turn, state);
  return Math.max(...game.bestMoveSequences(state, state.turn)
    .map(sequence => sequence.filter(move => move.from === head).length));
}

function playPreview(state) {
  const sequence = game.bestMoveSequences(state, state.turn)[0];
  assert.ok(sequence.length > 0);
  return adapter.applySequence(state, sequence, state.turn);
}

function assertNativeTransition(actual, expected) {
  for (const field of ['turn', 'phase', 'dice', 'rolled', 'turnMoves',
    'firstMoveDone', 'headPlayedThisTurn', 'points']) {
    assert.deepEqual(clone(actual[field]), clone(expected[field]), field);
  }
  assert.deepEqual(
    clone(game.bestMoveSequences(actual, actual.turn)),
    clone(game.bestMoveSequences(expected, expected.turn)),
    'the tactical reply must see exactly the public legal turn sequences',
  );
}

for (const first of ['white', 'dark']) {
  test(`opening tactical simulation applies the double privilege once for ${first}`, () => {
    const second = first === 'white' ? 'dark' : 'white';
    const initial = game.initialState('long');
    initial.turn = first;
    initial.phase = 'roll';
    game.applyRoll(initial, [2, 1]);
    const firstAfter = playPreview(initial);
    const originalFlags = clone(firstAfter.firstMoveDone);

    const secondSpecialDouble = prepareReplyState(firstAfter, second, [3, 3], true);
    assertNativeTransition(secondSpecialDouble, realReply(firstAfter, [3, 3, 3, 3]));
    assert.equal(maxHeadRelease(secondSpecialDouble), 2,
      'the other player still has their opening double privilege');
    assert.deepEqual(clone(firstAfter.firstMoveDone), originalFlags,
      'simulating a reply must not mutate the preceding board');

    const secondOrdinary = prepareReplyState(firstAfter, second, [2, 1], true);
    const secondAfter = playPreview(secondOrdinary);
    const recovery = prepareReplyState(secondAfter, first, [3, 3], true);
    const realSecond = realReply(firstAfter, [2, 1]);
    const realRecovery = realReply(playPreview(realSecond), [3, 3, 3, 3]);

    assertNativeTransition(recovery, realRecovery);
    assert.equal(maxHeadRelease(recovery), 1,
      'the original player must not reuse the opening privilege during recovery');
  });
}
