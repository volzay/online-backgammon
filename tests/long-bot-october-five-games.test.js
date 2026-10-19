'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRuntime } = require('../scripts/generate-long-bot-shadow-replay');

function board(game, white, dark, dice) {
  const state = game.initialState('long');
  Object.assign(state, { phase: 'move', turn: 'dark', points: {}, dice: [...dice], rolled: [...dice],
    firstMoveDone: { white: true, dark: true }, headPlayedThisTurn: { white: false, dark: false } });
  for (const [color, stacks] of [['white', white], ['dark', dark]]) {
    for (const [point, count] of stacks) state.points[point] = { color, count };
  }
  return state;
}
function reflected(state) {
  const other = c => c === 'white' ? 'dark' : 'white';
  return { ...state, turn: other(state.turn),
    points: Object.fromEntries(Object.entries(state.points).map(([point, stack]) =>
      [((Number(point) + 11) % 24) + 1, { color: other(stack.color), count: stack.count }])) };
}

test('YWVG decision 12 actually compares the head-release alternative with complete primary analysis', () => {
  const { game, engine } = loadRuntime();
  const source = board(game,
    [[9,2],[10,1],[13,1],[14,1],[16,1],[19,1],[20,2],[22,1],[24,5]],
    [[4,1],[6,1],[7,1],[8,1],[11,1],[12,6],[18,1],[21,2],[23,1]], [1,3]);
  for (const state of [source, reflected(source)]) {
    const candidates = engine.rank(state, engine.productionOptions);
    const exit = candidates.find(candidate => candidate.features.headGain > 0);
    assert.ok(exit, 'an important escape alternative must not disappear from the tactical beam');
    assert.equal(exit.tactical.distributionComplete, true);
    assert.equal(exit.tactical.distributionWeight, 36);
    assert.equal(exit.tactical.plies, 4);
    assert.ok(exit.features.analysisNodesUsed <= 480);
  }
});

test('88AV decision 29 cannot enter home with 1:2; every exterior-progress alternative breaks an active prime', () => {
  const { game, engine } = loadRuntime();
  const source = board(game, [[6,8],[7,3],[8,1],[11,1],[13,1],[14,1]],
    [[1,1],[2,1],[3,1],[4,1],[5,1],[15,3],[17,5],[18,2]], [1,2]);
  for (const state of [source, reflected(source)]) {
    const sequences = game.bestMoveSequences(state, state.turn);
    assert.equal(sequences.length, 92);
    let advancing = 0;
    for (const sequence of sequences) {
      const described = engine.describeSequence(state, sequence, { color: state.turn, strategyProfile: 'v25' });
      assert.equal(described.features.outsideReduction, 0);
      if (described.features.outsidePipGain > 0) {
        advancing++;
        assert.ok(described.features.primeRunAfter < 5);
      }
    }
    assert.ok(advancing > 0);
  }
});

test('YWVG decision 30 has one legal resulting board: the late home shuffle is forced by the blockade', () => {
  const { game, engine } = loadRuntime();
  const source = board(game, [[1,6],[2,3],[3,1],[4,1],[5,1],[8,1],[9,1],[24,1]],
    [[6,7],[13,5],[15,3]], [2,1]);
  for (const state of [source, reflected(source)]) {
    const candidates = engine.rank(state, engine.productionOptions);
    assert.equal(candidates[0].features.choiceCount, 1);
    assert.equal(candidates[0].features.homeShuffleMoves, 2);
    assert.equal(candidates[0].features.outsidePipGain, 0);
  }
});
