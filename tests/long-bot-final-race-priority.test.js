const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const POLICY = {
  strategyProfile: 'v25',
  maxCandidates: 64,
  analysisNodeBudget: 480,
};

function loadGame() {
  const context = { window: {}, console, Date, Math };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context);
  return context.window.NarduGame;
}

async function loadEngine(game) {
  const [{ createLongBotEngine }, { createNarduGameAdapter }] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'bot-engine/long/engine.ts')).href),
    import(pathToFileURL(path.join(ROOT, 'bot-engine/long/nardu-game-adapter.ts')).href),
  ]);
  return createLongBotEngine(createNarduGameAdapter(game, {
    generatedSequenceFastPath: true,
  }));
}

function raceState(color, opponentPoints) {
  const darkPoints = {
    13: 3, 14: 2, 15: 2, 16: 2, 17: 3, 18: 2, 22: 1,
  };
  const ownPoints = color === 'dark'
    ? darkPoints
    : { 1: 3, 2: 2, 3: 2, 4: 2, 5: 3, 6: 2, 10: 1 };
  const opponent = color === 'dark' ? 'white' : 'dark';
  const points = {};
  for (const [point, count] of Object.entries(ownPoints)) {
    points[point] = { color, count };
  }
  for (const [point, count] of Object.entries(opponentPoints)) {
    assert.equal(points[point], undefined, `point ${point} must be unoccupied`);
    points[point] = { color: opponent, count };
  }
  return {
    variant: 'long', phase: 'move', turn: color,
    dice: [6, 3], rolled: [6, 3], points,
    off: { white: 0, dark: 0 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [], history: [],
    firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false },
    winner: null,
  };
}

function qxkmTurn243State() {
  // Exact board and dice from the archived decision; no player/account data.
  return {
    variant: 'long', phase: 'move', turn: 'dark',
    dice: [6, 3], rolled: [6, 3],
    points: {
      2: { color: 'white', count: 4 },
      3: { color: 'white', count: 2 },
      6: { color: 'white', count: 2 },
      14: { color: 'dark', count: 1 },
      15: { color: 'dark', count: 2 },
      16: { color: 'dark', count: 2 },
      17: { color: 'dark', count: 3 },
      18: { color: 'dark', count: 6 },
      22: { color: 'dark', count: 1 },
    },
    off: { white: 7, dark: 0 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [], history: [],
    firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false },
    winner: null,
  };
}

function f92fLateRaceState() {
  // A second archived loss with the same missed entry-plus-bear-off choice.
  return {
    variant: 'long', phase: 'move', turn: 'dark',
    dice: [1, 4], rolled: [1, 4],
    points: {
      1: { color: 'white', count: 1 },
      2: { color: 'white', count: 1 },
      3: { color: 'white', count: 2 },
      4: { color: 'white', count: 1 },
      13: { color: 'dark', count: 1 },
      14: { color: 'dark', count: 1 },
      15: { color: 'dark', count: 1 },
      16: { color: 'dark', count: 3 },
      17: { color: 'dark', count: 3 },
      18: { color: 'dark', count: 5 },
      20: { color: 'dark', count: 1 },
    },
    off: { white: 10, dark: 0 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [], history: [],
    firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false },
    winner: null,
  };
}

function twoOutsideRaceState(color, opponentPoints) {
  const state = raceState(color, opponentPoints);
  const homePoint = color === 'dark' ? 17 : 5;
  const outsidePoint = color === 'dark' ? 21 : 9;
  state.points[homePoint].count -= 1;
  state.points[outsidePoint] = { color, count: 1 };
  return state;
}

function outsideCount(game, state, color) {
  return Object.entries(state.points).reduce((sum, [point, stack]) => (
    sum + (stack.color === color && game.pathPos(color, Number(point), state) < 18
      ? stack.count : 0)
  ), 0);
}

function homeShuffleCount(game, state, color, sequence) {
  return sequence.filter(move => !move.bearOff
    && game.pathPos(color, move.from, state) >= 18
    && game.pathPos(color, move.to, state) >= 18).length;
}

function legalTurnStats(game, state, color, sequence) {
  const after = JSON.parse(JSON.stringify(state));
  sequence.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));
  return {
    outsideReduction: outsideCount(game, state, color) - outsideCount(game, after, color),
    homeShuffleMoves: homeShuffleCount(game, state, color, sequence),
    offGain: Number(after.off[color] || 0) - Number(state.off[color] || 0),
  };
}

function containsMove(sequence, from, to, die) {
  return sequence.some(move => Number(move.from) === from
    && Number(move.to) === to && Number(move.die) === die);
}

function hasEntryAndBearOff(sequence, color) {
  const outside = color === 'dark' ? 22 : 10;
  const entry = color === 'dark' ? 16 : 4;
  const offSource = color === 'dark' ? 15 : 3;
  return containsMove(sequence, outside, entry, 6)
    && containsMove(sequence, offSource, 0, 3);
}

function hasDelayedBearOff(sequence, color) {
  const outside = color === 'dark' ? 22 : 10;
  const staging = color === 'dark' ? 19 : 7;
  const home = color === 'dark' ? 13 : 1;
  return containsMove(sequence, outside, staging, 3)
    && containsMove(sequence, staging, home, 6);
}

