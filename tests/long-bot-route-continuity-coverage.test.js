const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
let cachedRuntime;

function loadRuntime() {
  if (cachedRuntime) return cachedRuntime;
  const sources = ["metrics", "evaluator", "analysis", "engine", "nardu-game-adapter", "browser"];
  const body = sources.map(name => fs.readFileSync(path.join(ROOT, "bot-engine/long", `${name}.ts`), "utf8")
    .replace(/^import\s+type[\s\S]*?;\s*$/gm, "")
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/gm, "")
    .replace(/^export\s+(?=(const|function|class))/gm, "")
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, "")).join("\n");
  const context = { window: {}, console, Date, Math, setTimeout, clearTimeout };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), context);
  vm.runInContext(`(function () { ${body}\nwindow.routeTestHelpers = {
    reserveRouteContinuityForTacticalAnalysis, isSafeRouteContinuityAlternative,
    hasBoundedFourPlyTactical,
  }; }());`, context);
  cachedRuntime = { engine: context.window.NarduLongBotEngine, helpers: context.window.routeTestHelpers };
  return cachedRuntime;
}

function state(white, dark, dice) {
  return {
    variant: "long", phase: "move", turn: "white", dice, rolled: dice,
    points: Object.fromEntries([
      ...Object.entries(white).map(([point, count]) => [point, { color: "white", count }]),
      ...Object.entries(dark).map(([point, count]) => [point, { color: "dark", count }]),
    ]),
    off: { white: 0, dark: 0 }, bar: { white: 0, dark: 0 }, score: { white: 0, dark: 0 },
    turnMoves: [], history: [], firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false },
  };
}

const production = {
  strategyProfile: "v25", maxCandidates: 64, analysisNodeBudget: 480,
  weights: {
    opponentHeadFreedom: 48000, headLandingExposure: 62000, headRelease: 9800,
    foothold: 4300, homeEntry: 145000, rushPenalty: 12500, trapRisk: 62000,
    escapeGatewayRisk: 800000, distribution: 780,
  },
};

function boundedTactical(overrides = {}) {
  return {
    plies: 4, expectedImpact: 0, worstImpact: 0,
    rolls: 21, distributionWeight: 36, distributionComplete: true, doublesExpanded: true,
    recoveryExpected: 0, recoveryWorst: 0, recoveryTailRisk: 0,
    recoveryRolls: 21, recoveryWeight: 36, recoveryDistributionComplete: true,
    continuationExpected: 0, continuationWorst: 0, continuationTailRisk: 0,
    continuationRolls: 21, continuationWeight: 36, continuationDistributionComplete: true,
    continuationModelComplete: true, continuationModelKind: "representative-worst-proxy-v1",
    continuationApproximate: true, continuationCoverageComplete: false,
    continuationFrontierCount: 2, continuationTotalFrontierCount: 10,
    continuationFrontierWeight: 3, continuationTotalFrontierWeight: 36,
    continuationProxyWeight: 36, continuationWorstRecoveryFrontierWeight: 1,
    continuationRepresentativeFrontierIncluded: true, continuationWorstFrontierIncluded: true,
    ...overrides,
  };
}

function candidate(id, score, shuffle, progress, tactical = boundedTactical()) {
  return {
    id, score, sequence: [{ from: 16, to: id, die: 1 }],
    after: { points: { [id]: { color: "white", count: 1 } }, off: { white: 0, dark: 0 } },
    features: {
      homeShuffleMoves: shuffle, outsidePipGain: progress, outsideReduction: 0,
      laggardDebtDelta: 0, startZoneReduction: 0, trapDelta: 0, fenceClosureDelta: 0,
      escapeGatewayDelta: 0, primeRunAfter: 5, maxRouteTowerAfter: 3,
    },
    tactical,
  };
}

