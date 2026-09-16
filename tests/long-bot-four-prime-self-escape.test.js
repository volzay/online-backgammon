const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const REQUIRED = [
  'primeRunBefore', 'primeRunAfter', 'outsidePipGain', 'homeShuffleMoves',
  'trapDelta', 'fenceClosureDelta', 'escapeGatewayDelta',
  'latentFenceExposureBefore', 'latentFenceExposureDelta',
  'prospectiveFenceExtensionBefore', 'prospectiveFenceExtensionDelta',
  'headLandingBreak', 'routeTowerDelta', 'startZoneReduction',
  'resultSafetyBefore', 'resultSafetyAfter', 'primeSustainabilityBefore',
  'primeSustainabilityDelta', 'primeCrunchRiskBefore', 'primeCrunchRiskDelta',
  'laggardDebtDelta',
];
let cached;

function runtime() {
  if (cached) return cached;
  const names = ['metrics', 'evaluator', 'analysis', 'engine', 'nardu-game-adapter', 'browser'];
  const body = names.map(name => fs.readFileSync(path.join(ROOT, 'bot-engine/long', `${name}.ts`), 'utf8')
    .replace(/^import\s+type[\s\S]*?;\s*$/gm, '')
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(const|function|class))/gm, '')
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, '')).join('\n');
  const context = { window: {}, console, Date, Math, setTimeout, clearTimeout };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context);
  vm.runInContext(`(function () { ${body}\nwindow.fourSelfEscapeHelpers = {
    isFourPrimeSelfEscape, sequenceStats, advancedStateMetrics, advancedSequenceStats,
    blockingPrimeRun, outsideHomeCount, createLongBotEngine, createNarduGameAdapter,
    preservesLatentEscapePrime, isPlausibleLatentRearFenceEscape,
    isLatentRearFenceEscape, isDeepFenceSafetyRegression,
    hasBoundedFourPlyTactical, prioritizeDevelopingFenceEscape,
  }; }());`, context);
  cached = { game: context.window.NarduGame, helpers: context.window.fourSelfEscapeHelpers };
  return cached;
}

// Direct helper fixtures retain the exact native metric vectors of the legal
// archived turn, not a game result, future-dice label or a terminal rollout.
function rearEscapeFeatures(overrides = {}) {
  return {
    primeRunBefore: 4, primeRunAfter: 3, outsidePipGain: 3, homeShuffleMoves: 0,
    trapDelta: 0, fenceClosureDelta: 0, escapeGatewayDelta: 0,
    latentFenceExposureBefore: 36.580000000000005,
    latentFenceExposureDelta: 10.180000000000007,
    prospectiveFenceExtensionBefore: 0, prospectiveFenceExtensionDelta: 0,
    headLandingBreak: 0, routeTowerDelta: 0, startZoneReduction: 1,
    resultSafetyBefore: 0, resultSafetyAfter: 1,
    primeSustainabilityBefore: 0.7546666666666667,
    primeSustainabilityDelta: 0.2453333333333333,
    primeCrunchRiskBefore: 0, primeCrunchRiskDelta: 0, laggardDebtDelta: -31,
    ...overrides,
  };
}

function crunchEscapeFeatures(overrides = {}) {
  return {
    primeRunBefore: 4, primeRunAfter: 2, outsidePipGain: 5, homeShuffleMoves: 0,
    trapDelta: 0, fenceClosureDelta: 0, escapeGatewayDelta: 5.0414,
    latentFenceExposureBefore: 40.75, latentFenceExposureDelta: 0,
    prospectiveFenceExtensionBefore: 83.4496, prospectiveFenceExtensionDelta: 83.4496,
    headLandingBreak: 0, routeTowerDelta: 0, startZoneReduction: 1,
    resultSafetyBefore: 0, resultSafetyAfter: 0,
    primeSustainabilityBefore: 0.3288888888888889,
    primeSustainabilityDelta: 0.6711111111111111,
    primeCrunchRiskBefore: 0.5222888819458907,
    primeCrunchRiskDelta: 0.5222888819458907, laggardDebtDelta: 169,
    ...overrides,
  };
}

