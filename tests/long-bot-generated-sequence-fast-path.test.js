const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

function loadGame() {
  const context = { window: {}, console, Date, Math, JSON };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context, {
    filename: 'game.js',
  });
  return context.window.NarduGame;
}

function longState(points, overrides = {}) {
  return {
    variant: 'long',
    phase: 'move',
    turn: 'dark',
    dice: [2, 3],
    rolled: [2, 3],
    points,
    off: { white: 0, dark: 0 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [],
    history: [{ color: 'white', from: 24, to: 20, die: 4, at: 'existing' }],
    headPlayedThisTurn: { white: false, dark: false },
    firstMoveDone: { white: true, dark: true },
    winner: null,
    resultType: null,
    ...overrides,
  };
}

function comparableState(state) {
  return JSON.parse(JSON.stringify({
    variant: state.variant,
    phase: state.phase,
    turn: state.turn,
    dice: state.dice,
    rolled: state.rolled,
    points: state.points,
    off: state.off,
    bar: state.bar,
    score: state.score,
    turnMoves: state.turnMoves,
    headPlayedThisTurn: state.headPlayedThisTurn,
    firstMoveDone: state.firstMoveDone,
    winner: state.winner,
    resultType: state.resultType,
    history: (state.history || []).map(({ at: _at, ...entry }) => entry),
  }));
}

function representativeStates() {
  return [
    longState({
      12: { color: 'dark', count: 15 },
      24: { color: 'white', count: 15 },
    }, {
      dice: [4, 4, 4, 4],
      rolled: [4, 4, 4, 4],
      firstMoveDone: { white: true, dark: false },
    }),
    longState({
      3: { color: 'dark', count: 1 },
      4: { color: 'white', count: 1 },
      5: { color: 'dark', count: 1 },
      6: { color: 'dark', count: 3 },
      7: { color: 'dark', count: 1 },
      8: { color: 'dark', count: 1 },
      9: { color: 'dark', count: 1 },
      10: { color: 'white', count: 3 },
      13: { color: 'white', count: 1 },
      14: { color: 'white', count: 2 },
      15: { color: 'white', count: 2 },
      16: { color: 'white', count: 1 },
      17: { color: 'dark', count: 3 },
      18: { color: 'white', count: 1 },
      19: { color: 'white', count: 1 },
      21: { color: 'dark', count: 1 },
      22: { color: 'dark', count: 1 },
      23: { color: 'dark', count: 2 },
      24: { color: 'white', count: 3 },
    }, {
      dice: [1, 1, 1, 1],
      rolled: [1, 1, 1, 1],
    }),
    longState({
      1: { color: 'white', count: 2 },
      2: { color: 'white', count: 2 },
      3: { color: 'white', count: 2 },
      4: { color: 'white', count: 3 },
      5: { color: 'white', count: 3 },
      6: { color: 'white', count: 3 },
      13: { color: 'dark', count: 3 },
      14: { color: 'dark', count: 3 },
      15: { color: 'dark', count: 3 },
      16: { color: 'dark', count: 2 },
      17: { color: 'dark', count: 2 },
      18: { color: 'dark', count: 2 },
    }, {
      dice: [6, 5],
      rolled: [6, 5],
    }),
  ];
}

test('generated long sequence fast path is rules- and ledger-equivalent to applyMove', async () => {
  const game = loadGame();
  const adapterModule = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/nardu-game-adapter.ts'),
  ).href);
  const adapter = adapterModule.createNarduGameAdapter(game, {
    generatedSequenceFastPath: true,
  });

  for (const [stateIndex, state] of representativeStates().entries()) {
    const original = JSON.parse(JSON.stringify(state));
    const sequences = game.sampledMoveSequences(state, state.turn, 16).slice(0, 8);
    assert.ok(sequences.length > 0, `state ${stateIndex} must expose legal sequences`);

    for (const [sequenceIndex, sequence] of sequences.entries()) {
      const expected = JSON.parse(JSON.stringify(state));
      sequence.forEach(move => {
        assert.equal(
          game.applyMove(expected, move.from, move.die, { autoEnd: false }),
          true,
        );
      });

      const regularApplyMove = game.applyMove;
      game.applyMove = () => {
        throw new Error('adapter fell back to recursive applyMove');
      };
      let actual;
      try {
        actual = adapter.applySequence(state, sequence, state.turn);
      } finally {
        game.applyMove = regularApplyMove;
      }

      assert.deepEqual(
        comparableState(actual),
        comparableState(expected),
        `state ${stateIndex}, sequence ${sequenceIndex}`,
      );
      assert.deepEqual(state, original, 'preview must not mutate its source state');
    }
  }
});

test('generated long sequence fast path rejects a forged continuation', async () => {
  const game = loadGame();
  const adapterModule = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/nardu-game-adapter.ts'),
  ).href);
  const adapter = adapterModule.createNarduGameAdapter(game, {
    generatedSequenceFastPath: true,
  });
  const state = representativeStates()[0];
  const original = JSON.parse(JSON.stringify(state));
  const forged = [{ from: 12, to: 8, die: 4, bearOff: false }];
  const regularApplyMove = game.applyMove;
  let legacyCalls = 0;
  game.applyMove = () => { legacyCalls += 1; return false; };
  try {
    assert.throws(
      () => adapter.applySequence(state, forged, 'white'),
      /failed native validation/,
    );
    assert.throws(
      () => adapter.applySequence(state, [
        ...forged,
        { from: 24, to: 20, die: 4, bearOff: false },
      ], 'dark'),
      /failed native validation/,
    );
  } finally {
    game.applyMove = regularApplyMove;
  }
  assert.equal(legacyCalls, 0, 'invalid native sequences must not fall back to partial application');
  assert.deepEqual(state, original, 'invalid preview must leave its source state unchanged');
});
