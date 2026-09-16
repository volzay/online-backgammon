const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
let cached;

function runtime() {
  if (cached) return cached;
  const names = ['metrics', 'evaluator', 'analysis', 'engine', 'nardu-game-adapter', 'browser'];
  const engineSource = fs.readFileSync(path.join(ROOT, 'bot-engine/long/engine.ts'), 'utf8');
  const start = engineSource.indexOf('function advancedStrategyAdjustment(');
  const end = engineSource.indexOf('\nfunction advancedStateMetrics(', start);
  assert.ok(start >= 0 && end > start);
  // A narrow prior-threshold reference proves that unrelated score paths are
  // unchanged. It never ranks, chooses a move or observes a terminal outcome.
  const priorThreshold = engineSource.slice(start, end)
    .replace('function advancedStrategyAdjustment(', 'function priorThresholdAdjustment(')
    .replace('const activeLockBreak = effectivePrimeRunBefore >= 4',
      'const activeLockBreak = effectivePrimeRunBefore >= 5');
  assert.match(priorThreshold, /const activeLockBreak = effectivePrimeRunBefore >= 5/);
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
  vm.runInContext(`(function () { ${body}\n${priorThreshold}\nwindow.fourPrimeHelpers = {
    advancedStrategyAdjustment, priorThresholdAdjustment, blockingPrimeRun,
    outsideHomeCount, pipsFor, createLongBotEngine, createNarduGameAdapter,
  }; }());`, context);
  cached = { game: context.window.NarduGame, helpers: context.window.fourPrimeHelpers };
  return cached;
}

// Rules-derived prefix replay of captured game6/pair3/dark, trace index59,
// ply60 after applyRoll([4,3]); not an inverse reconstruction or causal label.
// Capture SHA850d2e3abe4ed3bfe192492c8302c6dc24397d44fbf300b6b52381ea6226b46f;
// replay rules SHA769c571ad10cefa75a8c128aba5123df47684780fad1136a0ae98f3342f33e4b.
function game6Ply60() {
  const dark = { 1: 1, 5: 1, 7: 1, 8: 1, 9: 1, 10: 1, 13: 1, 14: 4, 16: 3, 18: 1 };
  const white = { 3: 4, 4: 1, 6: 2, 11: 3, 12: 4, 17: 1 };
  return {
    variant: 'long', phase: 'move', turn: 'dark',
    points: Object.fromEntries([
      ...Object.entries(dark).map(([point, count]) => [point, { color: 'dark', count }]),
      ...Object.entries(white).map(([point, count]) => [point, { color: 'white', count }]),
    ]),
    bar: { white: 0, dark: 0 }, off: { white: 0, dark: 0 }, score: { white: 0, dark: 0 },
    dice: [4, 3], rolled: [4, 3], firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false }, turnMoves: [], history: [],
    winner: null, resultType: null, openingRoll: null, startedAt: 0, finishedAt: null,
    turnClock: { white: 0, dark: 0, active: null, startedAt: null },
    matchScore: { white: 0, dark: 0, target: 5, recordedWinner: null },
  };
}

function collapseFeatures(overrides = {}) {
  return {
    primeRunBefore: 4, primeRunAfter: 2,
    primeScoreBefore: 436.64, primeScoreAfter: 16.8, primeScoreGain: -419.84,
    opponentMoveBlockGain: -201, trapBefore: 0, trapDelta: 0,
    opponentFenceRunBefore: 2, maxRouteTowerAfter: 4, routeTowerDelta: 0,
    laggardDebtDelta: 421, outsidePipGain: 7, homeShuffleMoves: 0,
    homeEntryMoves: 0, fenceClosureDelta: 0, escapeGatewayDelta: 1.9544,
    primeSustainabilityAfter: 1, primeSustainabilityDelta: 0.3897777777777778,
    primeCrunchRiskAfter: 0, primeCrunchRiskDelta: 0,
    ...overrides,
  };
}