function state(color, dice, own, opponent) {
  const other = color === 'dark' ? 'white' : 'dark';
  return {
    variant: 'long', phase: 'move', turn: color, dice: [...dice], rolled: [...dice],
    points: Object.fromEntries([
      ...Object.entries(own).map(([point, count]) => [point, { color, count }]),
      ...Object.entries(opponent).map(([point, count]) => [point, { color: other, count }]),
    ]),
    off: { white: 0, dark: 0 }, bar: { white: 0, dark: 0 }, score: { white: 0, dark: 0 },
    turnMoves: [], history: [], headPlayedThisTurn: { white: false, dark: false },
    firstMoveDone: { white: true, dark: true }, winner: null, resultType: null,
    startedAt: 0, finishedAt: null, openingRoll: null,
    turnClock: { white: 0, dark: 0, active: null, startedAt: null },
    matchScore: { white: 0, dark: 0, target: 5, recordedWinner: null },
  };
}

function rearEscapeState() {
  return state('dark', [1, 2],
    { 2: 1, 4: 1, 5: 1, 6: 1, 7: 1, 13: 1, 14: 3, 16: 3, 17: 1, 18: 1, 22: 1 },
    { 1: 3, 3: 4, 8: 8 });
}

function crunchEscapeState() {
  return state('white', [3, 2],
    { 1: 2, 2: 3, 3: 3, 4: 3, 17: 1, 18: 1, 19: 1, 20: 1 },
    { 13: 1, 15: 3, 16: 5, 22: 3, 23: 3 });
}

const rearSequence = [{ from: 5, die: 1 }, { from: 7, die: 2 }];
const crunchSequence = [{ from: 17, die: 3 }, { from: 19, die: 2 }];
const rotate = point => (point + 11) % 24 + 1;

function mirror(position) {
  const result = plain(position);
  result.turn = position.turn === 'dark' ? 'white' : 'dark';
  result.points = Object.fromEntries(Object.entries(position.points).map(([point, stack]) => [
    rotate(+point), { color: stack.color === 'dark' ? 'white' : 'dark', count: stack.count },
  ]));
  return result;
}

function derivedFeatures(position, sequence) {
  const { helpers, game } = runtime();
  const after = plain(position);
  for (const move of sequence) {
    assert.equal(game.applyMove(after, move.from, move.die, { autoEnd: false }), true);
  }
  assert.equal(game.hasAnyMoves(after), false, 'fixture executes a complete legal turn');
  const features = helpers.sequenceStats(position, after, position.turn, sequence);
  Object.assign(features, helpers.advancedSequenceStats(
    helpers.advancedStateMetrics(position, position.turn), after, position.turn));
  return { features, after };
}

test('native rear-safety and timing-crunch vectors earn only four-prime score eligibility', () => {
  const { helpers } = runtime();
  assert.equal(helpers.isFourPrimeSelfEscape(rearEscapeFeatures()), true);
  assert.equal(helpers.isFourPrimeSelfEscape(crunchEscapeFeatures()), true);
});

test('exact thresholds permit both narrow escape types', () => {
  const { helpers } = runtime();
  assert.equal(helpers.isFourPrimeSelfEscape(rearEscapeFeatures({
    primeRunAfter: 3, latentFenceExposureBefore: 24, latentFenceExposureDelta: 0.001,
    startZoneReduction: 0.001, resultSafetyBefore: 0, resultSafetyAfter: 0.001,
  })), true);
  assert.equal(helpers.isFourPrimeSelfEscape(crunchEscapeFeatures({
    primeSustainabilityBefore: 0.379999, primeSustainabilityDelta: 0.06,
    primeCrunchRiskBefore: 0.45, primeCrunchRiskDelta: 0.2,
    prospectiveFenceExtensionBefore: 40, prospectiveFenceExtensionDelta: 40,
    laggardDebtDelta: 0.001,
  })), true);
});