for (const [color, opponentPoints] of [
  ['dark', { 1: 15 }],
  ['white', { 13: 15 }],
]) {
  test(`${color} clear final race uses 6:3 to enter the last checker and bear off`, async () => {
    const game = loadGame();
    const state = raceState(color, opponentPoints);
    const opponent = color === 'dark' ? 'white' : 'dark';
    const legal = game.bestMoveSequences(state, color);
    const engine = await loadEngine(game);
    const ranked = engine.rank(state, color, POLICY);

    assert.equal(game.homeReady(state, color), false);
    assert.equal(game.homeReady(state, opponent), true);
    assert.equal(Object.values(state.points)
      .filter(stack => stack.color === color)
      .reduce((sum, stack) => sum + stack.count, 0), 15);
    assert.ok(legal.some(sequence => hasEntryAndBearOff(sequence, color)),
      'native rules allow entering the last checker, then bearing off');
    assert.ok(legal.some(sequence => hasDelayedBearOff(sequence, color)),
      'the delayed bear-off remains a legal alternative');
    assert.equal(ranked[0].features.outsideReduction, 1);
    assert.equal(ranked[0].features.offGain, 1,
      JSON.stringify(ranked[0].sequence));
    assert.ok(hasEntryAndBearOff(ranked[0].sequence, color),
      JSON.stringify(ranked[0].sequence));
  });
}

test('QXKM-SV6C turn 243 enters the last checker and bears off with 6:3', async () => {
  const game = loadGame();
  const state = qxkmTurn243State();
  const legal = game.bestMoveSequences(state, 'dark');
  const engine = await loadEngine(game);
  const selected = engine.rank(state, 'dark', POLICY)[0];

  assert.equal(outsideCount(game, state, 'dark'), 1);
  assert.equal(game.homeReady(state, 'dark'), false);
  assert.equal(game.homeReady(state, 'white'), true);
  assert.equal(Object.values(state.points)
    .filter(stack => stack.color === 'dark')
    .reduce((total, stack) => total + stack.count, 0), 15);
  assert.equal(Object.values(state.points)
    .filter(stack => stack.color === 'white')
    .reduce((total, stack) => total + stack.count, 0) + state.off.white, 15);
  assert.ok(legal.some(sequence => hasEntryAndBearOff(sequence, 'dark')),
    'native rules allow 22→16 (die 6), then 15→off (die 3)');
  assert.ok(legal.some(sequence => hasDelayedBearOff(sequence, 'dark')),
    'the archived 22→19→13 turn is also legal');
  assert.equal(selected.features.outsideReduction, 1);
  assert.equal(selected.features.offGain, 1,
    JSON.stringify(selected.sequence));
  assert.ok(hasEntryAndBearOff(selected.sequence, 'dark'),
    JSON.stringify(selected.sequence));
});

test('F92F-Q6PZ final race enters and bears off instead of staging at point 19', async () => {
  const game = loadGame();
  const state = f92fLateRaceState();
  const legal = game.bestMoveSequences(state, 'dark');
  const engine = await loadEngine(game);
  const selected = engine.rank(state, 'dark', POLICY)[0];
  const direct = sequence => containsMove(sequence, 20, 16, 4)
    && containsMove(sequence, 13, 0, 1);
  const staged = sequence => containsMove(sequence, 20, 19, 1)
    && containsMove(sequence, 19, 15, 4);

  assert.equal(outsideCount(game, state, 'dark'), 1);
  assert.equal(game.homeReady(state, 'white'), true);
  assert.ok(legal.some(direct), '20→16 and 13→off is a legal complete turn');
  assert.ok(legal.some(staged), 'the archived staging turn is also legal');
  assert.equal(selected.features.outsideReduction, 1);
  assert.equal(selected.features.offGain, 1,
    JSON.stringify(selected.sequence));
  assert.ok(direct(selected.sequence), JSON.stringify(selected.sequence));
});

for (const [color, opponentPoints] of [
  ['dark', { 1: 15 }],
  ['white', { 13: 15 }],
]) {
  test(`${color} clear race enters the maximum checkers before shuffling at home`, async () => {
    const game = loadGame();
    const state = twoOutsideRaceState(color, opponentPoints);
    const legal = game.bestMoveSequences(state, color);
    const stats = legal.map(sequence => legalTurnStats(game, state, color, sequence));
    const engine = await loadEngine(game);
    const selected = engine.rank(state, color, POLICY)[0];
    const maxEntry = Math.max(...stats.map(item => item.outsideReduction));
    const minShuffleAtMaxEntry = Math.min(...stats
      .filter(item => item.outsideReduction === maxEntry)
      .map(item => item.homeShuffleMoves));

    assert.equal(outsideCount(game, state, color), 2);
    assert.ok(legal.length > 0 && legal.every(sequence => sequence.length === 2),
      'the native rule set has complete two-die turns');
    assert.ok(stats.every(item => item.offGain === 0),
      'bearing off is not yet legal because two checkers begin outside home');
    assert.equal(maxEntry, 2);
    assert.equal(minShuffleAtMaxEntry, 0);
    assert.ok(stats.some(item => item.outsideReduction < maxEntry
      && item.homeShuffleMoves > 0),
    'a home-shuffling alternative must remain legal');
    assert.equal(selected.features.outsideReduction, maxEntry,
      JSON.stringify(selected.sequence));
    assert.equal(selected.features.homeShuffleMoves, minShuffleAtMaxEntry,
      JSON.stringify(selected.sequence));
  });
}

test('contact position does not force the clear-race bear-off policy', async () => {
  const game = loadGame();
  const state = raceState('dark', { 1: 14, 20: 1 });
  const legal = game.bestMoveSequences(state, 'dark');
  const engine = await loadEngine(game);
  const ranked = engine.rank(state, 'dark', POLICY);

  assert.equal(game.homeReady(state, 'white'), false);
  assert.ok(legal.some(sequence => hasEntryAndBearOff(sequence, 'dark')),
    'the immediate bear-off remains legal under contact');
  assert.ok(hasDelayedBearOff(ranked[0].sequence, 'dark'),
    'a live opponent checker on the route keeps the tactical choice available');
  assert.equal(ranked[0].features.offGain, 0);
});
