const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const NOW = 1789500000000;
const plain = value => JSON.parse(JSON.stringify(value));
let cached;
function runtime() {
  if (cached) return cached;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const context = { window: {}, console, Date: FixedDate, Math, setTimeout, clearTimeout };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context);
  const body = ['metrics', 'evaluator', 'analysis', 'engine', 'nardu-game-adapter', 'browser']
    .map(name => fs.readFileSync(path.join(ROOT, 'bot-engine/long', `${name}.ts`), 'utf8')
      .replace(/^import\s+type[\s\S]*?;\s*$/gm, '')
      .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/gm, '')
      .replace(/^export\s+(?=(const|function|class))/gm, '')
      .replace(/^export\s+\{[^}]+\};?\s*$/gm, '')).join('\n');
  vm.runInContext(`(function () { ${body}\nwindow.primeDefenseHelpers = {
    reserveStructuralIntegrityForTacticalAnalysis, hasBoundedFourPlyTactical,
    createLongBotEngine, createNarduGameAdapter,
  };
  const originalAnalyze = analyzeOpponentReplies;
  analyzeOpponentReplies = function (...args) {
    const result = originalAnalyze(...args);
    window.primeDefenseAnalyzedCandidates = args[2];
    return result;
  };
  }());`, context);
  cached = { game: context.window.NarduGame, engine: context.window.NarduLongBotEngine,
    helpers: context.window.primeDefenseHelpers,
    analyzedCandidates: () => context.window.primeDefenseAnalyzedCandidates || [] };
  return cached;
}
function state(dark, white, dice = [2, 1]) {
  return {
    variant: 'long', phase: 'move', turn: 'dark', dice, rolled: dice,
    points: Object.fromEntries([
      ...Object.entries(dark).map(([point, count]) => [point, { color: 'dark', count }]),
      ...Object.entries(white).map(([point, count]) => [point, { color: 'white', count }]),
    ]),
    off: { dark: 0, white: 0 }, bar: { dark: 0, white: 0 }, score: { dark: 0, white: 0 },
    firstMoveDone: { dark: true, white: true }, headPlayedThisTurn: { dark: false, white: false },
    turnMoves: [], history: [], winner: null, resultType: null, openingRoll: null,
    startedAt: 0, finishedAt: null, turnClock: { dark: 0, white: 0, active: null, startedAt: null },
    matchScore: { dark: 0, white: 0, target: 5, recordedWinner: null },
  };
}
const production = {
  strategyProfile: 'v25', maxCandidates: 64, analysisNodeBudget: 480,
  weights: {
    opponentHeadFreedom: 48000, headLandingExposure: 62000, headRelease: 9800,
    foothold: 4300, homeEntry: 145000, rushPenalty: 12500, trapRisk: 62000,
    escapeGatewayRisk: 800000, distribution: 780,
  },
};
function pair() {
  const position = state({ 12: 1, 17: 14 }, { 24: 15 });
  const features = {
    opponentFenceRunBefore: 3, trapBefore: 140, primeRunBefore: 5, primeRunAfter: 3,
    primeScoreAfter: 740, opponentMoveBlockAfter: 175, prospectiveFenceExtensionBefore: 210,
    prospectiveFenceInterruptionBreak: 0, headLandingBreak: 0, headGain: 1,
    outsideReduction: 0, homeEntryMoves: 0, outsidePipGain: 3, startZoneReduction: 0,
    homeShuffleMoves: 0, resultSafetyAfter: 0, maxRouteTowerAfter: 3,
    trapDelta: 0, fenceClosureDelta: 0, escapeGatewayDelta: 0,
  };
  const candidate = (id, score, overrides) => ({
    id, score, sequence: [{ from: 12, to: id, die: 1 }],
    after: { points: { [id]: { color: 'dark', count: 1 } }, off: { dark: 0, white: 0 } },
    features: { ...features, ...overrides },
  });
  const head = candidate(11, 100, {});
  const keeper = candidate(5, 90, { headGain: 0, primeRunAfter: 5, primeScoreAfter: 2230,
    opponentMoveBlockAfter: 269, maxRouteTowerAfter: 2, escapeGatewayDelta: -0.9 });
  return { position, head, keeper, candidate };
}
const reserve = (position, ranked) => runtime().helpers.reserveStructuralIntegrityForTacticalAnalysis(
  position, 'dark', ranked,
);

