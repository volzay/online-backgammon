'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));

// Exact board and dice from archived D3FM-HS3D bot decision 8. Names, room
// metadata, subsequent rolls, and the rest of the training archive are omitted.
function threatenedStartZoneState() {
  return {
    variant: 'long',
    phase: 'move',
    turn: 'dark',
    dice: [3, 3, 3, 3],
    rolled: [3, 3, 3, 3],
    points: {
      6: { color: 'dark', count: 3 },
      7: { color: 'dark', count: 1 },
      8: { color: 'white', count: 1 },
      9: { color: 'white', count: 1 },
      11: { color: 'white', count: 1 },
      12: { color: 'dark', count: 9 },
      16: { color: 'white', count: 1 },
      17: { color: 'dark', count: 2 },
      20: { color: 'white', count: 1 },
      21: { color: 'white', count: 1 },
      22: { color: 'white', count: 1 },
      24: { color: 'white', count: 8 },
    },
    off: { white: 0, dark: 0 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [],
    history: [],
    headPlayedThisTurn: { white: false, dark: false },
    firstMoveDone: { white: true, dark: true },
    winner: null,
  };
}

function runtime() {
  const context = { window: {}, console, Date, Math, JSON, setTimeout, clearTimeout };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  for (const file of ['game.js', 'long-bot-engine.js', 'strong-bot.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, {
      filename: file,
    });
  }
  return {
    game: context.window.NarduGame,
    engine: context.window.NarduLongBotEngine,
    bot: context.window.NarduStrongBot,
  };
}

function applyLegalTurn(game, source, moves) {
  const after = clone(source);
  for (const move of moves) {
    assert.equal(game.isValidMove(after, move.from, move.die), true);
    assert.ok(game.applyMove(after, move.from, move.die, { autoEnd: false }));
  }
  assert.deepEqual(after.dice, [], 'the selected turn must use all four dice');
  return after;
}

test('D3FM-HS3D live doubles analyze a legal start-zone escape under a developing fence', () => {
  const { game, engine, bot } = runtime();
  const state = threatenedStartZoneState();
  const inStartZone = board => [12, 11, 10, 9, 8, 7]
    .reduce((total, point) => total + (
      board.points[point]?.color === 'dark' ? board.points[point].count : 0
    ), 0);
  const before = inStartZone(state);
  const sampled = game.sampledMoveSequences(clone(state), 'dark', 16);
  assert.ok(sampled.some(sequence => inStartZone(applyLegalTurn(game, state, sequence)) < before),
    'a complete escape turn must be present in the live initial sampler');

  const planned = clone(bot.plan(clone(state), { liveTurnLatencyBudget: true }));
  applyLegalTurn(game, state, planned);
  const decision = clone(engine.consumeLastDecision());

  assert.equal(decision?.source, 'engine');
  assert.equal(decision.experienceSize, 0, 'this fixture isolates the cold analytical policy');
  const analyzedExit = [decision.selected, ...decision.alternatives].find(candidate => (
    Number(candidate.features.startZoneReduction) > 0
    && candidate.tactical?.distributionComplete === true
  ));
  assert.ok(analyzedExit,
    'at least one legal escape must receive complete opponent-roll analysis before a move is chosen');
});

test('live doubles still clear the last start-zone checker when that changes Koks to Mars', () => {
  const { game, engine, bot } = runtime();
  const state = threatenedStartZoneState();
  state.dice = [6, 6, 6, 6];
  state.rolled = [...state.dice];
  state.points = {
    1: { color: 'dark', count: 4 },
    4: { color: 'dark', count: 1 },
    5: { color: 'white', count: 1 },
    10: { color: 'dark', count: 1 },
    15: { color: 'dark', count: 1 },
    18: { color: 'dark', count: 1 },
    21: { color: 'dark', count: 3 },
    23: { color: 'dark', count: 2 },
    24: { color: 'dark', count: 2 },
  };
  state.off.white = 14;

  assert.equal(game.resultTypeFor({ ...state, off: { white: 15, dark: 0 } }, 'white'), 'koks');
  const planned = clone(bot.plan(clone(state), { liveTurnLatencyBudget: true }));
  const after = applyLegalTurn(game, state, planned);
  const decision = clone(engine.consumeLastDecision());
  assert.equal(decision?.source, 'engine');
  assert.equal(decision.selected.features.startZoneAfter, 0);
  assert.equal(game.resultTypeFor({ ...after, off: { white: 15, dark: 0 } }, 'white'), 'mars');
});