test('all common safety gates reject both escape branches without coercion', () => {
  const { helpers } = runtime();
  const mutations = [
    { primeRunBefore: 3 }, { primeRunBefore: 5 }, { primeRunBefore: 6 },
    { primeRunBefore: 4.000001 }, { primeRunAfter: 1 }, { primeRunAfter: 5 },
    { primeRunAfter: 2.5 }, { outsidePipGain: 0 }, { outsidePipGain: -1 },
    { homeShuffleMoves: 1 }, { homeShuffleMoves: -1 }, { trapDelta: -0.001 },
    { fenceClosureDelta: -0.001 }, { escapeGatewayDelta: -0.001 },
    { latentFenceExposureDelta: -0.001 }, { prospectiveFenceExtensionDelta: -0.001 },
    { headLandingBreak: 1 }, { headLandingBreak: -1 }, { routeTowerDelta: -0.001 },
    { resultSafetyBefore: 1, resultSafetyAfter: 0 },
  ];
  for (const fixture of [rearEscapeFeatures, crunchEscapeFeatures]) {
    for (const mutation of mutations) {
      assert.equal(helpers.isFourPrimeSelfEscape(fixture(mutation)), false,
        `${fixture.name}: ${JSON.stringify(mutation)}`);
    }
  }
});

test('rear relief requires a retained three-prime and strict rear/result-safety gain', () => {
  const { helpers } = runtime();
  for (const mutation of [
    { primeRunAfter: 2 }, { latentFenceExposureBefore: 23.999999 },
    { latentFenceExposureDelta: 0 }, { startZoneReduction: 0 },
    { resultSafetyAfter: 0 },
  ]) {
    assert.equal(helpers.isFourPrimeSelfEscape(rearEscapeFeatures(mutation)), false,
      JSON.stringify(mutation));
  }
});

test('timing relief requires every established unsustainability/crunch/prospective threshold', () => {
  const { helpers } = runtime();
  for (const mutation of [
    { primeSustainabilityBefore: 0.38 }, { primeCrunchRiskBefore: 0.449999 },
    { primeSustainabilityDelta: 0.059999 }, { primeCrunchRiskDelta: 0.199999 },
    { prospectiveFenceExtensionBefore: 39.999999 },
    { prospectiveFenceExtensionDelta: 39.999999 }, { laggardDebtDelta: 0 },
  ]) {
    assert.equal(helpers.isFourPrimeSelfEscape(crunchEscapeFeatures(mutation)), false,
      JSON.stringify(mutation));
  }
});

test('every used field is required as a native finite number in both branches', () => {
  const { helpers } = runtime();
  assert.equal(helpers.isFourPrimeSelfEscape(null), false);
  assert.equal(helpers.isFourPrimeSelfEscape(undefined), false);
  for (const fixture of [rearEscapeFeatures, crunchEscapeFeatures]) {
    for (const key of REQUIRED) {
      const missing = fixture();
      delete missing[key];
      assert.equal(helpers.isFourPrimeSelfEscape(missing), false, `${fixture.name}: missing ${key}`);
      for (const value of [undefined, null, false, true, '', String(fixture()[key]),
        NaN, Infinity, -Infinity, new Number(fixture()[key])]) {
        assert.equal(helpers.isFourPrimeSelfEscape(fixture({ [key]: value })), false,
          `${fixture.name}: malformed ${key}: ${String(value)}`);
      }
    }
  }
});

test('the ordinary game6 four-prime collapse is not a self-escape', () => {
  const { helpers } = runtime();
  const position = state('dark', [4, 3],
    { 1: 1, 5: 1, 7: 1, 8: 1, 9: 1, 10: 1, 13: 1, 14: 4, 16: 3, 18: 1 },
    { 3: 4, 4: 1, 6: 2, 11: 3, 12: 4, 17: 1 });
  const { features } = derivedFeatures(position, [{ from: 10, die: 3 }, { from: 9, die: 4 }]);
  assert.equal(features.primeRunBefore, 4);
  assert.equal(features.primeRunAfter, 2);
  assert.ok(features.latentFenceExposureDelta < 0);
  assert.ok(features.escapeGatewayDelta < 0);
  assert.equal(helpers.isFourPrimeSelfEscape(features), false);
});

function rearCoveragePair(overrides = {}) {
  const selected = {
    score: 0, experienceAdjustment: 0,
    features: rearEscapeFeatures({
      primeRunAfter: 4, primeScoreBefore: 419.84, opponentMoveBlockBefore: 265,
      latentFenceExposureDelta: 0, startZoneReduction: 0, resultSafetyAfter: 0,
      outsideReduction: 0, maxRouteTowerAfter: 3,
    }),
  };
  const escape = {
    score: -1000000, experienceAdjustment: 0,
    features: rearEscapeFeatures({
      primeScoreBefore: 419.84, opponentMoveBlockBefore: 265,
      outsideReduction: 0, maxRouteTowerAfter: 3, ...overrides,
    }),
  };
  return { selected, escape };
}