test('normal last-head release reserves exactly one active-prime defender without changing scores', () => {
  const { position, head, keeper, candidate } = pair();
  const weaker = candidate(6, 80, { ...keeper.features, primeScoreAfter: 2200 });
  const ranked = [head, candidate(8, 99, {}), candidate(9, 98, {}), candidate(10, 97, {}), weaker, keeper];
  const scores = ranked.map(c => c.score);
  const reserved = reserve(position, ranked);
  assert.equal(keeper.features.structuralIntegrityTacticalReservation, 1);
  assert.equal(weaker.features.structuralIntegrityTacticalReservation, undefined);
  assert.ok(reserved.slice(0, 4).includes(keeper));
  assert.deepEqual(ranked.map(c => c.score), scores, 'coverage does not award an arbitrary prime bonus');
  const two = pair();
  two.position.points[12].count = 2;
  two.position.points[17].count = 13;
  reserve(two.position, [two.head, two.keeper]);
  assert.equal(two.keeper.features.structuralIntegrityTacticalReservation, 1,
    'both ordinary one- and two-checker head priorities allow bounded defensive search');
});

test('active-prime coverage exception fails closed for emergency head release and static safety regressions', () => {
  const mutations = [
    ['trap600', p => { p.head.features.trapBefore = p.keeper.features.trapBefore = 600; }],
    ['opponentFence4', p => { p.head.features.opponentFenceRunBefore = p.keeper.features.opponentFenceRunBefore = 4; }],
    ['opponentBearingOff', p => { p.position.off.white = 1; }],
    ['largeHead', p => { p.position.points[12].count = 7; p.position.points[17].count = 8; }],
    ['head3', p => { p.position.points[12].count = 3; p.position.points[17].count = 12; }],
    ['noHead', p => { delete p.position.points[12]; p.position.points[17].count = 15; }],
    ['weakBlock', p => { p.keeper.features.opponentMoveBlockAfter = 214; }],
    ['shortenedPrime', p => { p.keeper.features.primeRunAfter = 4; }],
    ['noActivePrime', p => { p.head.features.primeRunBefore = p.keeper.features.primeRunBefore = 4; }],
    ['onlyOnePointLost', p => { p.head.features.primeRunAfter = 4; }],
    ['trapRegression', p => { p.keeper.features.trapDelta = -0.01; }],
    ['fenceRegression', p => { p.keeper.features.fenceClosureDelta = -0.01; }],
    ['gatewayBeyond1', p => { p.keeper.features.escapeGatewayDelta = -1.000001; }],
    ['headLandingBreak', p => { p.keeper.features.headLandingBreak = 0.01; }],
    ['newInterruption', p => { p.keeper.features.prospectiveFenceInterruptionBreak = 0.01; }],
    ['towerIncrease', p => { p.keeper.features.maxRouteTowerAfter = 4; }],
    ['missedEntry', p => { p.head.features.outsideReduction = p.head.features.homeEntryMoves = 1; }],
    ['lessOutsideProgress', p => { p.keeper.features.outsidePipGain = 2; }],
    ['extraShuffle', p => { p.keeper.features.homeShuffleMoves = 1; }],
    ['resultSafetyRegression', p => { p.keeper.features.resultSafetyAfter = -0.01; }],
    ['nonFiniteGateway', p => { p.keeper.features.escapeGatewayDelta = NaN; }],
    ['missingNativeRisk', p => { delete p.keeper.features.trapDelta; }],
  ];
  for (const [name, mutate] of mutations) {
    const p = pair();
    mutate(p);
    reserve(p.position, [p.head, p.keeper]);
    assert.equal(p.keeper.features.structuralIntegrityTacticalReservation, undefined, name);
  }
  const p = pair();
  reserve(p.position, [p.head, p.keeper]);
  p.head.features.trapBefore = p.keeper.features.trapBefore = 600;
  reserve(p.position, [p.head, p.keeper]);
  assert.equal(p.keeper.features.structuralIntegrityTacticalReservation, undefined,
    'a repeated reduced-beam pass must clear stale ordinary-head exceptions');
});

