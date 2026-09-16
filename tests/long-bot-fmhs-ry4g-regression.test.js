const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const ENGINE_SOURCES = [
  'bot-engine/long/metrics.ts',
  'bot-engine/long/evaluator.ts',
  'bot-engine/long/analysis.ts',
  'bot-engine/long/engine.ts',
  'bot-engine/long/nardu-game-adapter.ts',
  'bot-engine/long/browser.ts',
];
let cachedRuntime;

function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+type[\s\S]*?;\s*$/gm, '')
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(const|function|class))/gm, '')
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, '');
}

function runtime() {
  if (cachedRuntime) return cachedRuntime;
  const body = ENGINE_SOURCES.map(file => stripModuleSyntax(
    fs.readFileSync(path.join(ROOT, file), 'utf8'),
  )).join('\n');
  const context = { window: {}, console, Date, Math, setTimeout, clearTimeout };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context);
  vm.runInContext(`(function () { 'use strict'; ${body} }());`, context);
  cachedRuntime = {
    engine: context.window.NarduLongBotEngine,
    game: context.window.NarduGame,
  };
  return cachedRuntime;
}

function state(points, dice, off = { white: 0, dark: 0 }) {
  return {
    variant: 'long',
    phase: 'move',
    turn: 'dark',
    dice: [...dice],
    rolled: [...dice],
    points,
    off,
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [],
    history: [],
    headPlayedThisTurn: { white: false, dark: false },
    firstMoveDone: { white: true, dark: true },
  };
}

function rank(gameState, source) {
  const target = runtime().engine;
  target.setExperience([], source);
  return target.rank(gameState, {
    strategyProfile: 'v25',
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
}

function hasMove(candidate, from, to, die) {
  return candidate.sequence.some(move => (
    move.from === from && move.to === to && move.die === die
  ));
}

function hasSequence(candidate, expected) {
  return expected.every(move => hasMove(candidate, move.from, move.to, move.die));
}

function sequenceLabel(candidate) {
  return candidate.sequence
    .map(move => `${move.from}>${move.to}/${move.die}`)
    .join(',');
}

function assertClosingMoveBlocked(candidate, anchor, from, die) {
  const occupant = candidate.after.points[anchor];
  assert.equal(occupant?.color, 'dark');
  assert.ok(occupant.count >= 1);

  const reply = JSON.parse(JSON.stringify(candidate.after));
  reply.turn = 'white';
  reply.phase = 'move';
  reply.dice = [die];
  reply.rolled = [die];
  reply.turnMoves = [];
  reply.headPlayedThisTurn = { white: false, dark: false };
  reply.firstMoveDone = { white: true, dark: true };
  assert.equal(
    runtime().game.applyMove(reply, from, die, { autoEnd: false }),
    false,
    `white ${from}>${anchor}/${die} must be blocked by the preserved dark point`,
  );
}

const FMHS_TURN_3 = {
  6: { color: 'dark', count: 1 },
  7: { color: 'dark', count: 1 },
  11: { color: 'white', count: 1 },
  12: { color: 'dark', count: 13 },
  13: { color: 'white', count: 1 },
  18: { color: 'white', count: 1 },
  19: { color: 'white', count: 1 },
  24: { color: 'white', count: 11 },
};

const FMHS_TURN_8 = {
  1: { color: 'dark', count: 1 },
  3: { color: 'dark', count: 1 },
  6: { color: 'white', count: 1 },
  7: { color: 'dark', count: 1 },
  9: { color: 'dark', count: 1 },
  10: { color: 'white', count: 1 },
  11: { color: 'white', count: 1 },
  12: { color: 'dark', count: 10 },
  15: { color: 'white', count: 1 },
  19: { color: 'white', count: 1 },
  20: { color: 'white', count: 1 },
  21: { color: 'white', count: 2 },
  22: { color: 'white', count: 1 },
  23: { color: 'dark', count: 1 },
  24: { color: 'white', count: 6 },
};

const FMHS_TURN_10 = {
  3: { color: 'dark', count: 1 },
  6: { color: 'white', count: 1 },
  8: { color: 'dark', count: 1 },
  9: { color: 'white', count: 1 },
  10: { color: 'white', count: 2 },
  11: { color: 'white', count: 1 },
  12: { color: 'dark', count: 10 },
  19: { color: 'white', count: 1 },
  20: { color: 'white', count: 2 },
  21: { color: 'white', count: 2 },
  22: { color: 'white', count: 1 },
  23: { color: 'dark', count: 3 },
  24: { color: 'white', count: 4 },
};

const RY4G_TURN_7 = {
  5: { color: 'dark', count: 1 },
  6: { color: 'dark', count: 1 },
  7: { color: 'white', count: 1 },
  9: { color: 'dark', count: 1 },
  10: { color: 'white', count: 1 },
  11: { color: 'dark', count: 1 },
  12: { color: 'dark', count: 10 },
  13: { color: 'dark', count: 1 },
  16: { color: 'white', count: 1 },
  19: { color: 'white', count: 1 },
  21: { color: 'white', count: 1 },
  22: { color: 'white', count: 2 },
  23: { color: 'white', count: 1 },
  24: { color: 'white', count: 7 },
};

const RY4G_TURN_38 = {
  1: { color: 'white', count: 2 },
  2: { color: 'white', count: 1 },
  3: { color: 'white', count: 1 },
  4: { color: 'white', count: 1 },
  5: { color: 'white', count: 1 },
  6: { color: 'white', count: 5 },
  9: { color: 'dark', count: 1 },
  10: { color: 'dark', count: 2 },
  11: { color: 'dark', count: 1 },
  13: { color: 'dark', count: 4 },
  14: { color: 'dark', count: 3 },
  15: { color: 'dark', count: 3 },
  16: { color: 'dark', count: 1 },
};

test('FMHS-H7GU turn 3 occupies point 8 before white can extend the fence', () => {
  const safeMoves = [
    { from: 12, to: 8, die: 4 },
    { from: 6, to: 1, die: 5 },
  ];
  const ranked = rank(state(FMHS_TURN_3, [5, 4]), 'fmhs-t3-cold');
  const safe = ranked.find(candidate => hasSequence(candidate, safeMoves));

  assert.ok(safe, 'the point-8 preserving candidate must be legal');
  assertClosingMoveBlocked(safe, 8, 13, 5);
  assert.ok(hasSequence(ranked[0], safeMoves), `selected ${sequenceLabel(ranked[0])}`);
});

test('FMHS-H7GU turn 8 keeps point 9 closed against the later 14-to-9 move', () => {
  const safeMoves = [
    { from: 1, to: 23, die: 2 },
    { from: 3, to: 2, die: 1 },
  ];
  const ranked = rank(state(FMHS_TURN_8, [1, 2]), 'fmhs-t8-cold');
  const safe = ranked.find(candidate => hasSequence(candidate, safeMoves));

  assert.ok(safe, 'the point-9 preserving candidate must be legal');
  assertClosingMoveBlocked(safe, 9, 14, 5);
  assert.ok(hasSequence(ranked[0], safeMoves), `selected ${sequenceLabel(ranked[0])}`);
});

test('FMHS-H7GU turn 10 rejects a move dominated in every four-ply safety metric', async () => {
  const { hasBoundedFourPlyTactical } = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/engine.ts'),
  ).href);
  const safeMoves = [
    { from: 12, to: 7, die: 5 },
    { from: 8, to: 7, die: 1 },
  ];
  const unsafeMoves = [
    { from: 3, to: 2, die: 1 },
    { from: 12, to: 7, die: 5 },
  ];
  const ranked = rank(state(FMHS_TURN_10, [5, 1]), 'fmhs-t10-cold');
  const safe = ranked.find(candidate => hasSequence(candidate, safeMoves));
  const unsafe = ranked.find(candidate => hasSequence(candidate, unsafeMoves));

  assert.ok(safe, 'the point-3 preserving candidate must be legal');
  assert.ok(unsafe, 'the archived point-3 break must remain measurable');
  assert.equal(hasBoundedFourPlyTactical(safe), true);
  assert.equal(hasBoundedFourPlyTactical(unsafe), true);
  [
    'expectedImpact',
    'worstImpact',
    'recoveryExpected',
    'recoveryWorst',
    'recoveryTailRisk',
    'continuationExpected',
    'continuationWorst',
    'continuationTailRisk',
  ].forEach(metric => {
    assert.ok(
      safe.tactical[metric] > unsafe.tactical[metric],
      `${metric}: safe=${safe.tactical[metric]} unsafe=${unsafe.tactical[metric]}`,
    );
  });
  // The representative+worst model exposes a rare catastrophic recovery board
  // for BOTH moves. Its worst gap is no longer the optimistic single-frontier
  // 2B value; preserve strict dominance in all eight metrics, including tails.
  assert.ok(safe.tactical.continuationTailRisk - unsafe.tactical.continuationTailRisk > 1_500_000_000);
  assert.equal(safe.after.points[3]?.color, 'dark');
  assert.ok(hasSequence(ranked[0], safeMoves), `selected ${sequenceLabel(ranked[0])}`);
});

