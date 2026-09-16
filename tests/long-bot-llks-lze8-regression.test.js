const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const ENGINE_SOURCES = [
  "bot-engine/long/metrics.ts",
  "bot-engine/long/evaluator.ts",
  "bot-engine/long/analysis.ts",
  "bot-engine/long/engine.ts",
  "bot-engine/long/nardu-game-adapter.ts",
  "bot-engine/long/browser.ts",
];

let cachedEngine = null;

function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+type[\s\S]*?;\s*$/gm, "")
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/gm, "")
    .replace(/^export\s+(?=(const|function|class))/gm, "")
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, "");
}

function loadEngine() {
  if (cachedEngine) return cachedEngine;
  const body = ENGINE_SOURCES.map(file => stripModuleSyntax(
    fs.readFileSync(path.join(ROOT, file), "utf8"),
  )).join("\n");
  const context = {
    window: {},
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), context);
  vm.runInContext(`(function () { 'use strict'; ${body} }());`, context);
  cachedEngine = context.window.NarduLongBotEngine;
  return cachedEngine;
}

function roomState(points, dice) {
  return {
    variant: "long",
    phase: "move",
    turn: "dark",
    dice,
    rolled: dice,
    points,
    off: { white: 0, dark: 0 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [],
    history: [],
    headPlayedThisTurn: { white: false, dark: false },
    firstMoveDone: { white: true, dark: true },
  };
}

function rankFixture(points, dice) {
  const engine = loadEngine();
  engine.setExperience([], "llks-lze8-regression");
  return engine.rank(roomState(points, dice), {
    strategyProfile: "v25",
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
}

function moveKey(move) {
  return `${move.from}:${move.to}:${move.die}`;
}

function hasSequence(candidate, expected) {
  return candidate.sequence.length === expected.length
    && candidate.sequence.map(moveKey).sort().join("|")
      === expected.map(moveKey).sort().join("|");
}

function sequenceLabel(candidate) {
  return candidate.sequence.map(moveKey).join(", ");
}

function candidateFor(ranked, expected) {
  const candidate = ranked.find(entry => hasSequence(entry, expected));
  assert.ok(candidate, `candidate ${expected.map(moveKey).join(", ")} must be legal`);
  return candidate;
}

const LLKS_RUSC_TURN_5 = {
  2: { color: "dark", count: 2 },
  10: { color: "white", count: 1 },
  12: { color: "dark", count: 11 },
  13: { color: "white", count: 1 },
  18: { color: "white", count: 1 },
  20: { color: "dark", count: 1 },
  21: { color: "white", count: 1 },
  22: { color: "white", count: 1 },
  23: { color: "dark", count: 1 },
  24: { color: "white", count: 10 },
};

const LLKS_RUSC_TURN_3 = {
  6: { color: "dark", count: 1 },
  12: { color: "dark", count: 13 },
  13: { color: "white", count: 1 },
  21: { color: "white", count: 1 },
  22: { color: "white", count: 1 },
  23: { color: "dark", count: 1 },
  24: { color: "white", count: 12 },
};

const LZE8_Z538_TURN_10 = {
  2: { color: "dark", count: 1 },
  4: { color: "white", count: 1 },
  5: { color: "dark", count: 1 },
  6: { color: "dark", count: 1 },
  7: { color: "dark", count: 1 },
  8: { color: "dark", count: 1 },
  9: { color: "white", count: 1 },
  10: { color: "white", count: 1 },
  12: { color: "dark", count: 7 },
  15: { color: "white", count: 1 },
  16: { color: "white", count: 1 },
  19: { color: "dark", count: 1 },
  20: { color: "dark", count: 1 },
  21: { color: "white", count: 1 },
  22: { color: "white", count: 1 },
  23: { color: "dark", count: 1 },
  24: { color: "white", count: 8 },
};

const LZE8_Z538_TURN_15 = {
  3: { color: "white", count: 1 },
  4: { color: "white", count: 1 },
  5: { color: "dark", count: 3 },
  6: { color: "dark", count: 1 },
  7: { color: "dark", count: 1 },
  8: { color: "dark", count: 1 },
  9: { color: "white", count: 1 },
  10: { color: "white", count: 1 },
  11: { color: "dark", count: 1 },
  12: { color: "dark", count: 4 },
  13: { color: "white", count: 2 },
  16: { color: "white", count: 1 },
  17: { color: "dark", count: 2 },
  18: { color: "white", count: 1 },
  19: { color: "white", count: 1 },
  20: { color: "dark", count: 1 },
  21: { color: "white", count: 1 },
  22: { color: "white", count: 1 },
  23: { color: "dark", count: 1 },
  24: { color: "white", count: 4 },
};

const LZE8_Z538_TURN_21 = {
  1: { color: "dark", count: 2 },
  2: { color: "white", count: 1 },
  3: { color: "white", count: 1 },
  4: { color: "white", count: 1 },
  5: { color: "dark", count: 1 },
  6: { color: "dark", count: 3 },
  7: { color: "dark", count: 1 },
  8: { color: "dark", count: 2 },
  9: { color: "white", count: 1 },
  11: { color: "white", count: 1 },
  13: { color: "white", count: 1 },
  14: { color: "white", count: 1 },
  15: { color: "white", count: 1 },
  16: { color: "white", count: 1 },
  17: { color: "dark", count: 3 },
  18: { color: "white", count: 2 },
  19: { color: "white", count: 1 },
  20: { color: "dark", count: 1 },
  21: { color: "white", count: 1 },
  22: { color: "white", count: 1 },
  23: { color: "dark", count: 2 },
  24: { color: "white", count: 1 },
};

test("LLKS-RUSC turn 5 is not hindsight-overfit to the later Koks result", () => {
  const ranked = rankFixture(LLKS_RUSC_TURN_5, [5, 1]);
  const supportedMoves = [
    { from: 20, to: 19, die: 1 },
    { from: 12, to: 7, die: 5 },
  ];
  const hindsightMoves = [
    { from: 2, to: 1, die: 1 },
    { from: 12, to: 7, die: 5 },
  ];
  const selected = ranked[0];
  const alternative = candidateFor(ranked, hindsightMoves);

  assert.ok(hasSequence(selected, supportedMoves), `selected ${sequenceLabel(selected)}`);
  assert.notEqual(selected.features.contestedOpponentHeadExit, 1);
  assert.ok(selected.tactical.continuationExpected >= alternative.tactical.continuationExpected + 15000000);
  assert.equal(selected.tactical.continuationWorstFrontierIncluded, true);
  assert.equal(alternative.tactical.continuationWorstFrontierIncluded, true);
  // continuationWorst now includes the continuation of the rare worst
  // recovery branch. Compare the complete recovery+continuation envelope,
  // rather than treating that fourth-ply sample as an independent path.
  assert.ok(
    selected.tactical.recoveryWorst + selected.tactical.continuationWorst
      >= alternative.tactical.recoveryWorst + alternative.tactical.continuationWorst
        + 100000000,
  );
});

test("LLKS-RUSC turn 3 gives beam and telemetry slots to distinct boards", () => {
  const engine = loadEngine();
  const state = roomState(LLKS_RUSC_TURN_3, [5, 5, 5, 5]);
  engine.setExperience([], "llks-turn-3-dedup");
  const ranked = engine.rank(state, {
    strategyProfile: "v25",
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
  const resultingPosition = candidate => Object.entries(candidate.after.points || {})
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([point, stack]) => `${point}:${stack.color}:${stack.count}`)
    .join("|");

  assert.equal(ranked[0].features.choiceCount, 5);
  assert.equal(new Set(ranked.map(resultingPosition)).size, ranked.length);

  engine.plan(state, {
    strategyProfile: "v25",
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
  const decision = engine.consumeLastDecision();
  const recorded = [decision.selected, ...decision.alternatives];
  const unorderedMoves = candidate => candidate.moves.map(moveKey).sort().join("|");

  assert.ok(recorded.length >= 2);
  assert.equal(new Set(recorded.map(unorderedMoves)).size, recorded.length);
});

test("LZE8-Z538 turn 10 keeps the defensive point and chooses the verified deep-safe route", () => {
  const ranked = rankFixture(LZE8_Z538_TURN_10, [2, 4]);
  const safeMoves = [
    { from: 12, to: 8, die: 4 },
    { from: 20, to: 18, die: 2 },
  ];
  const archivedMoves = [
    { from: 8, to: 6, die: 2 },
    { from: 12, to: 8, die: 4 },
  ];
  const selected = ranked[0];
  const archived = candidateFor(ranked, archivedMoves);

  assert.ok(hasSequence(selected, safeMoves), `selected ${sequenceLabel(selected)}`);
  assert.equal(selected.features.verifiedDeepSafety, 1);
  assert.ok(selected.tactical.recoveryWorst >= archived.tactical.recoveryWorst + 20000000);
  assert.ok(selected.tactical.continuationWorst >= archived.tactical.continuationWorst + 60000000);
});

test("LZE8-Z538 turn 15 keeps the four-prime move supported by deeper continuation", () => {
  const ranked = rankFixture(LZE8_Z538_TURN_15, [3, 4]);
  const supportedMoves = [
    { from: 5, to: 2, die: 3 },
    { from: 12, to: 8, die: 4 },
  ];
  const superficiallyDefensiveMoves = [
    { from: 17, to: 14, die: 3 },
    { from: 12, to: 8, die: 4 },
  ];
  const selected = ranked[0];
  const alternative = candidateFor(ranked, superficiallyDefensiveMoves);

  assert.ok(hasSequence(selected, supportedMoves), `selected ${sequenceLabel(selected)}`);
  assert.equal(selected.features.primeRunAfter, 4);
  assert.equal(selected.features.homeShuffleMoves, 0);
  assert.ok(selected.tactical.continuationExpected >= alternative.tactical.continuationExpected + 20000000);
  assert.ok(selected.tactical.continuationWorst >= alternative.tactical.continuationWorst + 100000000);
});

test("LZE8-Z538 turn 21 advances a rear checker without tearing down the four-point prime", () => {
  const ranked = rankFixture(LZE8_Z538_TURN_21, [6, 3]);
  const safeMoves = [
    { from: 8, to: 5, die: 3 },
    { from: 23, to: 17, die: 6 },
  ];
  const selected = ranked[0];

  assert.ok(hasSequence(selected, safeMoves), `selected ${sequenceLabel(selected)}`);
  assert.equal(selected.features.primeRunAfter, 4);
  assert.equal(selected.features.outsideReduction, 1);
  assert.equal(selected.sequence.some(move => move.from === 7), false);
});