test('active-prime reservation is color-symmetric, deterministic under alternative reversal, and score-neutral', () => {
  for (const color of ['dark', 'white']) {
    const p = pair();
    if (color === 'white') {
      p.position = state({ 12: 15 }, { 24: 1, 6: 14 });
      p.position.turn = 'white';
    }
    const tied = p.candidate(6, p.keeper.score, { ...p.keeper.features });
    const input = [p.head, p.keeper, tied];
    const scores = input.map(c => c.score);
    const invoke = candidates => runtime().helpers.reserveStructuralIntegrityForTacticalAnalysis(
      p.position, color, candidates,
    );
    invoke(input);
    const chosen = input.find(c => c.features.structuralIntegrityTacticalReservation === 1);
    assert.equal(input.filter(c => c.features.structuralIntegrityTacticalReservation === 1).length, 1);
    invoke([p.head, tied, p.keeper]);
    assert.equal(input.find(c => c.features.structuralIntegrityTacticalReservation === 1), chosen,
      'full-position identity resolves otherwise equal structural and neutral-score references');
    tied.experienceAdjustment = 1000000000;
    tied.score += tied.experienceAdjustment;
    invoke([p.head, tied, p.keeper]);
    assert.equal(input.find(c => c.features.structuralIntegrityTacticalReservation === 1), chosen,
      'experience must not select which structurally tied defense receives cold search');
    assert.equal(p.head.score, scores[0]);
    assert.equal(p.keeper.score, scores[1]);
    assert.equal(tied.score, scores[2] + tied.experienceAdjustment);
  }
});

function ply29() {
  // Exact archived game2/ply29: known position and dice only, no outcome/future dice.
  return state({ 1: 1, 3: 1, 5: 1, 6: 3, 7: 1, 9: 2, 10: 1, 11: 1, 12: 1, 13: 1, 15: 1, 20: 1 },
    { 2: 1, 4: 1, 8: 1, 14: 2, 16: 1, 18: 3, 19: 1, 22: 3, 23: 1, 24: 1 }, [1, 2]);
}
const contains = (candidate, from, to, die) => candidate.sequence.some(m => (
  m.from === from && m.to === to && m.die === die
));