test('exposed four-to-three rear escape receives candidate coverage, not a forced final choice', () => {
  const { helpers } = runtime();
  const { selected, escape } = rearCoveragePair();
  assert.equal(helpers.preservesLatentEscapePrime(escape, selected), true);
  assert.equal(helpers.isPlausibleLatentRearFenceEscape(escape, selected), true);
  assert.equal(helpers.isLatentRearFenceEscape(escape, selected), false,
    'static eligibility alone does not supply tactical proof');
  escape.score = -420000001;
  assert.equal(helpers.isPlausibleLatentRearFenceEscape(escape, selected), false,
    'the existing 420M cold score tolerance is not widened');
});

test('rear coverage does not widen two-point, five-point or unsafe four-point sacrifices', () => {
  const { helpers } = runtime();
  for (const mutation of [
    { primeRunAfter: 2 }, { trapDelta: -0.001 }, { fenceClosureDelta: -0.001 },
    { escapeGatewayDelta: -0.001 }, { latentFenceExposureDelta: 0 },
    { prospectiveFenceExtensionDelta: -0.001 }, { headLandingBreak: 1 },
    { routeTowerDelta: -0.001 }, { startZoneReduction: 0 }, { resultSafetyAfter: 0 },
  ]) {
    const { selected, escape } = rearCoveragePair(mutation);
    assert.equal(helpers.preservesLatentEscapePrime(escape, selected), false,
      JSON.stringify(mutation));
  }
  const { selected, escape } = rearCoveragePair({ primeRunBefore: 5, primeRunAfter: 4 });
  selected.features.primeRunBefore = 5;
  selected.features.primeRunAfter = 5;
  assert.equal(helpers.preservesLatentEscapePrime(escape, selected), false,
    'the new rear coverage path is exclusive to an exact four-prime');
});

test('rear coverage uses strict native escape fields and preserves legacy inactive one-point behavior', () => {
  const { helpers } = runtime();
  for (const key of REQUIRED) {
    // Keep this probe on the shortened-run path. The pre-existing early
    // return for a run numerically >= the selected run is outside the new
    // exemption; the direct helper test above rejects both infinities.
    const nonfinite = key === 'primeRunAfter' ? -Infinity : Infinity;
    for (const value of [undefined, null, false, String(rearEscapeFeatures()[key]), NaN, nonfinite]) {
      const { selected, escape } = rearCoveragePair({ [key]: value });
      assert.equal(helpers.preservesLatentEscapePrime(escape, selected), false,
        `malformed coverage field ${key}: ${String(value)}`);
    }
  }
  const { selected, escape } = rearCoveragePair({
    primeRunAfter: 1, primeScoreBefore: 0, opponentMoveBlockBefore: 0,
  });
  selected.features.primeRunAfter = 2;
  assert.equal(helpers.isFourPrimeSelfEscape(escape.features), false);
  assert.equal(helpers.preservesLatentEscapePrime(escape, selected), true,
    'nonblocking/inactive one-point shortening retains its existing rule');
});

function boundedTactical(overrides = {}) {
  return {
    plies: 4, rolls: 21, distributionWeight: 36, distributionComplete: true,
    doublesExpanded: true, recoveryRolls: 21, recoveryWeight: 36,
    recoveryDistributionComplete: true, continuationRolls: 21, continuationWeight: 36,
    continuationDistributionComplete: true, continuationModelComplete: true,
    continuationModelKind: 'representative-worst-proxy-v1',
    continuationApproximate: true, continuationCoverageComplete: false,
    continuationFrontierCount: 2, continuationTotalFrontierCount: 10,
    continuationFrontierWeight: 3, continuationTotalFrontierWeight: 36,
    continuationProxyWeight: 36, continuationWorstRecoveryFrontierWeight: 1,
    continuationRepresentativeFrontierIncluded: true, continuationWorstFrontierIncluded: true,
    expectedImpact: 0, worstImpact: 0, recoveryExpected: 0, recoveryWorst: 0,
    recoveryTailRisk: 0, continuationExpected: 0, continuationWorst: 0,
    continuationTailRisk: 0, ...overrides,
  };
}