const production = {
  strategyProfile: 'v25', maxCandidates: 64, analysisNodeBudget: 480,
  weights: {
    distribution: 780, escapeGatewayRisk: 800000, foothold: 4300,
    headLandingExposure: 62000, headRelease: 9800, homeEntry: 145000,
    opponentHeadFreedom: 48000, rushPenalty: 12500, trapRisk: 62000,
  },
};

test('an active four-point collapse does not masquerade as safe late route progress', () => {
  const { helpers } = runtime();
  const position = game6Ply60();
  assert.equal(helpers.outsideHomeCount(position, 'dark'), 6);
  assert.equal(helpers.blockingPrimeRun(position, 'dark'), 4);
  assert.equal(helpers.pipsFor(position, 'dark'), 139);
  assert.equal(helpers.pipsFor(position, 'white'), 126);
  const features = collapseFeatures();
  const current = helpers.advancedStrategyAdjustment(position, 'dark', features);
  const prior = helpers.priorThresholdAdjustment(position, 'dark', features);
  assert.ok(current < prior - 100000000, 'restore established-prime penalties, not a tiny tie-breaking bonus');
  assert.equal(current, helpers.advancedStrategyAdjustment(position, 'dark',
    collapseFeatures({ outsidePipGain: 0 })), 'breaking an active lock earns no safe-race progress exemption');
});

test('four-point activity detects shortened run, diminished lock score or lost move restriction', () => {
  const { helpers } = runtime();
  const position = game6Ply60();
  const neutral = collapseFeatures({ primeRunAfter: 4, primeScoreAfter: 436.64,
    primeScoreGain: 0, opponentMoveBlockGain: 0, primeSustainabilityDelta: 0 });
  for (const [name, mutation] of [
    ['shortened run', { primeRunAfter: 3 }],
    ['diminished active lock', { primeScoreAfter: 436.63, primeScoreGain: -0.01 }],
    ['lost move restriction', { opponentMoveBlockGain: -0.01 }],
  ]) {
    const features = { ...neutral, ...mutation };
    assert.equal(helpers.advancedStrategyAdjustment(position, 'dark', features),
      helpers.advancedStrategyAdjustment(position, 'dark', { ...features, outsidePipGain: 0 }), name);
    assert.ok(helpers.advancedStrategyAdjustment(position, 'dark', features)
      < helpers.priorThresholdAdjustment(position, 'dark', features), name);
  }
});

test('nonblocking, three-point and preserved four/five-point routes keep prior scoring', () => {
  const { helpers } = runtime();
  const position = game6Ply60();
  for (const [name, features] of [
    ['nonblocking run', collapseFeatures({ primeScoreBefore: 0 })],
    ['three-point contact', collapseFeatures({ primeRunBefore: 3 })],
    ['preserved four', collapseFeatures({ primeRunAfter: 4, primeScoreAfter: 436.64,
      primeScoreGain: 0, opponentMoveBlockGain: 0 })],
    ['preserved five', collapseFeatures({ primeRunBefore: 5, primeRunAfter: 5,
      primeScoreAfter: 436.64, primeScoreGain: 0, opponentMoveBlockGain: 0 })],
    ['five-point collapse', collapseFeatures({ primeRunBefore: 5 })],
  ]) {
    assert.equal(helpers.advancedStrategyAdjustment(position, 'dark', features),
      helpers.priorThresholdAdjustment(position, 'dark', features), name);
  }
  const preserved = collapseFeatures({ primeRunAfter: 4, primeScoreAfter: 436.64,
    primeScoreGain: 0, opponentMoveBlockGain: 0 });
  assert.equal(helpers.advancedStrategyAdjustment(position, 'dark', preserved)
    - helpers.advancedStrategyAdjustment(position, 'dark', { ...preserved, outsidePipGain: 0 }),
  28000000, 'safe defense-preserving route progress is not suppressed');
});

