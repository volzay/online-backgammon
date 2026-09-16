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
    dice: [...dice],
    rolled: [...dice],
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

function rank(gameState) {
  return loadEngine().rank(gameState, {
    strategyProfile: "v25",
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
}

function darkSignature(candidate) {
  return Object.entries(candidate.after.points)
    .filter(([, point]) => point?.color === "dark")
    .map(([index, point]) => [Number(index), point.count])
    .sort((left, right) => left[0] - right[0])
    .map(([index, count]) => `${index}:${count}`)
    .join("|");
}

function findByDarkSignature(ranked, signature) {
  return ranked.find(candidate => darkSignature(candidate) === signature);
}

function assertFourPlyTelemetry(candidate) {
  assert.ok(candidate?.tactical, "the candidate must receive tactical analysis");
  assert.equal(candidate.tactical.plies, 4);
  assert.equal(candidate.tactical.rolls, 21);
  assert.equal(candidate.tactical.distributionWeight, 36);
  assert.equal(candidate.tactical.distributionComplete, true);
  assert.equal(candidate.tactical.recoveryRolls, 21);
  assert.equal(candidate.tactical.recoveryWeight, 36);
  assert.equal(candidate.tactical.recoveryDistributionComplete, true);
  assert.equal(candidate.tactical.continuationRolls, 21);
  assert.equal(candidate.tactical.continuationWeight, 36);
  assert.equal(candidate.tactical.continuationDistributionComplete, true);
  assert.equal(candidate.tactical.continuationModelComplete, true);
  assert.equal(candidate.tactical.continuationModelKind, 'representative-worst-proxy-v1');
  assert.ok(candidate.tactical.continuationFrontierWeight >= 1);
  assert.ok(candidate.tactical.continuationFrontierWeight <= 36);
  assert.equal(candidate.tactical.continuationTotalFrontierWeight, 36);
  assert.equal(candidate.tactical.continuationProxyWeight, 36);
  assert.equal(
    candidate.tactical.continuationCoverageComplete,
    candidate.tactical.continuationFrontierWeight === 36,
  );
  assert.equal(candidate.tactical.continuationRepresentativeFrontierIncluded, true);
  assert.equal(candidate.tactical.continuationWorstFrontierIncluded, true);
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

function hostilePatterns(gameState, safeSequence, unsafeSequence) {
  const target = loadEngine();
  const safe = target.describeSequence(gameState, safeSequence, {
    strategyProfile: "v25",
    color: "dark",
  }).experience;
  const unsafe = target.describeSequence(gameState, unsafeSequence, {
    strategyProfile: "v25",
    color: "dark",
  }).experience;
  const safeKeys = new Set(descriptorKeys(safe));
  const unsafeKeys = new Set(descriptorKeys(unsafe));
  const rewardedUnsafeKeys = [...unsafeKeys].filter(key => !safeKeys.has(key));
  const penalizedSafeKeys = [...safeKeys].filter(key => !unsafeKeys.has(key));

  assert.ok(rewardedUnsafeKeys.length > 0, "the unsafe move must expose a distinct reward key");
  assert.ok(penalizedSafeKeys.length > 0, "the safe move must expose a distinct penalty key");

  return [
    ...rewardedUnsafeKeys.map(actionKey => ({
      creditVersion: 7,
      contextKey: unsafe.contextKey,
      actionKey,
      samples: 120,
      wins: 120,
      losses: 0,
      winWeight: 360,
      lossWeight: 0,
      severeLosses: 0,
      signalWeight: 0,
    })),
    ...penalizedSafeKeys.map(actionKey => ({
      creditVersion: 7,
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

const KQZQ_POINTS = {
  5: { color: "dark", count: 1 },
  9: { color: "white", count: 1 },
  11: { color: "white", count: 1 },
  12: { color: "dark", count: 13 },
  17: { color: "white", count: 1 },
  21: { color: "white", count: 1 },
  22: { color: "dark", count: 1 },
  23: { color: "white", count: 1 },
  24: { color: "white", count: 10 },
};
const KQZQ_SAFE_SIGNATURE = "2:1|10:1|12:12|22:1";
const KQZQ_ARCHIVED_SIGNATURE = "5:1|7:1|12:12|22:1";
const KQZQ_SAFE_SEQUENCE = [
  { from: 5, die: 3 },
  { from: 12, die: 2 },
];
const KQZQ_ARCHIVED_SEQUENCE = [
  { from: 12, die: 2 },
  { from: 10, die: 3 },
];

const LD4P_POINTS = {
  1: { color: "dark", count: 1 },
  5: { color: "dark", count: 1 },
  9: { color: "dark", count: 1 },
  11: { color: "white", count: 1 },
  12: { color: "dark", count: 12 },
  17: { color: "white", count: 1 },
  18: { color: "white", count: 1 },
  21: { color: "white", count: 1 },
  22: { color: "white", count: 1 },
  23: { color: "white", count: 1 },
  24: { color: "white", count: 9 },
};
const LD4P_SAFE_SIGNATURE = "1:2|8:1|9:1|12:11";
const LD4P_ARCHIVED_SIGNATURE = "1:1|4:1|5:1|9:1|12:11";
const LD4P_SAFE_SEQUENCE = [
  { from: 5, die: 2 },
  { from: 3, die: 2 },
  { from: 12, die: 2 },
  { from: 10, die: 2 },
];
const LD4P_ARCHIVED_SEQUENCE = [
  { from: 12, die: 2 },
  { from: 10, die: 2 },
  { from: 8, die: 2 },
  { from: 6, die: 2 },
];

test("KQZQ-K5WZ decision 5 retains the new point-10 interruption anchor", () => {
  const target = loadEngine();
  target.setExperience([], "kqzq-cold");
  const ranked = rank(roomState(KQZQ_POINTS, [2, 3]));
  const selected = ranked[0];
  const archived = findByDarkSignature(ranked, KQZQ_ARCHIVED_SIGNATURE);

  assert.ok(selected, "the hard bot must return a move");
  assert.equal(darkSignature(selected), KQZQ_SAFE_SIGNATURE, JSON.stringify(
    ranked.map(candidate => ({
      signature: darkSignature(candidate),
      route: candidate.features.routeSignature,
      score: candidate.score,
      prospectiveAfter: candidate.features.prospectiveFenceExtensionAfter,
      recoveryExpected: candidate.tactical?.recoveryExpected,
      continuationExpected: candidate.tactical?.continuationExpected,
      continuationWorst: candidate.tactical?.continuationWorst,
    })),
  ));
  assert.equal(selected.features.routeSignature, "0>0+2>3");
  assert.ok(archived, "the archived through-move must remain available for comparison");
  assert.equal(archived.features.routeSignature, "0>0+0>1");
  assert.ok(
    selected.features.prospectiveFenceExtensionAfter
      <= archived.features.prospectiveFenceExtensionAfter - 45,
  );
  assert.ok(selected.tactical.recoveryExpected >= archived.tactical.recoveryExpected + 20000000);
  assert.ok(
    selected.tactical.continuationExpected
      >= archived.tactical.continuationExpected + 100000000,
  );
  assert.ok(
    selected.tactical.continuationWorst
      >= archived.tactical.continuationWorst + 300000000,
  );
  assert.equal(selected.features.avoidableProspectiveFenceAnchorMiss, 0);
  assert.ok(archived.features.avoidableProspectiveFenceAnchorMiss >= 45);
  assert.ok(
    archived.experience.behaviorActionKeys.includes(
      "prospective-fence:avoidable-anchor-miss",
    ),
  );
  assert.ok(archived.experience.mistakeSeverity > selected.experience.mistakeSeverity);
  assert.ok(archived.experience.riskSignal > selected.experience.riskSignal);
});

test("LD4P-VMXU decision 5 splits double two instead of vacating every new anchor", () => {
  const target = loadEngine();
  target.setExperience([], "ld4p-cold");
  const ranked = rank(roomState(LD4P_POINTS, [2, 2, 2, 2]));
  const selected = ranked[0];
  const archived = findByDarkSignature(ranked, LD4P_ARCHIVED_SIGNATURE);

  assert.ok(selected, "the hard bot must return a move");
  assert.equal(darkSignature(selected), LD4P_SAFE_SIGNATURE, JSON.stringify(
    ranked.slice(0, 8).map(candidate => ({
      signature: darkSignature(candidate),
      route: candidate.features.routeSignature,
      score: candidate.score,
      fenceDelta: candidate.features.fenceClosureDelta,
      recoveryExpected: candidate.tactical?.recoveryExpected,
      continuationWorst: candidate.tactical?.continuationWorst,
      fenceEscapeAdjustment: candidate.features.developingFenceEscapeAdjustment,
    })),
  ));
  assert.equal(selected.features.routeSignature, "0>0+0>1+2>3+3>3");
  assert.ok(archived, "the archived single-checker run must remain available for comparison");
  assert.equal(archived.features.routeSignature, "0>0+0>1+1>2+2>2");
  assert.ok(selected.features.fenceClosureDelta >= archived.features.fenceClosureDelta + 30);
  assert.ok(selected.tactical.recoveryExpected >= archived.tactical.recoveryExpected + 40000000);
  assert.ok(
    selected.tactical.continuationWorst
      >= archived.tactical.continuationWorst + 9000000,
  );
});

test("KQZQ and LD4P alternatives are compared with bounded four-ply fair-dice telemetry", () => {
  const target = loadEngine();
  target.setExperience([], "kqzq-ld4p-telemetry");
  const fixtures = [
    {
      ranked: rank(roomState(KQZQ_POINTS, [2, 3])),
      safe: KQZQ_SAFE_SIGNATURE,
      archived: KQZQ_ARCHIVED_SIGNATURE,
    },
    {
      ranked: rank(roomState(LD4P_POINTS, [2, 2, 2, 2])),
      safe: LD4P_SAFE_SIGNATURE,
      archived: LD4P_ARCHIVED_SIGNATURE,
    },
  ];

  fixtures.forEach(({ ranked, safe, archived }) => {
    assertFourPlyTelemetry(findByDarkSignature(ranked, safe));
    assertFourPlyTelemetry(findByDarkSignature(ranked, archived));
    assert.ok(ranked[0].features.choiceCount > 1);
    assert.ok(ranked[0].features.analysisNodesUsed <= 480);
  });
});

test("KQZQ and LD4P defensive anchors survive hostile learned memory", async t => {
  const target = loadEngine();
  const fixtures = [
    {
      name: "KQZQ-K5WZ",
      state: roomState(KQZQ_POINTS, [2, 3]),
      safeSignature: KQZQ_SAFE_SIGNATURE,
      archivedSignature: KQZQ_ARCHIVED_SIGNATURE,
      safeSequence: KQZQ_SAFE_SEQUENCE,
      archivedSequence: KQZQ_ARCHIVED_SEQUENCE,
    },
    {
      name: "LD4P-VMXU",
      state: roomState(LD4P_POINTS, [2, 2, 2, 2]),
      safeSignature: LD4P_SAFE_SIGNATURE,
      archivedSignature: LD4P_ARCHIVED_SIGNATURE,
      safeSequence: LD4P_SAFE_SEQUENCE,
      archivedSequence: LD4P_ARCHIVED_SEQUENCE,
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      target.setExperience(
        hostilePatterns(fixture.state, fixture.safeSequence, fixture.archivedSequence),
        `${fixture.name}-hostile`,
      );
      try {
        const ranked = rank(fixture.state);
        const selected = ranked[0];
        const safe = findByDarkSignature(ranked, fixture.safeSignature);
        const archived = findByDarkSignature(ranked, fixture.archivedSignature);

        assert.ok(safe, "hostile memory must not remove the safe comparison");
        assert.ok(archived, "hostile memory must not remove the unsafe comparison");
        assert.ok(
          safe.experienceAdjustment < archived.experienceAdjustment,
          "the test must actively penalize the safe move relative to the archived move",
        );
        assert.equal(darkSignature(selected), fixture.safeSignature, JSON.stringify({
          selected: darkSignature(selected),
          safeExperience: safe.experienceAdjustment,
          archivedExperience: archived.experienceAdjustment,
        }));
      } finally {
        target.setExperience([], `${fixture.name}-hostile`);
      }
    });
  }
});