test('eligible four-prime rear coverage cannot bypass an existing catastrophic deep fence veto', () => {
  const { helpers } = runtime();
  const { selected, escape } = rearCoveragePair();
  selected.features.fenceClosureDelta = 13;
  selected.features.fenceClosureBefore = 13;
  escape.features.fenceClosureBefore = 13;
  selected.tactical = boundedTactical();
  escape.tactical = boundedTactical({ continuationWorst: -900000000 });
  assert.equal(helpers.hasBoundedFourPlyTactical(selected), true);
  assert.equal(helpers.hasBoundedFourPlyTactical(escape), true);
  assert.equal(helpers.preservesLatentEscapePrime(escape, selected), true);
  assert.equal(helpers.isLatentRearFenceEscape(escape, selected), true,
    'primary reply margins alone pass this deliberately catastrophic continuation');
  assert.equal(helpers.isDeepFenceSafetyRegression(escape, selected), true);
  const before = plain([selected, escape]);
  assert.equal(helpers.prioritizeDevelopingFenceEscape(
    rearEscapeState(), 'dark', [selected, escape])[0], selected,
  'candidate coverage never buys a final override through the deep veto');
  assert.deepEqual(plain([selected, escape]), before);
});

for (const [name, position, sequence, afterRun] of [
  ['2XLZ34', rearEscapeState(), rearSequence, 3],
  ['four-laggards', crunchEscapeState(), crunchSequence, 2],
]) {
  for (const mirrored of [false, true]) {
    const current = mirrored ? mirror(position) : plain(position);
    const expected = mirrored
      ? sequence.map(move => ({ from: rotate(move.from), die: move.die }))
      : sequence;
    test(`${name} legal rules-derived self-escape passes its exact native gates (${current.turn})`, () => {
      const { helpers } = runtime();
      const before = plain(current);
      const { features, after } = derivedFeatures(current, expected);
      assert.equal(features.primeRunBefore, 4);
      assert.equal(features.primeRunAfter, afterRun);
      const malformed = REQUIRED.filter(key => !Number.isFinite(features[key]));
      assert.deepEqual(malformed, [], `missing actual sequence fields: ${malformed.join(', ')}`);
      assert.equal(helpers.isFourPrimeSelfEscape(features), true,
        `native gate vector: ${JSON.stringify(Object.fromEntries(REQUIRED.map(key => [key, features[key]])))}`);
      assert.equal(helpers.blockingPrimeRun(after, current.turn), afterRun);
      assert.deepEqual(current, before, 'feature derivation never mutates the original board');
    });
    test(`${name} production-budget rank retains the exact legal escape (${current.turn})`, () => {
      const { helpers, game } = runtime();
      const before = plain(current);
      const engine = helpers.createLongBotEngine(helpers.createNarduGameAdapter(game));
      const ranked = engine.rank(current, current.turn, {
        strategyProfile: 'v25', maxCandidates: 64, analysisNodeBudget: 480,
      });
      assert.ok(ranked.length > 1);
      const selected = ranked[0];
      assert.deepEqual(plain(selected.sequence).map(({ from, die }) => ({ from, die })), expected);
      assert.equal(helpers.isFourPrimeSelfEscape(selected.features), true);
      assert.equal(selected.features.primeRunBefore, 4);
      assert.equal(selected.features.primeRunAfter, afterRun);
      assert.equal(selected.features.homeShuffleMoves, 0);
      assert.ok(selected.features.analysisNodesUsed <= 480);
      const executed = plain(current);
      for (const move of selected.sequence) {
        assert.equal(game.applyMove(executed, move.from, move.die, { autoEnd: false }), true);
      }
      assert.equal(game.hasAnyMoves(executed), false, 'ranked escape consumes a maximal legal turn');
      assert.equal(helpers.blockingPrimeRun(executed, current.turn), afterRun);
      assert.deepEqual(current, before, 'native ranking preserves its entire input');
    });
  }
}