test('RY4G-T4EB turn 7 keeps point 5 closed against the decisive 9-to-5 move', () => {
  const safeMoves = [
    { from: 6, to: 4, die: 2 },
    { from: 12, to: 6, die: 6 },
  ];
  const ranked = rank(state(RY4G_TURN_7, [2, 6]), 'ry4g-t7-cold');
  const safe = ranked.find(candidate => hasSequence(candidate, safeMoves));

  assert.ok(safe, 'the point-5 preserving candidate must be legal');
  assertClosingMoveBlocked(safe, 5, 9, 4);
  assert.ok(hasSequence(ranked[0], safeMoves), `selected ${sequenceLabel(ranked[0])}`);
});

test('RY4G-T4EB turn 38 does not override a tactically dominant recovery', () => {
  const safeMoves = [{ from: 11, to: 9, die: 2 }];
  const unsafeMoves = [{ from: 9, to: 7, die: 2 }];
  const ranked = rank(
    state(RY4G_TURN_38, [2, 5], { white: 4, dark: 0 }),
    'ry4g-t38-cold',
  );
  const safe = ranked.find(candidate => hasSequence(candidate, safeMoves));
  const unsafe = ranked.find(candidate => hasSequence(candidate, unsafeMoves));

  assert.ok(safe, 'the 11-to-9 recovery must be legal');
  assert.ok(unsafe, 'the archived 9-to-7 move must remain measurable');
  assert.ok(safe.tactical.expectedImpact >= unsafe.tactical.expectedImpact);
  assert.ok(safe.tactical.worstImpact >= unsafe.tactical.worstImpact);
  assert.ok(
    safe.tactical.recoveryExpected - unsafe.tactical.recoveryExpected > 35_000_000,
  );
  assert.ok(
    safe.tactical.recoveryWorst - unsafe.tactical.recoveryWorst > 90_000_000,
  );
  assert.ok(
    safe.tactical.recoveryTailRisk >= unsafe.tactical.recoveryTailRisk - 25_000_000,
  );
  assert.ok(hasSequence(ranked[0], safeMoves), `selected ${sequenceLabel(ranked[0])}`);
});
