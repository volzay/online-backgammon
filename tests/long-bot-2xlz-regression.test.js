const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

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

function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+type[\s\S]*?;\s*$/gm, "")
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/gm, "")
    .replace(/^export\s+(?=(const|function|class))/gm, "")
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, "");
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
  return loadEngine().rank(roomState(points, dice), {
    strategyProfile: "v25",
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
}

function rankFixtureAgainstHeavyMemory(points, dice, safeSequence) {
  const engine = loadEngine();
  const state = roomState(points, dice);
  const descriptor = engine.describeSequence(state, safeSequence, {
    strategyProfile: "v25",
    color: "dark",
  }).experience;
  const actionKeys = Array.from(new Set([
    descriptor.actionKey,
    descriptor.strategicActionKey,
    descriptor.familyActionKey,
    descriptor.legacyActionKey,
    ...(descriptor.behaviorActionKeys || []),
  ].filter(Boolean)));
  const patterns = actionKeys.map(actionKey => ({
    contextKey: descriptor.contextKey,
    actionKey,
    samples: 120,
    wins: 0,
    losses: 120,
    lossWeight: 360,
    severeLosses: 120,
    signalWeight: 360,
    winWeight: 0,
  }));
  engine.setExperience(patterns, "2xlz-heavy-memory");
  try {
    return engine.rank(state, {
      strategyProfile: "v25",
      maxCandidates: 64,
      analysisNodeBudget: 480,
    });
  } finally {
    engine.setExperience([], "2xlz-heavy-memory");
  }
}

const QQRZ_DECISION_11_POINTS = {
  1: { color: "dark", count: 2 },
  2: { color: "dark", count: 1 },
  3: { color: "dark", count: 2 },
  4: { color: "dark", count: 1 },
  6: { color: "dark", count: 1 },
  7: { color: "dark", count: 1 },
  9: { color: "white", count: 1 },
  10: { color: "white", count: 1 },
  11: { color: "white", count: 1 },
  12: { color: "dark", count: 5 },
  14: { color: "white", count: 1 },
  17: { color: "white", count: 1 },
  18: { color: "white", count: 1 },
  19: { color: "white", count: 2 },
  20: { color: "dark", count: 1 },
  21: { color: "white", count: 1 },
  22: { color: "white", count: 1 },
  23: { color: "dark", count: 1 },
  24: { color: "white", count: 5 },
};

const FIVE_F44_DECISION_13_POINTS = {
  1: { color: "dark", count: 1 },
  3: { color: "dark", count: 1 },
  4: { color: "white", count: 1 },
  5: { color: "white", count: 1 },
  6: { color: "dark", count: 1 },
  7: { color: "white", count: 1 },
  8: { color: "dark", count: 2 },
  9: { color: "dark", count: 1 },
  10: { color: "white", count: 1 },
  11: { color: "white", count: 1 },
  12: { color: "dark", count: 5 },
  13: { color: "white", count: 1 },
  14: { color: "white", count: 1 },
  15: { color: "dark", count: 1 },
  19: { color: "white", count: 2 },
  20: { color: "white", count: 1 },
  21: { color: "dark", count: 2 },
  22: { color: "dark", count: 1 },
  24: { color: "white", count: 5 },
};

const FIVE_F44_DECISION_27_POINTS = {
  1: { color: "white", count: 1 },
  2: { color: "white", count: 2 },
  3: { color: "white", count: 2 },
  4: { color: "white", count: 3 },
  5: { color: "white", count: 2 },
  6: { color: "dark", count: 6 },
  8: { color: "dark", count: 2 },
  13: { color: "white", count: 1 },
  15: { color: "dark", count: 3 },
  16: { color: "dark", count: 2 },
  17: { color: "white", count: 1 },
  18: { color: "white", count: 1 },
  19: { color: "white", count: 1 },
  20: { color: "dark", count: 1 },
  22: { color: "dark", count: 1 },
  24: { color: "white", count: 1 },
};

const FIVE_F44_DECISION_20_POINTS = {
  1: { color: "dark", count: 2 },
  2: { color: "white", count: 1 },
  4: { color: "white", count: 1 },
  5: { color: "white", count: 2 },
  6: { color: "dark", count: 3 },
  7: { color: "white", count: 1 },
  8: { color: "dark", count: 3 },
  9: { color: "white", count: 1 },
  10: { color: "white", count: 1 },
  11: { color: "white", count: 1 },
  12: { color: "dark", count: 2 },
  13: { color: "white", count: 1 },
  14: { color: "white", count: 1 },
  15: { color: "dark", count: 2 },
  17: { color: "white", count: 1 },
  18: { color: "white", count: 1 },
  19: { color: "white", count: 1 },
  20: { color: "white", count: 1 },
  21: { color: "dark", count: 3 },
  24: { color: "white", count: 1 },
};

test("5F44-A8EA blocks the opponent's critical head exit before the fence closes", () => {
  const ranked = rankFixture(FIVE_F44_DECISION_13_POINTS, [4, 2]);
  const selected = ranked[0];
  const archivedMove = ranked.find(candidate => candidate.sequence.some(move => (
    move.from === 12 && move.to === 8 && move.die === 4
  )));

  assert.ok(selected.sequence.some(move => (
    move.from === 22 && move.to === 18 && move.die === 4
  )));
  assert.ok(selected.sequence.some(move => (
    move.from === 1 && move.to === 23 && move.die === 2
  )));
  assert.equal(selected.features.contestedOpponentHeadExit, 1);
  assert.ok(selected.tactical.expectedImpact >= archivedMove.tactical.expectedImpact + 10000000);
  assert.ok(selected.tactical.worstImpact >= archivedMove.tactical.worstImpact + 30000000);
  assert.ok(
    selected.tactical.continuationWorst
      >= archivedMove.tactical.continuationWorst + 15000000,
  );
});

test("5F44-A8EA critical head-exit block survives hostile learned memory", () => {
  const ranked = rankFixtureAgainstHeavyMemory(
    FIVE_F44_DECISION_13_POINTS,
    [4, 2],
    [{ from: 1, die: 2 }, { from: 22, die: 4 }],
  );

  assert.ok(ranked[0].sequence.some(move => (
    move.from === 22 && move.to === 18 && move.die === 4
  )));
  assert.equal(ranked[0].features.contestedOpponentHeadExit, 1);
  assert.ok(ranked[0].experienceAdjustment < 0);
});

test("contested opponent-head exit promotion keeps strict structural boundaries", async () => {
  const { isAnalyzedContestedOpponentHeadExit } = await import(pathToFileURL(
    path.join(ROOT, "bot-engine/long/engine.ts"),
  ).href);
  const state = roomState({
    1: { color: "dark", count: 5 },
    12: { color: "dark", count: 9 },
    22: { color: "dark", count: 1 },
    24: { color: "white", count: 5 },
    13: { color: "white", count: 10 },
  }, [4, 2]);
  const selected = {
    score: 60000000,
    experienceAdjustment: 0,
    sequence: [{ from: 12, to: 8, die: 4 }],
    after: roomState({
      1: { color: "dark", count: 5 },
      8: { color: "dark", count: 1 },
      12: { color: "dark", count: 8 },
      22: { color: "dark", count: 1 },
      24: { color: "white", count: 5 },
      13: { color: "white", count: 10 },
    }, []),
    features: {
      outsideReduction: 0,
      trapDelta: 0,
      fenceClosureDelta: 0,
      maxRouteTowerAfter: 3,
      homeShuffleMoves: 0,
      headLandingBreak: 0,
      primeRunAfter: 3,
    },
    tactical: {
      plies: 4,
      expectedImpact: -20000000,
      worstImpact: -80000000,
      recoveryWorst: -90000000,
      continuationExpected: -50000000,
      continuationWorst: -85000000,
    },
  };
  const candidate = (overrides = {}) => ({
    score: 0,
    experienceAdjustment: 0,
    sequence: [{ from: 22, to: 18, die: 4 }],
    after: roomState({
      1: { color: "dark", count: 5 },
      12: { color: "dark", count: 9 },
      18: { color: "dark", count: 1 },
      24: { color: "white", count: 5 },
      13: { color: "white", count: 10 },
    }, []),
    features: {
      outsideReduction: 1,
      trapDelta: 0,
      fenceClosureDelta: 0,
      maxRouteTowerAfter: 3,
      homeShuffleMoves: 0,
      headLandingBreak: 0,
      primeRunAfter: 2,
    },
    tactical: {
      plies: 4,
      expectedImpact: -10000000,
      worstImpact: -50000000,
      recoveryWorst: -60000000,
      continuationExpected: -40000000,
      continuationWorst: -70000000,
    },
    ...overrides,
  });

  assert.equal(
    isAnalyzedContestedOpponentHeadExit(state, "dark", candidate(), selected),
    true,
  );
  assert.equal(
    isAnalyzedContestedOpponentHeadExit(
      roomState({ ...state.points, 24: { color: "white", count: 3 } }, [4, 2]),
      "dark",
      candidate(),
      selected,
    ),
    false,
  );
  assert.equal(
    isAnalyzedContestedOpponentHeadExit(state, "dark", candidate({ score: -1 }), selected),
    false,
  );
  assert.equal(
    isAnalyzedContestedOpponentHeadExit(state, "dark", candidate({
      features: { ...candidate().features, primeRunAfter: 1 },
    }), selected),
    false,
  );
  assert.equal(
    isAnalyzedContestedOpponentHeadExit(state, "dark", candidate({
      tactical: { ...candidate().tactical, expectedImpact: -10000001 },
    }), selected),
    false,
  );
  assert.equal(
    isAnalyzedContestedOpponentHeadExit(state, "dark", candidate({
      tactical: { ...candidate().tactical, continuationWorst: undefined },
    }), selected),
    false,
  );
});

test("an early contested head exit is reserved before fence metrics increase", async () => {
  const { reserveDevelopingFenceEscapeForTacticalAnalysis } = await import(
    pathToFileURL(path.join(ROOT, "bot-engine/long/engine.ts")).href
  );
  const state = roomState({
    1: { color: "dark", count: 5 },
    12: { color: "dark", count: 9 },
    22: { color: "dark", count: 1 },
    13: { color: "white", count: 10 },
    24: { color: "white", count: 5 },
  }, [4, 2]);
  const after = points => roomState(points, []);
  const candidate = (id, score, points, overrides = {}) => ({
    id,
    score,
    experienceAdjustment: 0,
    sequence: [],
    after: after(points),
    features: {
      startZoneReduction: 0,
      outsideReduction: 0,
      homeShuffleMoves: 0,
      trapDelta: 0,
      fenceClosureDelta: 0,
      escapeGatewayDelta: 0,
      latentFenceExposureDelta: 0,
      primeRunAfter: 2,
      maxRouteTowerAfter: 2,
      headLandingBreak: 0,
      opponentFenceRunBefore: 0,
      ...overrides,
    },
  });
  const selectedPoints = {
    1: { color: "dark", count: 5 },
    8: { color: "dark", count: 1 },
    12: { color: "dark", count: 8 },
    22: { color: "dark", count: 1 },
    13: { color: "white", count: 10 },
    24: { color: "white", count: 5 },
  };
  const selected = candidate("selected", 100000000, selectedPoints);
  const contested = candidate("contested", 50000000, {
    1: { color: "dark", count: 5 },
    12: { color: "dark", count: 9 },
    18: { color: "dark", count: 1 },
    13: { color: "white", count: 10 },
    24: { color: "white", count: 5 },
  }, { outsideReduction: 1 });
  contested.sequence = [{ from: 22, to: 18, die: 4 }];
  const ranked = [
    selected,
    candidate("ordinary-1", 90000000, selectedPoints),
    candidate("ordinary-2", 80000000, selectedPoints),
    candidate("ordinary-3", 70000000, selectedPoints),
    contested,
  ];

  const reserved = reserveDevelopingFenceEscapeForTacticalAnalysis(
    state,
    "dark",
    ranked,
    4,
  );

  assert.ok(reserved.indexOf(contested) >= 0 && reserved.indexOf(contested) < 4);
  assert.equal(contested.features.fenceEscapeTacticalReservation, 1);
  assert.equal(contested.features.contestedHeadExitTacticalReservation, 1);
});

test("5F44-A8EA learned memory cannot restore an avoidable home shuffle", () => {
  const ranked = rankFixtureAgainstHeavyMemory(
    FIVE_F44_DECISION_27_POINTS,
    [1, 6],
    [{ from: 8, die: 1 }, { from: 20, die: 6 }],
  );
  const selected = ranked[0];

  assert.ok(selected.sequence.some(move => (
    move.from === 8 && move.to === 7 && move.die === 1
  )));
  assert.ok(selected.sequence.some(move => (
    move.from === 20 && move.to === 14 && move.die === 6
  )));
  assert.equal(selected.features.homeShuffleMoves, 0);
  assert.equal(selected.features.fenceEscapeTacticalReservation, 1);
  assert.equal(selected.features.experienceSafetyOverride, 1);
  assert.ok(selected.experienceAdjustment < 0);
});

test("5F44-A8EA records choices before strategic eligibility removes alternatives", () => {
  const engine = loadEngine();
  const state = roomState(FIVE_F44_DECISION_20_POINTS, [1, 6]);

  engine.plan(state, {
    strategyProfile: "v25",
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
  const decision = engine.consumeLastDecision();

  assert.equal(decision.alternatives.length, 0);
  assert.equal(decision.choiceCount, 2);
  assert.equal(decision.selected.features.choiceCount, 2);
});

test("QQRZ-K8RX releases the head before a three-point fence can close", () => {
  const ranked = rankFixture(QQRZ_DECISION_11_POINTS, [5, 4]);

  assert.equal(ranked[0].features.opponentFenceRunBefore, 3);
  assert.ok(ranked[0].features.trapBefore >= 180);
  assert.ok(ranked[0].sequence.some(move => move.from === 12));
  assert.equal(ranked[0].features.headGain, 1);
  assert.ok(ranked[0].features.latentFenceExposureDelta > 0);
  assert.equal(ranked[0].features.imminentHeadFenceEscape, 1);
  assert.ok(ranked[0].tactical);
});

test("QQRZ-K8RX safety override survives hostile learned memory", () => {
  const ranked = rankFixtureAgainstHeavyMemory(
    QQRZ_DECISION_11_POINTS,
    [5, 4],
    [{ from: 1, die: 5 }, { from: 12, die: 4 }],
  );

  assert.ok(ranked[0].sequence.some(move => move.from === 12));
  assert.equal(ranked[0].features.imminentHeadFenceEscape, 1);
  assert.ok(ranked[0].experienceAdjustment < 0);
});

test("QQRZ imminent head-fence override has strict safety boundaries", async () => {
  const {
    isAnalyzedImminentHeadFenceAnchor,
    isPlausibleImminentHeadFenceAnchor,
  } = await import(pathToFileURL(
    path.join(ROOT, "bot-engine/long/engine.ts"),
  ).href);
  const state = roomState({
    9: { color: "white", count: 1 },
    10: { color: "white", count: 1 },
    11: { color: "white", count: 1 },
    12: { color: "dark", count: 5 },
    20: { color: "dark", count: 10 },
    24: { color: "white", count: 12 },
  }, [5, 4]);
  const features = {
    headGain: 0,
    latentFenceExposureDelta: 0,
    trapDelta: 10,
    primeRunAfter: 4,
    fenceClosureDelta: 0,
    escapeGatewayDelta: 32,
    headLandingBreak: 0,
    maxRouteTowerAfter: 2,
    homeShuffleMoves: 0,
  };
  const selected = { score: 0, experienceAdjustment: 0, features };
  const anchor = score => ({
    score,
    experienceAdjustment: 0,
    sequence: [{ from: 12, to: 8, die: 4 }],
    features: {
      ...features,
      headGain: 1,
      latentFenceExposureDelta: 24,
      trapDelta: 11,
      fenceClosureDelta: -4,
      escapeGatewayDelta: 28,
    },
  });

  assert.equal(
    isPlausibleImminentHeadFenceAnchor(state, "dark", anchor(-8000000), selected),
    true,
  );
  assert.equal(
    isPlausibleImminentHeadFenceAnchor(state, "dark", anchor(-8000001), selected),
    false,
  );
  selected.tactical = {
    plies: 4,
    continuationExpected: -50000000,
    continuationWorst: -88000000,
  };
  const analyzedAnchor = anchor(-8000000);
  analyzedAnchor.tactical = {
    plies: 4,
    continuationExpected: -27000000,
    continuationWorst: -58000000,
  };
  assert.equal(
    isAnalyzedImminentHeadFenceAnchor(state, "dark", analyzedAnchor, selected),
    true,
  );
  assert.equal(
    isAnalyzedImminentHeadFenceAnchor(state, "dark", {
      ...analyzedAnchor,
      tactical: { ...analyzedAnchor.tactical, plies: 3 },
    }, selected),
    false,
  );
  assert.equal(
    isAnalyzedImminentHeadFenceAnchor(state, "dark", {
      ...analyzedAnchor,
      tactical: { ...analyzedAnchor.tactical, continuationExpected: -50000001 },
    }, selected),
    false,
  );
  assert.equal(
    isAnalyzedImminentHeadFenceAnchor(state, "dark", {
      ...analyzedAnchor,
      tactical: { ...analyzedAnchor.tactical, continuationWorst: -88000001 },
    }, selected),
    false,
  );
  const nonImmediateState = roomState({
    8: { color: "white", count: 1 },
    9: { color: "white", count: 1 },
    10: { color: "white", count: 1 },
    12: { color: "dark", count: 5 },
    20: { color: "dark", count: 10 },
    24: { color: "white", count: 12 },
  }, [5, 4]);
  assert.equal(
    isPlausibleImminentHeadFenceAnchor(
      nonImmediateState,
      "dark",
      anchor(-8000000),
      selected,
    ),
    false,
  );
});

test("QQRZ imminent head anchor wins a contested tactical reservation", async () => {
  const { reserveDevelopingFenceEscapeForTacticalAnalysis } = await import(
    pathToFileURL(path.join(ROOT, "bot-engine/long/engine.ts")).href
  );
  const state = roomState({
    9: { color: "white", count: 1 },
    10: { color: "white", count: 1 },
    11: { color: "white", count: 1 },
    12: { color: "dark", count: 5 },
    20: { color: "dark", count: 10 },
    24: { color: "white", count: 12 },
  }, [5, 4]);
  const candidate = (id, score, overrides = {}) => ({
    id,
    score,
    experienceAdjustment: 0,
    sequence: [],
    features: {
      headGain: 0,
      opponentFenceRunBefore: 3,
      startZoneReduction: 0,
      latentFenceExposureDelta: 0,
      trapDelta: 10,
      primeRunAfter: 4,
      fenceClosureDelta: 0,
      escapeGatewayDelta: 32,
      headLandingBreak: 0,
      maxRouteTowerAfter: 2,
      homeShuffleMoves: 0,
      outsideReduction: 0,
      ...overrides,
    },
  });
  const selected = candidate("selected", 100000000);
  const latent = candidate("latent", 96000000, {
    startZoneReduction: 1,
    latentFenceExposureDelta: 30,
  });
  const imminent = candidate("imminent", 95000000, {
    headGain: 1,
    latentFenceExposureDelta: 24,
    trapDelta: 11,
    fenceClosureDelta: -4,
    escapeGatewayDelta: 28,
  });
  imminent.sequence = [{ from: 12, to: 8, die: 4 }];
  const ranked = [
    selected,
    candidate("ordinary-1", 99000000),
    candidate("ordinary-2", 98000000),
    candidate("ordinary-3", 97000000),
    latent,
    imminent,
  ];

  const reserved = reserveDevelopingFenceEscapeForTacticalAnalysis(
    state,
    "dark",
    ranked,
    4,
  );
  assert.ok(reserved.slice(0, 4).some(item => item.id === "imminent"));
  assert.equal(imminent.features.fenceEscapeTacticalReservation, 1);
});

test("2XLZ-QD33 decision 2 releases the head without worsening the forming fence", () => {
  const ranked = rankFixture({
    6: { color: "dark", count: 1 },
    7: { color: "dark", count: 1 },
    11: { color: "white", count: 2 },
    12: { color: "dark", count: 13 },
    21: { color: "white", count: 1 },
    23: { color: "white", count: 1 },
    24: { color: "white", count: 11 },
  }, [3, 5]);

  assert.ok(ranked[0].features.headGain >= 1);
  assert.ok(ranked[0].features.fenceClosureDelta >= 0);
  assert.ok(ranked[0].features.developingFenceEscapeAdjustment > 0);
  assert.ok(ranked[0].tactical);
});

test("2XLZ-QD33 decision 4 takes the Pareto fence escape before closure", () => {
  const ranked = rankFixture({
    1: { color: "dark", count: 1 },
    4: { color: "dark", count: 1 },
    6: { color: "dark", count: 1 },
    7: { color: "dark", count: 1 },
    8: { color: "white", count: 1 },
    11: { color: "white", count: 1 },
    12: { color: "dark", count: 11 },
    15: { color: "white", count: 1 },
    19: { color: "white", count: 1 },
    21: { color: "white", count: 1 },
    23: { color: "white", count: 1 },
    24: { color: "white", count: 9 },
  }, [3, 4]);

  assert.ok(ranked[0].features.headGain >= 1);
  assert.ok(ranked[0].features.fenceClosureDelta >= 0);
  assert.ok(ranked[0].features.escapeGatewayDelta > -1.7);
  assert.ok(ranked[0].features.developingFenceEscapeAdjustment > 0);
});

test("2XLZ-QD33 decision 25 advances an outside checker instead of shuffling at home", () => {
  const ranked = rankFixture({
    1: { color: "dark", count: 1 },
    2: { color: "dark", count: 2 },
    3: { color: "white", count: 2 },
    4: { color: "dark", count: 2 },
    5: { color: "dark", count: 2 },
    6: { color: "dark", count: 1 },
    7: { color: "dark", count: 1 },
    8: { color: "white", count: 9 },
    9: { color: "dark", count: 1 },
    10: { color: "white", count: 2 },
    13: { color: "white", count: 1 },
    15: { color: "white", count: 1 },
    18: { color: "dark", count: 4 },
    20: { color: "dark", count: 1 },
  }, [6, 4]);

  assert.equal(ranked[0].features.homeShuffleMoves, 0);
  assert.equal(ranked[0].features.outsideReduction, 1);
  assert.ok(ranked[0].features.outsidePipGain >= 6);
  assert.ok(ranked[0].tactical);
});

test("2XLZ-QD33 decision 27 keeps route tempo with ten checkers outside", () => {
  const ranked = rankFixture({
    1: { color: "dark", count: 1 },
    2: { color: "dark", count: 1 },
    3: { color: "white", count: 4 },
    4: { color: "dark", count: 2 },
    5: { color: "dark", count: 2 },
    6: { color: "dark", count: 1 },
    7: { color: "dark", count: 1 },
    8: { color: "white", count: 8 },
    9: { color: "dark", count: 1 },
    10: { color: "white", count: 1 },
    13: { color: "white", count: 1 },
    14: { color: "dark", count: 2 },
    15: { color: "white", count: 1 },
    18: { color: "dark", count: 3 },
    19: { color: "dark", count: 1 },
  }, [4, 3]);

  assert.equal(ranked[0].features.homeShuffleMoves, 0);
  assert.equal(ranked[0].features.outsideReduction, 1);
  assert.ok(ranked[0].features.outsidePipGain >= 5);
  assert.ok(ranked[0].tactical);
});

test("2XLZ-QD33 decision 31 reserves the fifth unique route position for reply analysis", () => {
  const ranked = rankFixture({
    2: { color: "dark", count: 1 },
    3: { color: "white", count: 5 },
    4: { color: "dark", count: 1 },
    5: { color: "dark", count: 1 },
    6: { color: "dark", count: 1 },
    7: { color: "dark", count: 1 },
    8: { color: "white", count: 9 },
    9: { color: "dark", count: 1 },
    10: { color: "white", count: 1 },
    14: { color: "dark", count: 3 },
    16: { color: "dark", count: 2 },
    17: { color: "dark", count: 1 },
    18: { color: "dark", count: 2 },
    19: { color: "dark", count: 1 },
  }, [3, 5]);

  assert.equal(ranked[0].features.homeShuffleMoves, 0);
  assert.equal(ranked[0].features.startZoneReduction, 1);
  assert.ok(ranked[0].features.outsidePipGain >= 6);
  assert.equal(ranked[0].features.routeContinuityTacticalReservation, 1);
  assert.ok(ranked[0].tactical);
});

test("2XLZ-QD33 decision 33 crosses point 7 before the latent fence forms", () => {
  const ranked = rankFixture({
    1: { color: "white", count: 3 },
    2: { color: "dark", count: 1 },
    3: { color: "white", count: 3 },
    4: { color: "dark", count: 1 },
    5: { color: "dark", count: 1 },
    6: { color: "dark", count: 1 },
    8: { color: "white", count: 9 },
    9: { color: "dark", count: 1 },
    13: { color: "dark", count: 1 },
    14: { color: "dark", count: 3 },
    16: { color: "dark", count: 3 },
    17: { color: "dark", count: 1 },
    18: { color: "dark", count: 1 },
    23: { color: "dark", count: 1 },
  }, [2, 1]);

  assert.ok(ranked[0].sequence.some(move => move.from === 7));
  assert.equal(ranked[0].features.startZoneReduction, 1);
  assert.ok(ranked[0].features.latentFenceExposureDelta > 0);
  assert.ok(ranked[0].features.developingFenceEscapeAdjustment > 0);
});

test("2XLZ-QD33 decision 34 clears point 7 despite the static score cliff", () => {
  const ranked = rankFixture({
    1: { color: "white", count: 3 },
    2: { color: "dark", count: 1 },
    3: { color: "white", count: 4 },
    4: { color: "dark", count: 1 },
    5: { color: "dark", count: 1 },
    6: { color: "dark", count: 1 },
    7: { color: "dark", count: 1 },
    8: { color: "white", count: 8 },
    13: { color: "dark", count: 1 },
    14: { color: "dark", count: 3 },
    16: { color: "dark", count: 3 },
    17: { color: "dark", count: 1 },
    18: { color: "dark", count: 1 },
    22: { color: "dark", count: 1 },
  }, [1, 2]);

  assert.ok(ranked[0].sequence.some(move => move.from === 7));
  assert.equal(ranked[0].features.startZoneReduction, 1);
  assert.ok(ranked[0].features.latentFenceExposureDelta > 0);
  assert.ok(ranked[0].features.developingFenceEscapeAdjustment > 0);
  assert.equal(ranked[0].features.fenceEscapeTacticalReservation, 1);
});

test("2XLZ-QD33 decision 35 clears point 7 before the latent fence closes", () => {
  const ranked = rankFixture({
    1: { color: "white", count: 3 },
    2: { color: "dark", count: 1 },
    3: { color: "white", count: 5 },
    4: { color: "dark", count: 3 },
    6: { color: "white", count: 1 },
    7: { color: "dark", count: 1 },
    8: { color: "white", count: 6 },
    13: { color: "dark", count: 1 },
    14: { color: "dark", count: 3 },
    16: { color: "dark", count: 3 },
    17: { color: "dark", count: 1 },
    18: { color: "dark", count: 1 },
    22: { color: "dark", count: 1 },
  }, [5, 4]);

  assert.ok(ranked[0].sequence.some(move => move.from === 7));
  assert.equal(ranked[0].features.startZoneReduction, 1);
  assert.equal(ranked[0].features.outsideReduction, 1);
  assert.ok(ranked[0].features.escapeGatewayDelta > 1.4);
  assert.ok(ranked[0].features.latentFenceExposureDelta > 0);
  assert.ok(ranked[0].features.developingFenceEscapeAdjustment > 0);
  assert.ok(ranked[0].tactical);
});

test("2XLZ-QD33 decision 38 accepts bounded gateway cost for six extra route pips", () => {
  const ranked = rankFixture({
    1: { color: "white", count: 3 },
    2: { color: "dark", count: 1 },
    3: { color: "white", count: 6 },
    4: { color: "dark", count: 1 },
    5: { color: "white", count: 1 },
    7: { color: "dark", count: 1 },
    8: { color: "white", count: 5 },
    13: { color: "dark", count: 1 },
    14: { color: "dark", count: 3 },
    16: { color: "dark", count: 3 },
    17: { color: "dark", count: 2 },
    18: { color: "dark", count: 2 },
    22: { color: "dark", count: 1 },
  }, [6, 5]);

  assert.ok(ranked[0].sequence.some(move => move.from === 7));
  assert.equal(ranked[0].features.homeShuffleMoves, 0);
  assert.equal(ranked[0].features.outsideReduction, 1);
  assert.equal(ranked[0].features.outsidePipGain, 9);
  assert.ok(ranked[0].features.escapeGatewayDelta > -1.1);
  assert.ok(ranked[0].tactical);
});

test("2XLZ latent escapes survive a hostile learned-memory adjustment", () => {
  const fixtures = [
    {
      index: 33,
      dice: [2, 1],
      points: {
        1: { color: "white", count: 3 },
        2: { color: "dark", count: 1 },
        3: { color: "white", count: 3 },
        4: { color: "dark", count: 1 },
        5: { color: "dark", count: 1 },
        6: { color: "dark", count: 1 },
        8: { color: "white", count: 9 },
        9: { color: "dark", count: 1 },
        13: { color: "dark", count: 1 },
        14: { color: "dark", count: 3 },
        16: { color: "dark", count: 3 },
        17: { color: "dark", count: 1 },
        18: { color: "dark", count: 1 },
        23: { color: "dark", count: 1 },
      },
      safeSequence: [{ from: 9, die: 2 }, { from: 7, die: 1 }],
    },
    {
      index: 34,
      dice: [1, 2],
      points: {
        1: { color: "white", count: 3 },
        2: { color: "dark", count: 1 },
        3: { color: "white", count: 4 },
        4: { color: "dark", count: 1 },
        5: { color: "dark", count: 1 },
        6: { color: "dark", count: 1 },
        7: { color: "dark", count: 1 },
        8: { color: "white", count: 8 },
        13: { color: "dark", count: 1 },
        14: { color: "dark", count: 3 },
        16: { color: "dark", count: 3 },
        17: { color: "dark", count: 1 },
        18: { color: "dark", count: 1 },
        22: { color: "dark", count: 1 },
      },
      safeSequence: [{ from: 5, die: 1 }, { from: 7, die: 2 }],
    },
    {
      index: 38,
      dice: [6, 5],
      points: {
        1: { color: "white", count: 3 },
        2: { color: "dark", count: 1 },
        3: { color: "white", count: 6 },
        4: { color: "dark", count: 1 },
        5: { color: "white", count: 1 },
        7: { color: "dark", count: 1 },
        8: { color: "white", count: 5 },
        13: { color: "dark", count: 1 },
        14: { color: "dark", count: 3 },
        16: { color: "dark", count: 3 },
        17: { color: "dark", count: 2 },
        18: { color: "dark", count: 2 },
        22: { color: "dark", count: 1 },
      },
      safeSequence: [{ from: 7, die: 5 }, { from: 22, die: 6 }],
    },
  ];

  fixtures.forEach((fixture) => {
    const ranked = rankFixtureAgainstHeavyMemory(
      fixture.points,
      fixture.dice,
      fixture.safeSequence,
    );
    assert.ok(
      ranked[0].sequence.some(move => move.from === 7),
      `decision ${fixture.index} retained point 7`,
    );
    assert.ok(
      ranked[0].experienceAdjustment < 0,
      `decision ${fixture.index} did not exercise hostile memory`,
    );
  });
});

test("2XLZ-QD33 decision 40 keeps the safer gateway instead of blindly forcing route progress", () => {
  const ranked = rankFixture({
    1: { color: "white", count: 3 },
    2: { color: "white", count: 1 },
    3: { color: "white", count: 6 },
    4: { color: "dark", count: 1 },
    5: { color: "white", count: 2 },
    7: { color: "dark", count: 1 },
    8: { color: "white", count: 3 },
    13: { color: "dark", count: 2 },
    14: { color: "dark", count: 3 },
    16: { color: "dark", count: 5 },
    17: { color: "dark", count: 2 },
    18: { color: "dark", count: 1 },
  }, [4, 4, 4, 4]);
  const selected = ranked[0];
  const aggressive = ranked.find(candidate => (
    candidate.features.outsidePipGain >= 10
    && candidate.features.homeShuffleMoves <= 1
  ));

  assert.ok(aggressive);
  assert.ok(selected.features.fenceClosureDelta > aggressive.features.fenceClosureDelta);
  assert.ok(selected.features.escapeGatewayDelta > aggressive.features.escapeGatewayDelta);
  assert.ok(selected.features.fenceClosureDelta >= -17.1);
  assert.ok(selected.features.escapeGatewayDelta >= -4.1);
  assert.equal(selected.features.avoidableHomeShuffleMoves, 0);
  assert.equal(selected.features.routeContinuityAdjustment, undefined);
});

test("tactical beam keeps home, route, and fence reservations together", async () => {
  const {
    reserveDevelopingFenceEscapeForTacticalAnalysis,
    reserveHomeEntryForTacticalAnalysis,
    reserveRouteContinuityForTacticalAnalysis,
  } = await import(pathToFileURL(path.join(ROOT, "bot-engine/long/engine.ts")).href);
  const state = roomState({
    1: { color: "dark", count: 2 },
    13: { color: "dark", count: 10 },
    19: { color: "dark", count: 3 },
    24: { color: "white", count: 15 },
  }, [2, 3]);
  const candidate = (id, score, overrides = {}) => ({
    id,
    score,
    experienceAdjustment: 0,
    features: {
      outsideReduction: 0,
      outsidePipGain: 0,
      laggardDebtDelta: 0,
      startZoneReduction: 0,
      homeShuffleMoves: 1,
      trapDelta: 0,
      fenceClosureDelta: -5,
      escapeGatewayDelta: 0,
      primeRunAfter: 2,
      maxRouteTowerAfter: 3,
      opponentFenceRunBefore: 2,
      ...overrides,
    },
  });
  const selected = candidate("selected", 100000000);
  const ranked = [
    selected,
    candidate("ordinary-1", 99700000),
    candidate("ordinary-2", 99400000),
    candidate("ordinary-3", 99100000),
    candidate("home", 99000000, { outsideReduction: 1, homeShuffleMoves: 0 }),
    candidate("route", 98000000, { outsidePipGain: 3, homeShuffleMoves: 0 }),
    candidate("fence", 97000000, { fenceClosureDelta: 5 }),
  ];

  const withHome = reserveHomeEntryForTacticalAnalysis(state, "dark", ranked, 4);
  const withRoute = reserveRouteContinuityForTacticalAnalysis(state, "dark", withHome, 4);
  const reserved = reserveDevelopingFenceEscapeForTacticalAnalysis(
    state,
    "dark",
    withRoute,
    4,
  );

  assert.deepEqual(reserved.slice(0, 4).map(candidate => candidate.id), [
    "selected",
    "home",
    "route",
    "fence",
  ]);
});

test("tactical beam counts duplicate final positions only once", async () => {
  const {
    reserveHomeEntryForTacticalAnalysis,
    reserveRouteContinuityForTacticalAnalysis,
  } = await import(pathToFileURL(path.join(ROOT, "bot-engine/long/engine.ts")).href);
  const state = roomState({
    1: { color: "dark", count: 2 },
    13: { color: "dark", count: 10 },
    19: { color: "dark", count: 3 },
    24: { color: "white", count: 15 },
  }, [2, 3]);
  const after = point => ({
    points: { [point]: { color: "dark", count: 15 } },
    off: { white: 0, dark: 0 },
  });
  const candidate = (id, score, point, overrides = {}) => ({
    id,
    score,
    after: after(point),
    features: {
      outsideReduction: 0,
      outsidePipGain: 0,
      laggardDebtDelta: 0,
      startZoneReduction: 0,
      homeShuffleMoves: 1,
      trapDelta: 0,
      fenceClosureDelta: 0,
      escapeGatewayDelta: 0,
      primeRunAfter: 2,
      maxRouteTowerAfter: 3,
      opponentFenceRunBefore: 0,
      ...overrides,
    },
  });
  const selected = candidate("selected", 100000000, 1);
  const duplicateHome = candidate("duplicate-home", 99700000, 2);
  const ordinary = candidate("ordinary", 99400000, 3);
  const home = candidate("home", 99000000, 2, {
    outsideReduction: 1,
    homeShuffleMoves: 0,
  });
  const route = candidate("route", 98000000, 4, {
    outsidePipGain: 3,
    homeShuffleMoves: 0,
  });
  const ranked = [selected, duplicateHome, ordinary, home, route];

  const withHome = reserveHomeEntryForTacticalAnalysis(state, "dark", ranked, 4);
  const reserved = reserveRouteContinuityForTacticalAnalysis(state, "dark", withHome, 4);

  assert.deepEqual(reserved.slice(0, 4).map(item => item.id), [
    "selected",
    "ordinary",
    "home",
    "route",
  ]);
  assert.equal(new Set(reserved.slice(0, 4).map(item => JSON.stringify(item.after))).size, 4);
});

test("latent fence relief remains on the safety Pareto frontier", async () => {
  const {
    reserveDevelopingFenceEscapeForTacticalAnalysis,
  } = await import(pathToFileURL(path.join(ROOT, "bot-engine/long/engine.ts")).href);
  const state = roomState({
    7: { color: "dark", count: 1 },
    14: { color: "dark", count: 14 },
    1: { color: "white", count: 3 },
    3: { color: "white", count: 4 },
    8: { color: "white", count: 8 },
  }, [1, 2]);
  const candidate = (id, score, overrides = {}) => ({
    id,
    score,
    features: {
      startZoneReduction: 0,
      outsideReduction: 0,
      homeShuffleMoves: 0,
      trapDelta: 0,
      fenceClosureDelta: 0,
      escapeGatewayDelta: 0,
      latentFenceExposureDelta: 0,
      primeRunAfter: 2,
      maxRouteTowerAfter: 3,
      opponentFenceRunBefore: 2,
      ...overrides,
    },
  });
  const selected = candidate("selected", 100000000);
  const latentEscape = candidate("latent", 90000000, {
    startZoneReduction: 1,
    outsideReduction: 1,
    latentFenceExposureDelta: 10,
  });
  const superficiallySafer = candidate("surface", 95000000, {
    trapDelta: 1,
    fenceClosureDelta: 1,
    escapeGatewayDelta: 1,
    latentFenceExposureDelta: -10,
  });
  const ranked = [
    selected,
    superficiallySafer,
    candidate("ordinary-1", 94000000),
    candidate("ordinary-2", 93000000),
    latentEscape,
  ];

  const reserved = reserveDevelopingFenceEscapeForTacticalAnalysis(
    state,
    "dark",
    ranked,
    4,
  );

  assert.equal(reserved.slice(0, 4).at(-1).id, "latent");
  assert.equal(latentEscape.features.fenceEscapeTacticalReservation, 1);
});

test("latent fence exposure improves when one checker escapes a rear tower", async () => {
  const {
    latentFenceExposure,
  } = await import(pathToFileURL(path.join(ROOT, "bot-engine/long/metrics.ts")).href);
  const before = roomState({
    1: { color: "white", count: 3 },
    3: { color: "white", count: 4 },
    7: { color: "dark", count: 3 },
    14: { color: "dark", count: 12 },
  }, [1, 2]);
  const after = roomState({
    1: { color: "white", count: 3 },
    3: { color: "white", count: 4 },
    6: { color: "dark", count: 1 },
    7: { color: "dark", count: 2 },
    14: { color: "dark", count: 12 },
  }, [1, 2]);

  assert.ok(latentFenceExposure(before, "dark") > latentFenceExposure(after, "dark"));
});

test("only safely avoidable home shuffles are exposed to experience", async () => {
  const {
    annotateAvoidableHomeShuffles,
  } = await import(pathToFileURL(path.join(ROOT, "bot-engine/long/engine.ts")).href);
  const candidate = (homeShuffleMoves, overrides = {}) => ({
    features: {
      homeShuffleMoves,
      outsideReduction: 1,
      outsidePipGain: 4,
      trapDelta: 0,
      fenceClosureDelta: 0,
      escapeGatewayDelta: 0,
      latentFenceExposureDelta: 0,
      routeTowerDelta: 0,
      maxRouteTowerAfter: 3,
      headGain: 0,
      startZoneReduction: 0,
      primeRunAfter: 2,
      primeScoreAfter: 0,
      opponentMoveBlockAfter: 0,
      ...overrides,
    },
  });
  const avoidable = candidate(2);
  const safeAlternative = candidate(0);
  const necessary = candidate(3, { escapeGatewayDelta: 2 });
  const unsafeAlternative = candidate(1, { escapeGatewayDelta: -1 });

  annotateAvoidableHomeShuffles([
    avoidable,
    safeAlternative,
    necessary,
    unsafeAlternative,
  ]);

  assert.equal(avoidable.features.avoidableHomeShuffleMoves, 2);
  assert.equal(necessary.features.avoidableHomeShuffleMoves, 0);
});

test("a tower-building alternative cannot make a home shuffle avoidable", async () => {
  const {
    annotateAvoidableHomeShuffles,
  } = await import(pathToFileURL(path.join(ROOT, "bot-engine/long/engine.ts")).href);
  const homeShuffle = {
    features: {
      homeShuffleMoves: 1,
      outsideReduction: 1,
      outsidePipGain: 4,
      trapDelta: 0,
      fenceClosureDelta: 0,
      escapeGatewayDelta: 0,
      latentFenceExposureDelta: 0,
      routeTowerDelta: 0,
      maxRouteTowerAfter: 3,
      headGain: 0,
      startZoneReduction: 0,
      primeRunAfter: 2,
      primeScoreAfter: 0,
      opponentMoveBlockAfter: 0,
    },
  };
  const towerAlternative = {
    features: {
      ...homeShuffle.features,
      homeShuffleMoves: 0,
      routeTowerDelta: -4,
      maxRouteTowerAfter: 7,
    },
  };

  annotateAvoidableHomeShuffles([homeShuffle, towerAlternative]);

  assert.equal(homeShuffle.features.avoidableHomeShuffleMoves, 0);
});
