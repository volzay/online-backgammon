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

function productionRank(state) {
  return loadEngine().rank(state, {
    strategyProfile: "v25",
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
}

function hasMove(candidate, from, to, die) {
  return candidate.sequence.some(move => (
    move.from === from && move.to === to && move.die === die
  ));
}

function assertSafeTurn36(candidate) {
  assert.ok(candidate, "the hard bot must return a move");
  assert.equal(candidate.sequence.length, 2);
  assert.ok(hasMove(candidate, 21, 18, 3));
  assert.ok(hasMove(candidate, 22, 17, 5));
  assert.equal(candidate.features.outsideReduction, 2);
  assert.equal(candidate.features.homeShuffleMoves, 0);
}

function descriptorKeys(descriptor) {
  return Array.from(new Set([
    descriptor.actionKey,
    descriptor.strategicActionKey,
    descriptor.familyActionKey,
    descriptor.legacyActionKey,
    ...(descriptor.behaviorActionKeys || []),
  ].filter(Boolean)));
}

function hostilePatterns(state, safeSequence, archivedSequence) {
  const engine = loadEngine();
  const safe = engine.describeSequence(state, safeSequence, {
    strategyProfile: "v25",
    color: "dark",
  }).experience;
  const archived = engine.describeSequence(state, archivedSequence, {
    strategyProfile: "v25",
    color: "dark",
  }).experience;
  const safeKeys = new Set(descriptorKeys(safe));
  const archivedKeys = new Set(descriptorKeys(archived));
  const rewardKeys = [...archivedKeys].filter(key => !safeKeys.has(key));
  const penaltyKeys = [...safeKeys].filter(key => !archivedKeys.has(key));

  assert.ok(rewardKeys.length > 0, "the archived move must receive a distinct reward");
  assert.ok(penaltyKeys.length > 0, "the safe move must receive a distinct penalty");

  return [
    ...rewardKeys.map(actionKey => ({
      contextKey: archived.contextKey,
      actionKey,
      samples: 120,
      wins: 120,
      losses: 0,
      winWeight: 360,
      lossWeight: 0,
      severeLosses: 0,
      signalWeight: 0,
    })),
    ...penaltyKeys.map(actionKey => ({
      contextKey: safe.contextKey,
      actionKey,
      samples: 120,
      wins: 0,
      losses: 120,
      winWeight: 0,
      lossWeight: 360,
      severeLosses: 120,
      signalWeight: 360,
    })),
  ];
}

const BBXR_TURN_36_POINTS = {
  1: { color: "dark", count: 1 },
  2: { color: "dark", count: 1 },
  3: { color: "white", count: 4 },
  4: { color: "white", count: 6 },
  6: { color: "white", count: 1 },
  8: { color: "white", count: 1 },
  13: { color: "dark", count: 2 },
  14: { color: "white", count: 1 },
  15: { color: "white", count: 1 },
  16: { color: "white", count: 1 },
  18: { color: "dark", count: 3 },
  21: { color: "dark", count: 1 },
  22: { color: "dark", count: 3 },
  23: { color: "dark", count: 4 },
};

const BBXR_TURN_37_POINTS = {
  1: { color: "dark", count: 1 },
  2: { color: "dark", count: 1 },
  3: { color: "white", count: 4 },
  4: { color: "white", count: 6 },
  5: { color: "white", count: 1 },
  6: { color: "white", count: 1 },
  8: { color: "white", count: 1 },
  13: { color: "dark", count: 3 },
  14: { color: "white", count: 1 },
  15: { color: "white", count: 1 },
  18: { color: "dark", count: 3 },
  22: { color: "dark", count: 3 },
  23: { color: "dark", count: 4 },
};

const BBXR_NEIGHBOR_OUTSIDE_9_POINTS = {
  ...BBXR_TURN_36_POINTS,
  13: { color: "dark", count: 3 },
  23: { color: "dark", count: 3 },
};

const BBXR_NEIGHBOR_OUTSIDE_8_POINTS = {
  ...BBXR_TURN_36_POINTS,
  13: { color: "dark", count: 3 },
  17: { color: "dark", count: 1 },
  23: { color: "dark", count: 2 },
};

const TURN_36_SAFE_SEQUENCE = [
  { from: 21, die: 3 },
  { from: 22, die: 5 },
];
const TURN_36_ARCHIVED_SEQUENCE = [
  { from: 21, die: 3 },
  { from: 18, die: 5 },
];

test("BBXR-QXLA turn 36 enters both outside checkers instead of shuffling at home", () => {
  const engine = loadEngine();
  engine.setExperience([], "bbxr-cold");
  const ranked = productionRank(roomState(BBXR_TURN_36_POINTS, [5, 3]));

  assertSafeTurn36(ranked[0]);
  const archived = ranked.find(candidate => (
    hasMove(candidate, 21, 18, 3) && hasMove(candidate, 18, 13, 5)
  ));
  assert.ok(archived, "the archived home shuffle must remain measurable");
  assert.equal(archived.features.homeShuffleMoves, 1);
});

test("BBXR late-home replacement also covers the reachable nine-outside neighbor", () => {
  const engine = loadEngine();
  engine.setExperience([], "bbxr-neighbor-outside-9");
  const ranked = productionRank(roomState(BBXR_NEIGHBOR_OUTSIDE_9_POINTS, [5, 3]));

  assertSafeTurn36(ranked[0]);
  assert.equal(ranked[0].features.maxRouteTowerAfter, 4);
  assert.equal(ranked[0].features.primeRunAfter, 2);
});

test("BBXR late-home replacement remains safe with eight outside checkers", () => {
  const engine = loadEngine();
  engine.setExperience([], "bbxr-neighbor-outside-8");
  const ranked = productionRank(roomState(BBXR_NEIGHBOR_OUTSIDE_8_POINTS, [5, 3]));

  assertSafeTurn36(ranked[0]);
  assert.equal(ranked[0].features.maxRouteTowerAfter, 4);
  assert.equal(ranked[0].features.primeRunAfter, 2);
});

test("BBXR-QXLA turn 36 safety survives hostile learned memory", () => {
  const engine = loadEngine();
  const state = roomState(BBXR_TURN_36_POINTS, [5, 3]);
  const patterns = hostilePatterns(
    state,
    TURN_36_SAFE_SEQUENCE,
    TURN_36_ARCHIVED_SEQUENCE,
  );
  engine.setExperience(patterns, "bbxr-hostile-memory");
  try {
    const ranked = productionRank(state);
    const selected = ranked[0];
    assertSafeTurn36(selected);
    assert.ok(selected.experienceAdjustment < 0);

    const archived = ranked.find(candidate => (
      hasMove(candidate, 21, 18, 3) && hasMove(candidate, 18, 13, 5)
    ));
    assert.ok(archived, "the rewarded archived move must remain in the analysis");
    assert.equal(
      archived.experienceAdjustment,
      0,
      "a learned win must not reward an action the current policy marks harmful",
    );
    assert.ok(archived.experience.riskSignal >= 1.1);
  } finally {
    engine.setExperience([], "bbxr-hostile-memory");
  }
});

test("BBXR-QXLA turn 37 experience cannot trade two entries and a prime for one entry", () => {
  const engine = loadEngine();
  const state = roomState(BBXR_TURN_37_POINTS, [5, 4]);
  const safe = [{ from: 22, die: 4 }, { from: 22, die: 5 }];
  const archived = [{ from: 1, die: 5 }, { from: 20, die: 4 }];
  engine.setExperience(hostilePatterns(state, safe, archived), "bbxr-turn37-hostile");
  try {
    const ranked = productionRank(state);
    assert.ok(hasMove(ranked[0], 22, 18, 4));
    assert.ok(hasMove(ranked[0], 22, 17, 5));
    assert.equal(ranked[0].features.outsideReduction, 2);
    assert.equal(ranked[0].features.primeRunAfter, 2);
    assert.ok(
      ranked[0].experienceAdjustment < 0,
      "the safe move remains selected even while learned evidence penalizes it",
    );
  } finally {
    engine.setExperience([], "bbxr-turn37-hostile");
  }
});

test("BBXR-QXLA transferable behavior distinguishes preserving and breaking a prime", () => {
  const engine = loadEngine();
  const state = roomState(BBXR_TURN_37_POINTS, [5, 4]);
  const primeBreaking = engine.describeSequence(state, [
    { from: 1, die: 5 },
    { from: 20, die: 4 },
  ], { strategyProfile: "v25", color: "dark" });
  const primePreserving = engine.describeSequence(state, [
    { from: 22, die: 4 },
    { from: 22, die: 5 },
  ], { strategyProfile: "v25", color: "dark" });

  assert.equal(primeBreaking.features.primeRunAfter, 1);
  assert.equal(primePreserving.features.primeRunAfter, 2);
  assert.ok(primeBreaking.features.primeScoreGain < primePreserving.features.primeScoreGain);

  const breakingBehavior = primeBreaking.experience.behaviorActionKeys[0];
  const preservingBehavior = primePreserving.experience.behaviorActionKeys[0];
  assert.notEqual(breakingBehavior, preservingBehavior);
  assert.match(breakingBehavior, /prime:loss/);
  assert.match(preservingBehavior, /prime:flat/);
});