test("route coverage keeps score-best plus a distinct minimum-shuffle maximum-progress reference", () => {
  const { helpers } = loadRuntime();
  const position = state({ 1: 1, 16: 14 }, { 15: 15 }, [3, 1]);
  const leader = candidate(1, 30, 2, 0);
  const bestScore = candidate(5, 20, 1, 3);
  const progress = candidate(6, 19, 0, 4);
  const ranked = [leader, candidate(2, 29, 2, 0), candidate(3, 28, 2, 0), candidate(4, 27, 2, 0), bestScore, progress];
  const reserved = helpers.reserveRouteContinuityForTacticalAnalysis(position, "white", ranked);
  assert.equal(bestScore.features.routeContinuityTacticalReservation, 1);
  assert.equal(progress.features.routeContinuityTacticalReservation, 1);
  assert.ok(reserved.slice(0, 4).includes(bestScore));
  assert.ok(reserved.slice(0, 4).includes(progress));
  assert.equal(bestScore.score, 20, "analysis reservations never promote scores");
  assert.equal(progress.score, 19, "analysis references never promote scores");
});

test("route progress promotion requires bounded deep coverage and rejects a continuation-tail cliff", () => {
  const { helpers } = loadRuntime();
  const selected = candidate(1, 20, 1, 3);
  const progress = candidate(2, 19, 0, 4);
  assert.equal(helpers.isSafeRouteContinuityAlternative(progress, selected), true);
  progress.tactical.continuationTailRisk = -5000001;
  assert.equal(helpers.isSafeRouteContinuityAlternative(progress, selected), false,
    "additional progress must not bypass the conservative 5M continuation-tail envelope");
  progress.tactical = boundedTactical({ continuationModelComplete: false });
  assert.equal(helpers.isSafeRouteContinuityAlternative(progress, selected), false,
    "missing sampled deep coverage cannot silently turn into a primary-only promotion");
});

test("completed-army ply55 analyzes no-shuffle route progress without releasing the real point13 blocker", () => {
  const { engine, helpers } = loadRuntime();
  // Exact lb4-7dae316d snapshot: neither terminal result nor future actual dice is used.
  const position = state(
    { 1: 1, 2: 3, 3: 1, 4: 1, 5: 1, 16: 4, 17: 1, 18: 1, 19: 1, 20: 1 },
    { 15: 9, 21: 3, 23: 3 }, [3, 1],
  );
  engine.setExperience([], "army-route55");
  const ranked = engine.rank(position, production);
  const progress = ranked.find(c => c.sequence.some(m => m.from === 16 && m.to === 13 && m.die === 3)
    && c.sequence.some(m => m.from === 13 && m.to === 12 && m.die === 1));
  assert.ok(progress, "legal zero-shuffle outside-progress reference must reach the deep beam");
  assert.equal(helpers.hasBoundedFourPlyTactical(progress), true);
  assert.equal(helpers.hasBoundedFourPlyTactical(ranked[0]), true);
  assert.equal(ranked[0].after.points[13]?.color, "white", "real blocker13 is retained rather than force-promoting progress");
  assert.equal(Number(progress.features.routeContinuityAdjustment || 0), 0);
  assert.ok(progress.tactical.continuationTailRisk < ranked[0].tactical.continuationTailRisk - 5000000);
});

test("completed-army ply57 production advances outside checkers instead of two home shuffles", () => {
  const { engine, helpers } = loadRuntime();
  // Exact lb4-924e7019 snapshot, preserving the occupied five-point prime16..20.
  const position = state(
    { 2: 2, 3: 1, 4: 3, 5: 1, 6: 1, 16: 2, 17: 2, 18: 1, 19: 1, 20: 1 },
    { 13: 1, 15: 6, 21: 3, 23: 4, 24: 1 }, [5, 4],
  );
  engine.setExperience([], "army-route57");
  const ranked = engine.rank(position, production);
  assert.equal(ranked[0].features.homeShuffleMoves, 0);
  assert.equal(ranked[0].features.outsidePipGain, 9);
  assert.equal(ranked[0].features.primeRunAfter, 5);
  assert.equal(helpers.hasBoundedFourPlyTactical(ranked[0]), true);
  assert.ok(ranked[0].sequence.some(m => m.from === 16 && m.to === 11 && m.die === 5));
  assert.ok(ranked[0].sequence.some(m => m.from === 11 && m.to === 7 && m.die === 4));
});
