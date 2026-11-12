'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderLongBotBundle } = require('../scripts/build-long-bot-engine');

const ROOT = path.resolve(__dirname, '..');
const context = vm.createContext({ window: {}, Date, Math, console });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context);
const bundle = renderLongBotBundle().replace(/\n\}\(\)\);\n$/, `
  window.fenceReplyTest = {
    analyzeOpponentReplies, createAnalysisBudget, createNarduGameAdapter,
    findFenceExtensionReply, hasDevelopingReplyFence, mergeWeights,
    opponentFenceRun, prepareReplyState, sampledSequenceResults,
  };
}());
`);
vm.runInContext(bundle, context);
const { NarduGame: game, fenceReplyTest: helpers } = context.window;
const adapter = helpers.createNarduGameAdapter(game, { generatedSequenceFastPath: true });

function developingFence() {
  // Produced by legal maximum-use turns from an ordinary long-game opening.
  // White can extend a four-point fence before the dark head on a 3–2 roll.
  const dark = { 1: 1, 11: 2, 12: 11, 15: 1 };
  const white = { 8: 1, 17: 1, 19: 1, 20: 1, 23: 1, 24: 10 };
  const points = Object.fromEntries([
    ...Object.entries(dark).map(([point, count]) => [point, { color: 'dark', count }]),
    ...Object.entries(white).map(([point, count]) => [point, { color: 'white', count }]),
  ]);
  return {
    ...game.initialState('long'),
    turn: 'dark',
    phase: 'move',
    points,
    firstMoveDone: { dark: true, white: true },
  };
}

test('a legal fence extension omitted by the leading two replies gets one additional slot', () => {
  const state = developingFence();
  assert.equal(helpers.hasDevelopingReplyFence(state, 'dark'), true);
  const replyState = helpers.prepareReplyState(state, 'white', [3, 2], true);
  const legal = adapter.legalSequences(replyState, 'white', { limit: 18 });
  const leading = helpers.sampledSequenceResults(adapter, replyState, 'white', legal, 2, { preferLeading: true });
  assert.equal(leading.length, 2);
  assert.equal(Math.max(...leading.map(reply => helpers.opponentFenceRun(reply.after, 'dark'))), 3);

  const reserved = helpers.findFenceExtensionReply(adapter, replyState, 'dark', 'white', legal, leading);
  assert.ok(reserved);
  assert.ok(legal.includes(reserved.sequence));
  assert.ok(!leading.some(reply => reply.sequence === reserved.sequence));
  assert.equal(helpers.opponentFenceRun(reserved.after, 'dark'), 4);

  const replay = structuredClone(replyState);
  for (const { from, die } of reserved.sequence) {
    assert.equal(game.applyMove(replay, from, die, { autoEnd: false }), true);
  }
  assert.equal(game.hasAnyMoves(replay), false);
  assert.equal(helpers.opponentFenceRun(replay, 'dark'), 4);
  assert.equal(helpers.findFenceExtensionReply(
    adapter, replyState, 'dark', 'white', legal, [leading[0], reserved],
  ), null, 'an already represented extension does not need a third reply');
});

test('primary coverage still completes the same 21 roll classes with the same node budget', () => {
  const [current, legacy] = [true, false].map(expandDoubles => {
    const budget = helpers.createAnalysisBudget(21);
    const [candidate] = helpers.analyzeOpponentReplies(
      adapter, 'dark', [{ after: developingFence(), score: 0, features: {} }],
      helpers.mergeWeights(), budget, { expandDoubles },
    );
    assert.equal(budget.used, 21);
    assert.equal(candidate.tactical.rolls, 21);
    assert.equal(candidate.tactical.distributionWeight, 36);
    assert.equal(candidate.tactical.distributionComplete, true);
    return candidate;
  });
  assert.ok(current.tactical.fenceExtensionReplyWeight >= 2, 'the omitted 3–2 reply is counted at weight two');
  assert.equal(legacy.tactical.fenceExtensionReplyWeight, undefined);

  const movedRear = developingFence();
  movedRear.points[15].count += movedRear.points[11].count + movedRear.points[12].count;
  delete movedRear.points[11];
  delete movedRear.points[12];
  assert.equal(helpers.hasDevelopingReplyFence(movedRear, 'dark'), false);
});