test('completed-army ply29 prime-preserving defense reaches real production tactical coverage before head policy decides', () => {
  const { engine, helpers } = runtime();
  const position = ply29();
  const before = plain(position);
  engine.setExperience([], 'army-ply29-active-prime-defense');
  const ranked = engine.rank(position, production);
  const keeper = ranked.find(c => contains(c, 6, 5, 1) && contains(c, 9, 7, 2));
  assert.ok(keeper, 'legal active defense must not be excluded solely for retaining the final head checker');
  assert.equal(helpers.hasBoundedFourPlyTactical(keeper), true,
    'keeper receives its own finite primary/recovery/continuation estimates, never archived inherited metrics');
  assert.equal(keeper.features.primeRunAfter, 5);
  assert.equal(keeper.experienceAdjustment, 0);
  assert.ok(ranked[0].features.analysisNodesUsed <= production.analysisNodeBudget);
  assert.equal(ranked[0].features.analysisNodeBudget, 480);
  assert.equal(Number(keeper.features.structuralIntegrityAdjustment || 0), 0,
    'reservation alone is not a forced prime-retention promotion');
  assert.deepEqual(position, before);
  if (process.env.LONG_PRIME_DEFENSE_AUDIT_OUT) {
    const sourceFiles = ['game.js', ...['metrics', 'evaluator', 'analysis', 'engine', 'nardu-game-adapter', 'browser']
      .map(name => `bot-engine/long/${name}.ts`)];
    const report = {
      schema: 'long-active-prime-defense-post-fix-fixture-audit-v1', purpose: 'diagnostic-only',
      sourceKind: 'current-TS-native-VM-before-parent-bundle-rebuild', fixedDate: NOW,
      options: production, experienceSize: 0, stateSnapshot: before,
      sources: sourceFiles.map(file => ({ file, sha256: crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, file))).digest('hex') })),
      selected: plain(ranked[0]), keeper: plain(keeper), finalRanked: plain(ranked),
      selectedMatchesArchivedOrderedAction: ranked[0].sequence.length === 2
        && ranked[0].sequence[0].from === 9 && ranked[0].sequence[0].die === 2
        && ranked[0].sequence[1].from === 12 && ranked[0].sequence[1].die === 1,
      analyzedCandidates: plain(runtime().analyzedCandidates()),
      trainingEvidenceCount: 0, newGames: 0, newRollouts: 0, outcomeUsed: false,
      interpretation: 'Own bounded conditional search estimates only; not matched terminal outcomes, causal regret, or a win-probability proof',
    };
    fs.writeFileSync(process.env.LONG_PRIME_DEFENSE_AUDIT_OUT, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ audit: process.env.LONG_PRIME_DEFENSE_AUDIT_OUT,
      selected: plain(ranked[0].sequence), keeper: plain(keeper.sequence), selectedScore: ranked[0].score,
      keeperScore: keeper.score, nodes: ranked[0].features.analysisNodesUsed,
      selectedMatchesArchive: report.selectedMatchesArchivedOrderedAction }));
  }
});

test('reserved active-prime defense is not forced when its actual hypothetical replies lose immediately', () => {
  const { game, helpers, analyzedCandidates } = runtime();
  const base = helpers.createNarduGameAdapter(game);
  const position = ply29();
  position.auditRoot = true;
  const native = base.legalSequences(position, 'dark');
  const head = native.find(q => q.some(m => m.from === 9 && m.to === 7 && m.die === 2)
    && q.some(m => m.from === 12 && m.to === 11 && m.die === 1));
  const keeper = native.find(q => q.some(m => m.from === 6 && m.to === 5 && m.die === 1)
    && q.some(m => m.from === 9 && m.to === 7 && m.die === 2));
  assert.ok(head && keeper);
  const adapter = {
    ...base,
    legalSequences(s, color, options) {
      if (s.auditRoot) return [head, keeper];
      if (s.auditKeeper && color === 'white') return [[{ from: 14, to: 13, die: 1 }]];
      return base.legalSequences(s, color, options);
    },
    applySequence(s, sequence, color) {
      const after = base.applySequence(s, sequence, color);
      if (s.auditRoot) {
        delete after.auditRoot;
        after.auditKeeper = sequence.some(m => m.from === 6 && m.to === 5);
      } else if (s.auditKeeper && color === 'white') {
        // Synthetic RulesAdapter adversary, not an alleged legal native replay:
        // every enumerated keeper reply terminates in an opponent victory.
        after.phase = 'finished'; after.winner = 'white'; after.resultType = 'koks';
      }
      return after;
    },
  };
  const engine = helpers.createLongBotEngine(adapter);
  const ranked = engine.rank(position, 'dark', { ...production, analysisNodeBudget: 160 });
  const dangerous = analyzedCandidates().find(c => contains(c, 6, 5, 1));
  assert.ok(dangerous?.tactical, 'reserved keeper must be judged by its own adapter reply values');
  assert.ok(dangerous.tactical.worstImpact < -900000000);
  assert.ok(contains(ranked[0], 12, 11, 1), 'catastrophic active defense cannot force the head move out');
  assert.equal(Number(dangerous.features.structuralIntegrityAdjustment || 0), 0);
});
