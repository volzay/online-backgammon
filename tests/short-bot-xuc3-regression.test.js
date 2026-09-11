const assert = require("node:assert/strict");
const test = require("node:test");

const simulator = require("../scripts/simulate-short-bot-regression");

function archivedState(runtime, { points, bar, off, dice }) {
  const state = runtime.game.initialState("short");
  state.points = JSON.parse(JSON.stringify(points));
  state.bar = { white: 0, dark: 0, ...bar };
  state.off = { white: 0, dark: 0, ...off };
  state.turn = "dark";
  state.phase = "move";
  state.dice = [...dice];
  state.rolled = [...dice];
  state.turnMoves = [];
  state.winner = null;
  return state;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function analyze(runtime, state) {
  const request = runtime.engine.prepareWildbgRequest(state);
  return runtime.wildbgAnalyzer.analyze(
    request.board,
    request.die1,
    request.die2,
    request.isOnePointer,
  );
}

function rawTopPlan(runtime, state, analysis) {
  const plan = runtime.engine.planFromWildbgAnalysis(state, {
    ...analysis,
    moves: [analysis.moves[0]],
  });
  runtime.engine.consumeLastDecision();
  return plain(plan);
}

const XUC3_BOT5 = {
  dice: [6, 1],
  points: {
    1: { color: "white", count: 2 },
    4: { color: "white", count: 2 },
    5: { color: "dark", count: 1 },
    6: { color: "white", count: 4 },
    8: { color: "white", count: 4 },
    12: { color: "dark", count: 5 },
    13: { color: "white", count: 3 },
    17: { color: "dark", count: 4 },
    19: { color: "dark", count: 3 },
    20: { color: "dark", count: 2 },
  },
};

const XUC3_BOT7 = {
  dice: [2, 5],
  points: {
    1: { color: "white", count: 2 },
    2: { color: "white", count: 2 },
    4: { color: "white", count: 3 },
    5: { color: "dark", count: 1 },
    6: { color: "white", count: 2 },
    8: { color: "white", count: 4 },
    12: { color: "dark", count: 2 },
    13: { color: "white", count: 2 },
    16: { color: "dark", count: 2 },
    17: { color: "dark", count: 1 },
    18: { color: "dark", count: 2 },
    19: { color: "dark", count: 3 },
    20: { color: "dark", count: 2 },
    21: { color: "dark", count: 2 },
  },
};

const XUC3_BOT10 = {
  dice: [6, 3],
  bar: { dark: 1 },
  off: { white: 3 },
  points: {
    1: { color: "white", count: 2 },
    2: { color: "white", count: 3 },
    3: { color: "white", count: 2 },
    4: { color: "white", count: 2 },
    5: { color: "white", count: 3 },
    16: { color: "dark", count: 2 },
    17: { color: "dark", count: 3 },
    18: { color: "dark", count: 2 },
    19: { color: "dark", count: 2 },
    20: { color: "dark", count: 2 },
    21: { color: "dark", count: 2 },
    22: { color: "dark", count: 1 },
  },
};

const XUC3_BOT16 = {
  dice: [3, 5],
  off: { white: 14, dark: 3 },
  points: {
    1: { color: "white", count: 1 },
    19: { color: "dark", count: 4 },
    20: { color: "dark", count: 1 },
    21: { color: "dark", count: 3 },
    22: { color: "dark", count: 1 },
    23: { color: "dark", count: 2 },
    24: { color: "dark", count: 1 },
  },
};

test("XUC3-2ZA5 BOT5 rescues and protects the exposed rear checker", () => {
  const runtime = simulator.loadRuntime();
  const state = archivedState(runtime, XUC3_BOT5);
  const analysis = analyze(runtime, state);

  assert.deepEqual(
    rawTopPlan(runtime, state, analysis),
    [{ from: 12, die: 6 }, { from: 17, die: 1 }],
    "the frozen analyzer must reproduce the archived unsafe production move",
  );
  assert.deepEqual(
    plain(runtime.engine.plan(state)),
    [{ from: 5, die: 6 }, { from: 11, die: 1 }],
    "the lower-tail guard must move the exposed checker onto the protected 12 point",
  );

  const decision = runtime.engine.consumeLastDecision();
  assert.equal(decision.engineVersion, "short-analytic-v6");
  assert.equal(decision.engine.provenance, "wildbg-wasm");
  assert.equal(decision.engine.choiceReason, "critical-rear-blot-rescue");
  assert.equal(decision.engine.originalRank, 0);
  assert.equal(decision.engine.selectedRank, 6);
  assert.equal(decision.engine.candidateCount, 12);
  assert.equal(decision.choiceCount, 12);
  assert.equal(decision.selected.features.backmostGain, 7);
  assert.equal(decision.selected.features.exposureDelta, -37.7);

  const selectedSevere = decision.selected.wildbgProbabilities.lose_gammon;
  const archivedSevere = decision.alternatives[0].wildbgProbabilities.lose_gammon;
  assert.ok(selectedSevere < 0.02);
  assert.ok(archivedSevere > 0.17);

  const after = plain(state);
  simulator.applyPlan(runtime.game, after, runtime.engine.plan(state), "hard bot");
  runtime.engine.consumeLastDecision();
  assert.equal(after.points[5], undefined);
  assert.deepEqual(after.points[12], { color: "dark", count: 6 });
});

test("XUC3-2ZA5 BOT7 does not overfit the rear-checker rescue policy", () => {
  const runtime = simulator.loadRuntime();
  const state = archivedState(runtime, XUC3_BOT7);
  const analysis = analyze(runtime, state);
  const top = [{ from: 12, die: 2 }, { from: 12, die: 5 }];

  assert.deepEqual(rawTopPlan(runtime, state, analysis), top);
  assert.deepEqual(plain(runtime.engine.plan(state)), top);

  const decision = runtime.engine.consumeLastDecision();
  assert.equal(decision.engine.choiceReason, "wildbg-top");
  assert.equal(decision.engine.originalRank, 0);
  assert.equal(decision.engine.selectedRank, 0);
  assert.equal(decision.engine.candidateCount, 46);
});

test("short v6 applies loaded experience to a near-equity WildBG choice", () => {
  const runtime = simulator.loadRuntime();
  const state = archivedState(runtime, XUC3_BOT7);
  const analysis = plain(analyze(runtime, state));

  analysis.moves[1].equity = analysis.moves[0].equity - 0.005;
  analysis.moves[1].score = analysis.moves[1].equity;
  assert.deepEqual(
    plain(runtime.engine.planFromWildbgAnalysis(state, analysis)),
    [{ from: 12, die: 2 }, { from: 12, die: 5 }],
    "without learned evidence the frozen WildBG top move must win the near tie",
  );
  const baseline = runtime.engine.consumeLastDecision();
  const topExperience = baseline.selected.experience;
  const learnedExperience = baseline.alternatives[0].experience;
  assert.equal(baseline.alternatives[0].wildbgRank, 1);

  runtime.engine.setExperience([{
    ...topExperience,
    samples: 64,
    wins: 0,
    losses: 64,
    winWeight: 0,
    lossWeight: 64,
  }, {
    ...learnedExperience,
    samples: 64,
    wins: 64,
    losses: 0,
    winWeight: 64,
    lossWeight: 0,
  }], "xuc3-regression");

  assert.deepEqual(
    plain(runtime.engine.planFromWildbgAnalysis(state, analysis)),
    [{ from: 12, die: 5 }, { from: 19, die: 2 }],
    "positive learned outcomes must select the rank-one alternative within the equity margin",
  );
  const learned = runtime.engine.consumeLastDecision();
  assert.equal(learned.engine.choiceReason, "near-equity-experience");
  assert.equal(learned.engine.originalRank, 0);
  assert.equal(learned.engine.selectedRank, 1);
  assert.equal(learned.experienceSize, 2);
  assert.ok(learned.selected.experienceAdjustment > 0);
  assert.ok(learned.alternatives[0].experienceAdjustment < 0);
  assert.deepEqual(learned.experience, learned.selected.experience);
});

test("XUC3-2ZA5 BOT10 keeps a made point after entering from the bar", () => {
  const runtime = simulator.loadRuntime();
  const state = archivedState(runtime, XUC3_BOT10);
  const analysis = analyze(runtime, state);

  assert.deepEqual(
    rawTopPlan(runtime, state, analysis),
    [{ from: -1, die: 6 }, { from: 16, die: 3 }],
    "the archived top move must still identify the structural regression",
  );
  assert.deepEqual(
    plain(runtime.engine.plan(state)),
    [{ from: -1, die: 6 }, { from: 17, die: 3 }],
  );

  const decision = runtime.engine.consumeLastDecision();
  assert.equal(decision.engine.choiceReason, "near-equity-structural-safety");
  assert.equal(decision.engine.originalRank, 0);
  assert.equal(decision.engine.selectedRank, 1);
  assert.ok(decision.engine.originalEquity - decision.engine.equity < 0.025);
  assert.equal(decision.selected.features.madeGain, 0);
  assert.equal(decision.selected.features.primeGain, 0);
  assert.equal(decision.alternatives[0].features.madeGain, -1);
  assert.equal(decision.alternatives[0].features.primeGain, -1);
});

test("XUC3-2ZA5 BOT16 bears off two checkers when WildBG equities are tied", () => {
  const runtime = simulator.loadRuntime();
  const state = archivedState(runtime, XUC3_BOT16);
  const analysis = analyze(runtime, state);

  assert.deepEqual(
    rawTopPlan(runtime, state, analysis),
    [{ from: 19, die: 3 }, { from: 19, die: 5 }],
    "the saturated WildBG top move must reproduce the archived home shuffle",
  );
  const plan = runtime.engine.plan(state);
  assert.deepEqual(
    plain(plan),
    [{ from: 20, die: 5 }, { from: 22, die: 3 }],
  );

  const decision = runtime.engine.consumeLastDecision();
  assert.equal(decision.engine.choiceReason, "equal-equity-bearoff");
  assert.equal(decision.engine.policyPhase, "bearoff");
  assert.equal(decision.engine.originalRank, 0);
  assert.equal(decision.engine.selectedRank, 2);
  assert.equal(decision.engine.originalEquity, decision.engine.equity);
  assert.equal(decision.selected.features.offGain, 2);
  assert.equal(decision.selected.features.homeShuffleMoves, 0);

  const after = plain(state);
  simulator.applyPlan(runtime.game, after, plan, "hard bot");
  assert.equal(after.off.dark, 5);
});