test('head/outside late-race exclusions and critical five-point trap escape remain unchanged', () => {
  const { helpers } = runtime();
  const base = game6Ply60();
  const ownHead = plain(base);
  ownHead.points[3].count += ownHead.points[12].count;
  ownHead.points[12] = { color: 'dark', count: 1 };
  ownHead.points[14].count -= 1;
  const opponentHead = plain(base);
  opponentHead.points[24] = { color: 'white', count: 1 };
  opponentHead.points[3].count -= 1;
  const outsideSeven = plain(base);
  outsideSeven.points[1].count += 1;
  outsideSeven.points[14].count -= 1;
  for (const [name, position] of [['own head', ownHead], ['opponent head', opponentHead],
    ['outside seven', outsideSeven]]) {
    const features = collapseFeatures();
    assert.equal(helpers.advancedStrategyAdjustment(position, 'dark', features),
      helpers.priorThresholdAdjustment(position, 'dark', features), name);
  }
  const emergency = collapseFeatures({ primeRunBefore: 5, trapBefore: 240, laggardDebtDelta: 120 });
  assert.equal(helpers.advancedStrategyAdjustment(base, 'dark', emergency),
    helpers.priorThresholdAdjustment(base, 'dark', emergency), 'existing critical five-point escape is preserved');
  const four = { ...emergency, primeRunBefore: 4 };
  assert.ok(helpers.advancedStrategyAdjustment(base, 'dark', four)
    < helpers.priorThresholdAdjustment(base, 'dark', four), 'the separate critical escape is not widened to four');
  assert.equal(helpers.advancedStrategyAdjustment(base, 'dark', four),
    helpers.advancedStrategyAdjustment(base, 'dark', { ...four, laggardDebtDelta: 119 }),
    'the critical escape threshold at 120 must still apply only to five or more');
  assert.ok(helpers.advancedStrategyAdjustment(base, 'dark', emergency)
    > helpers.advancedStrategyAdjustment(base, 'dark', { ...emergency, laggardDebtDelta: 119 }),
    'the existing five-point critical escape remains available');
});

test('negative native safety deltas never restore a four-point lock-break race exemption', () => {
  const { helpers } = runtime();
  const position = game6Ply60();
  for (const mutation of [{ trapDelta: -1 }, { fenceClosureDelta: -1 },
    { escapeGatewayDelta: -1 }, { headLandingBreak: 1 }]) {
    const features = collapseFeatures({ trapBefore: 240, laggardDebtDelta: 0, ...mutation });
    assert.equal(helpers.advancedStrategyAdjustment(position, 'dark', features),
      helpers.advancedStrategyAdjustment(position, 'dark', { ...features, outsidePipGain: 0 }));
  }
});

function mirror(position) {
  const result = plain(position);
  result.turn = 'white';
  result.points = Object.fromEntries(Object.entries(position.points).map(([point, stack]) => [
    (+point + 11) % 24 + 1,
    { color: stack.color === 'dark' ? 'white' : 'dark', count: stack.count },
  ]));
  return result;
}

for (const [color, position] of [['dark', game6Ply60()], ['white', mirror(game6Ply60())]]) {
  test(`native production rank preserves the active four and enters a checker (${color})`, () => {
    const { helpers, game } = runtime();
    const engine = helpers.createLongBotEngine(helpers.createNarduGameAdapter(game));
    const before = plain(position);
    const ranked = engine.rank(position, color, production);
    assert.ok(ranked.length > 1);
    const selected = ranked[0];
    assert.equal(helpers.blockingPrimeRun(selected.after, color), 4);
    assert.equal(helpers.outsideHomeCount(selected.after, color), 5);
    assert.equal(selected.features.outsideReduction, 1);
    assert.equal(selected.features.homeShuffleMoves, 0);
    assert.ok(selected.features.analysisNodesUsed <= 480);
    const verified = plain(position);
    for (const move of selected.sequence) {
      assert.equal(game.applyMove(verified, move.from, move.die, { autoEnd: false }), true);
    }
    assert.equal(game.hasAnyMoves(verified), false, 'selected plan remains maximal and legally executable');
    assert.equal(helpers.blockingPrimeRun(verified, color), 4);
    assert.deepEqual(plain(position), before, 'ranking never mutates its input');
  });
}
