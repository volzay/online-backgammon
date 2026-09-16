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

function rank(position, label) {
  const engine = loadEngine();
  engine.setExperience([], label);
  return engine.rank(position, {
    strategyProfile: "v25",
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
}

function hasMove(candidate, from, to, die) {
  return candidate.sequence.some(move => (
    Number(move.from) === from
    && Number(move.to) === to
    && Number(move.die) === die
  ));
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

function hostilePatterns(position, safeSequence, archivedSequence) {
  const engine = loadEngine();
  const describe = sequence => engine.describeSequence(position, sequence, {
    strategyProfile: "v25",
    color: "dark",
  }).experience;
  const safe = describe(safeSequence);
  const archived = describe(archivedSequence);
  const safeKeys = new Set(descriptorKeys(safe));
  const archivedKeys = new Set(descriptorKeys(archived));
  const rewardKeys = [...archivedKeys].filter(key => !safeKeys.has(key));
  const penaltyKeys = [...safeKeys].filter(key => !archivedKeys.has(key));

  assert.ok(rewardKeys.length > 0, "the archived line needs a distinct reward key");
  assert.ok(penaltyKeys.length > 0, "the escape line needs a distinct penalty key");
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

// Production 5BQ4-EGZ2, hard-bot decision 38. Point 5 is the last checker
// exposed behind white's four-point fence; 5→24 is its only immediate escape.
const FIVE_BQ_DECISION_38 = roomState({
  1: { color: "white", count: 2 },
  2: { color: "white", count: 6 },
  3: { color: "white", count: 2 },
  4: { color: "white", count: 1 },
  5: { color: "dark", count: 1 },
  6: { color: "white", count: 1 },
  8: { color: "white", count: 3 },
  13: { color: "dark", count: 3 },
  14: { color: "dark", count: 2 },
  15: { color: "dark", count: 3 },
  16: { color: "dark", count: 1 },
  17: { color: "dark", count: 2 },
  18: { color: "dark", count: 1 },
  20: { color: "dark", count: 1 },
  23: { color: "dark", count: 1 },
}, [5, 3]);

// Production H7JJ-7RCR, hard-bot decision 25. The archived move tore down
// dark's five-point prime; 1→23→17 enters home without opening the blockade.
const H7_DECISION_25 = roomState({
  1: { color: "dark", count: 1 },
  3: { color: "white", count: 1 },
  4: { color: "white", count: 2 },
  5: { color: "dark", count: 1 },
  6: { color: "dark", count: 1 },
  7: { color: "dark", count: 1 },
  8: { color: "dark", count: 1 },
  9: { color: "dark", count: 1 },
  10: { color: "white", count: 4 },
  13: { color: "white", count: 1 },
  14: { color: "white", count: 1 },
  15: { color: "white", count: 2 },
  16: { color: "white", count: 2 },
  17: { color: "dark", count: 4 },
  18: { color: "white", count: 1 },
  19: { color: "white", count: 1 },
  20: { color: "dark", count: 5 },
}, [2, 6]);

// Production DAK9-ETEA, hard-bot decision 23.
const DAK_DECISION_23 = roomState({
  1: { color: "dark", count: 1 },
  2: { color: "white", count: 1 },
  3: { color: "dark", count: 1 },
  4: { color: "dark", count: 1 },
  5: { color: "dark", count: 2 },
  6: { color: "dark", count: 1 },
  7: { color: "white", count: 1 },
  8: { color: "white", count: 1 },
  9: { color: "white", count: 1 },
  10: { color: "white", count: 2 },
  13: { color: "dark", count: 1 },
  14: { color: "white", count: 5 },
  15: { color: "white", count: 1 },
  16: { color: "dark", count: 1 },
  17: { color: "white", count: 1 },
  18: { color: "white", count: 1 },
  19: { color: "white", count: 1 },
  20: { color: "dark", count: 1 },
  22: { color: "dark", count: 3 },
  23: { color: "dark", count: 2 },
  24: { color: "dark", count: 1 },
}, [3, 3, 3, 3]);

// Production DAK9-ETEA, hard-bot decision 29.
const DAK_DECISION_29 = roomState({
  2: { color: "white", count: 1 },
  3: { color: "white", count: 1 },
  4: { color: "white", count: 1 },
  5: { color: "white", count: 1 },
  6: { color: "white", count: 4 },
  7: { color: "white", count: 1 },
  12: { color: "white", count: 1 },
  13: { color: "dark", count: 1 },
  14: { color: "white", count: 2 },
  15: { color: "white", count: 1 },
  16: { color: "dark", count: 5 },
  17: { color: "white", count: 1 },
  18: { color: "white", count: 1 },
  19: { color: "dark", count: 2 },
  22: { color: "dark", count: 3 },
  23: { color: "dark", count: 3 },
  24: { color: "dark", count: 1 },
}, [2, 4]);

// Production CUWZ-X562, hard-bot decision 20.
const CUWZ_DECISION_20 = roomState({
  1: { color: "dark", count: 1 },
  2: { color: "dark", count: 1 },
  4: { color: "dark", count: 1 },
  5: { color: "white", count: 1 },
  6: { color: "white", count: 1 },
  7: { color: "white", count: 1 },
  8: { color: "dark", count: 1 },
  9: { color: "white", count: 1 },
  10: { color: "dark", count: 1 },
  11: { color: "white", count: 2 },
  12: { color: "dark", count: 2 },
  13: { color: "dark", count: 1 },
  14: { color: "white", count: 2 },
  15: { color: "dark", count: 2 },
  16: { color: "white", count: 5 },
  18: { color: "dark", count: 1 },
  19: { color: "white", count: 2 },
  22: { color: "dark", count: 1 },
  23: { color: "dark", count: 3 },
}, [4, 2]);

// Production CUWZ-X562, hard-bot decision 31.
const CUWZ_DECISION_31 = roomState({
  1: { color: "white", count: 1 },
  2: { color: "dark", count: 1 },
  4: { color: "white", count: 1 },
  5: { color: "white", count: 5 },
  6: { color: "white", count: 6 },
  7: { color: "dark", count: 1 },
  12: { color: "white", count: 1 },
  13: { color: "dark", count: 1 },
  14: { color: "white", count: 1 },
  15: { color: "dark", count: 5 },
  17: { color: "dark", count: 2 },
  18: { color: "dark", count: 3 },
  20: { color: "dark", count: 1 },
  22: { color: "dark", count: 1 },
}, [1, 6]);

// Production JF26-JKBJ, hard-bot decision 13.
const JF26_DECISION_13 = roomState({
  2: { color: "dark", count: 1 },
  3: { color: "dark", count: 1 },
  5: { color: "dark", count: 1 },
  6: { color: "dark", count: 1 },
  7: { color: "white", count: 1 },
  8: { color: "dark", count: 1 },
  9: { color: "white", count: 1 },
  10: { color: "white", count: 1 },
  11: { color: "white", count: 1 },
  12: { color: "dark", count: 6 },
  17: { color: "dark", count: 1 },
  18: { color: "white", count: 2 },
  19: { color: "white", count: 1 },
  20: { color: "white", count: 1 },
  21: { color: "white", count: 2 },
  22: { color: "white", count: 1 },
  23: { color: "dark", count: 3 },
  24: { color: "white", count: 4 },
}, [3, 3, 3, 3]);

// Production JF26-JKBJ, hard-bot decision 25. Releasing the last head checker
// entered one checker but destroyed the defensive route and exposed the rest
// of the position to the opponent's completed fence.
const JF26_DECISION_25 = roomState({
  3: { color: "white", count: 1 },
  4: { color: "white", count: 1 },
  5: { color: "white", count: 1 },
  6: { color: "white", count: 1 },
  7: { color: "white", count: 1 },
  8: { color: "white", count: 1 },
  9: { color: "white", count: 1 },
  11: { color: "dark", count: 3 },
  12: { color: "dark", count: 1 },
  13: { color: "white", count: 2 },
  15: { color: "dark", count: 2 },
  16: { color: "dark", count: 3 },
  17: { color: "dark", count: 5 },
  18: { color: "white", count: 6 },
  19: { color: "dark", count: 1 },
}, [1, 2]);

test("5BQ4-EGZ2 decision 38 escapes the trapped laggard before entering two safe checkers", () => {
  const ranked = rank(FIVE_BQ_DECISION_38, "5bq-decision-38-cold");
  const selected = ranked[0];
  const escape = ranked.find(candidate => hasMove(candidate, 5, 24, 5));

  assert.ok(escape, "full ranking must retain the only immediate laggard escape");
  assert.ok(hasMove(selected, 5, 24, 5), JSON.stringify(selected.sequence));
  assert.equal(
    selected.features.latentFenceExposureAfter,
    Math.min(...ranked.map(candidate => candidate.features.latentFenceExposureAfter)),
  );
  assert.equal(
    selected.features.escapeGatewayDelta,
    Math.max(...ranked.map(candidate => candidate.features.escapeGatewayDelta)),
  );
});

test("5BQ4-EGZ2 forced laggard escape survives hostile learned memory", () => {
  const engine = loadEngine();
  const safe = [{ from: 5, die: 5 }, { from: 20, die: 3 }];
  const archived = [{ from: 20, die: 3 }, { from: 23, die: 5 }];
  engine.setExperience(
    hostilePatterns(FIVE_BQ_DECISION_38, safe, archived),
    "5bq-decision-38-hostile",
  );
  try {
    const ranked = engine.rank(FIVE_BQ_DECISION_38, {
      strategyProfile: "v25",
      maxCandidates: 64,
      analysisNodeBudget: 480,
    });
    const selected = ranked[0];
    const archivedCandidate = ranked.find(candidate => (
      hasMove(candidate, 20, 17, 3) && hasMove(candidate, 23, 18, 5)
    ));

    assert.ok(hasMove(selected, 5, 24, 5), JSON.stringify(selected.sequence));
    assert.ok(archivedCandidate, "the rewarded archived line must remain measurable");
    assert.ok(
      selected.experienceAdjustment < archivedCandidate.experienceAdjustment,
      "the tactical invariant must override memory that rewards the archived mistake",
    );
  } finally {
    engine.setExperience([], "5bq-decision-38-hostile-reset");
  }
});

test("H7JJ-7RCR decision 25 enters home without tearing down the five-point prime", () => {
  const ranked = rank(H7_DECISION_25, "h7-decision-25");
  const selected = ranked[0];

  assert.ok(hasMove(selected, 1, 23, 2), JSON.stringify(selected.sequence));
  assert.ok(hasMove(selected, 23, 17, 6), JSON.stringify(selected.sequence));
  assert.equal(
    selected.features.outsideReduction,
    Math.max(...ranked.map(candidate => candidate.features.outsideReduction)),
  );
  assert.equal(
    selected.features.primeRunAfter,
    Math.max(...ranked.map(candidate => candidate.features.primeRunAfter)),
  );
  assert.equal(
    selected.features.opponentMoveBlockAfter,
    Math.max(...ranked.map(candidate => candidate.features.opponentMoveBlockAfter)),
  );
});

test("DAK9-ETEA decision 23 preserves the strongest remaining prime and block", () => {
  const ranked = rank(DAK_DECISION_23, "dak-decision-23");
  const selected = ranked[0];

  assert.ok(ranked.length > 1, "the structurally safer double-three line must be ranked");
  assert.ok(hasMove(selected, 1, 22, 3), JSON.stringify(selected.sequence));
  assert.ok(hasMove(selected, 6, 3, 3), JSON.stringify(selected.sequence));
  assert.equal(
    selected.sequence.filter(move => (
      Number(move.from) === 3 && Number(move.to) === 24 && Number(move.die) === 3
    )).length,
    2,
    JSON.stringify(selected.sequence),
  );
  assert.equal(
    selected.features.primeRunAfter,
    Math.max(...ranked.map(candidate => candidate.features.primeRunAfter)),
  );
  assert.equal(
    selected.features.blockadeGain,
    Math.max(...ranked.map(candidate => candidate.features.blockadeGain)),
  );
});

test("DAK9-ETEA decision 29 enters home instead of improving points before home", () => {
  const ranked = rank(DAK_DECISION_29, "dak-decision-29");
  const selected = ranked[0];

  assert.ok(ranked.some(candidate => candidate.features.outsideReduction > 0));
  assert.equal(
    selected.features.outsideReduction,
    Math.max(...ranked.map(candidate => candidate.features.outsideReduction)),
  );
  assert.equal(selected.features.homeEntryMoves, 1);
  assert.equal(selected.features.homeShuffleMoves, 0);
});

test("CUWZ-X562 decision 20 keeps the available block and escape gateway", () => {
  const ranked = rank(CUWZ_DECISION_20, "cuwz-decision-20");
  const selected = ranked[0];

  assert.ok(ranked.length > 1, "full ranking must retain the defensive alternative");
  assert.ok(hasMove(selected, 12, 8, 4), JSON.stringify(selected.sequence));
  assert.ok(hasMove(selected, 23, 21, 2), JSON.stringify(selected.sequence));
  assert.equal(
    selected.features.blockadeGain,
    Math.max(...ranked.map(candidate => candidate.features.blockadeGain)),
  );
  assert.equal(
    selected.features.escapeGatewayDelta,
    Math.max(...ranked.map(candidate => candidate.features.escapeGatewayDelta)),
  );
});

test("CUWZ-X562 decision 31 does not spend a die on an avoidable home shuffle", () => {
  const ranked = rank(CUWZ_DECISION_31, "cuwz-decision-31");
  const selected = ranked[0];

  assert.ok(ranked.some(candidate => candidate.features.avoidableHomeShuffleMoves > 0));
  assert.ok(ranked.some(candidate => candidate.features.avoidableHomeShuffleMoves === 0));
  assert.equal(selected.features.outsideReduction, 1);
  assert.equal(selected.features.avoidableHomeShuffleMoves, 0);
  assert.equal(selected.features.homeShuffleMoves, 0);
});

test("JF26-JKBJ decision 13 keeps the point-17 anchor against the five-point fence", () => {
  const ranked = rank(JF26_DECISION_13, "jf26-decision-13");
  const selected = ranked[0];

  assert.equal(selected.after.points[17]?.color, "dark", JSON.stringify(selected.sequence));
  assert.equal(hasMove(selected, 17, 14, 3), false, JSON.stringify(selected.sequence));
  assert.ok(hasMove(selected, 2, 23, 3), JSON.stringify(selected.sequence));
  assert.ok(hasMove(selected, 8, 5, 3), JSON.stringify(selected.sequence));
  assert.equal(
    selected.sequence.filter(move => (
      Number(move.from) === 5 && Number(move.to) === 2 && Number(move.die) === 3
    )).length,
    2,
    JSON.stringify(selected.sequence),
  );
  assert.equal(selected.tactical?.distributionComplete, true);
});

test("JF26-JKBJ decision 25 enters home without releasing the last head checker", () => {
  const ranked = rank(JF26_DECISION_25, "jf26-decision-25");
  const selected = ranked[0];

  assert.ok(hasMove(selected, 11, 10, 1), JSON.stringify(selected.sequence));
  assert.ok(hasMove(selected, 19, 17, 2), JSON.stringify(selected.sequence));
  assert.equal(hasMove(selected, 12, 11, 1), false, JSON.stringify(selected.sequence));
  assert.equal(selected.features.outsideReduction, 1);
  assert.equal(selected.features.latentFenceExposureAfter, selected.features.latentFenceExposureBefore);
  assert.ok(selected.features.opponentMoveBlockGain >= 0);
  assert.ok(selected.tactical?.continuationWorst > -100000000);
});
