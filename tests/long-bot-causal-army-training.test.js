const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  DEFAULT_OPTIONS, PRODUCTION_WEIGHTS, REVIEW_PREFLIGHT_GRACE_MS, REVIEW_REPLAY_BUDGET_MS, reviewHardTimeoutMs, childJob, derivedSeeds, deterministicUuid, exactExecute, freezeRuntime, freezeTrainingRuntime,
  gameIdentity, orderedConcurrentMap, parseOptions, playTrainingGame, reviewTrainingGames, runTraining,
  archivedOutsideCount, archivedStrategicRisk, selectReviewDecisionIndexes,
} = require('../scripts/train-long-bot-causal-army');
const { loadRuntime, readRuntimeSnapshot } = require('../scripts/simulate-long-bot-regression');
const { canonicalMoves, compactAfter, validateIdentity } = require('../scripts/generate-long-bot-shadow-replay');
const { analyzeTrainingGame, exactExecution, runtimeClosureFiles, runtimeDigest,
  ENGINE_VERSION, EVIDENCE_SCHEMA, RESULT_SCHEMA, TRUST_DOMAIN, WORKER_RELEASE } = require('../scripts/long-bot-causal-worker');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts/train-long-bot-causal-army.js');
const clone = value => JSON.parse(JSON.stringify(value));

test('army hard deadline preserves the entire rollout budget after server replay', () => {
  assert.equal(REVIEW_REPLAY_BUDGET_MS, 120000);
  assert.equal(reviewHardTimeoutMs(300000), 435000);
  assert.equal(reviewHardTimeoutMs(1), 135001);
  assert.equal(reviewHardTimeoutMs(100), 100 + REVIEW_REPLAY_BUDGET_MS + REVIEW_PREFLIGHT_GRACE_MS);
  for (const value of [undefined, null, true, '300000', 0, -1, 1.5, 300001, NaN, Infinity]) {
    assert.throws(() => reviewHardTimeoutMs(value));
  }
});

test('causal army CLI is bounded, training-only and cannot lower the causal sample gate', () => {
  const options = parseOptions(['--pairs', '2', '--seed', '123', '--seed-count', '3',
    '--opponent-profiles', 'v25,v19', '--nodes', '64', '--candidates', '24',
    '--review-games', '0', '--review-samples', '32']);
  assert.equal(options.seedCount, 3);
  assert.deepEqual(options.opponentProfiles, ['v25', 'v19']);
  assert.equal(options.reviewGames, 0);
  assert.equal(options.nodes, 64);
  assert.equal(options.workers, 4);
  assert.equal(options.reviewWorkDecisions, 2);
  assert.equal(options.reviewSelection, 'last');
  assert.equal(parseOptions(['--review-selection', 'strategic-risk']).reviewSelection, 'strategic-risk');
  assert.equal(parseOptions(['--review-work-decisions', '1']).reviewWorkDecisions, 1);
  for (const argv of [
    ['--review-samples', '31'], ['--review-games', '9'], ['--nodes', '1151'],
    ['--candidates', '129'], ['--max-plies', '601'], ['--seed', '0'],
    ['--workers', '0'], ['--workers', '9'], ['--review-work-decisions', '0'], ['--review-work-decisions', '9'],
    ['--review-selection', 'outcome'], ['--review-selection', ''],
    ['--opponent-profiles', 'v25,v25'], ['--opponent-profiles', 'random'],
    ['--pairs', '32', '--seed-count', '8'], ['--pairs', '1', '--pairs', '2'],
    ['--target-win-rate', '0.65'], ['--experience', '/tmp/forged.json'],
    ['--paired-outcome-generator', 'forged'], ['--bot-nodes', '64'],
  ]) assert.throws(() => parseOptions(argv));
  const result = spawnSync(process.execPath, [CLI, '--review-samples', '1'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /review-samples/);
});

test('worker pool claims each deterministic assignment once, caps concurrency and preserves output order', async () => {
  const items = Array.from({ length: 11 }, (_, index) => ({ seed: index + 1, leg: index % 2 }));
  const seen = [];
  let active = 0;
  let peak = 0;
  const results = await orderedConcurrentMap(items, 4, async (item, index) => {
    seen.push(index);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, (11 - index) % 4 + 1));
    active -= 1;
    return { ...item, assignmentIndex: index };
  });
  assert.equal(new Set(seen).size, items.length);
  assert.deepEqual([...seen].sort((a, b) => a - b), items.map((_, index) => index));
  assert.equal(peak, 4);
  assert.deepEqual(results, items.map((item, index) => ({ ...item, assignmentIndex: index })));
  let smallPeak = 0;
  await orderedConcurrentMap(items.slice(0, 2), 8, async () => {
    active += 1;
    smallPeak = Math.max(smallPeak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active -= 1;
  });
  assert.equal(smallPeak, 2);
  assert.deepEqual(await orderedConcurrentMap([], 4, async () => assert.fail('empty pool must not run')), []);
  await assert.rejects(orderedConcurrentMap(items, 9, async () => null), /workers/);
});

test('training identities and seed schedule are deterministic and distinguish policy/color/seed', () => {
  assert.deepEqual(derivedSeeds(123, 4), derivedSeeds(123, 4));
  assert.equal(new Set(derivedSeeds(123, 4)).size, 4);
  assert.ok(derivedSeeds(123, 4).every(seed => seed > 0 && seed <= 0xffffffff));
  const id = gameIdentity('frozen-runtime', 123, 'v19', 0, 0);
  assert.deepEqual(id, gameIdentity('frozen-runtime', 123, 'v19', 0, 0));
  assert.notEqual(id.id, gameIdentity('frozen-runtime', 123, 'v19', 0, 1).id);
  assert.notEqual(id.id, gameIdentity('frozen-runtime', 123, 'v25', 0, 0).id);
  assert.notEqual(id.id, gameIdentity('frozen-runtime', 124, 'v19', 0, 0).id);
  assert.match(deterministicUuid('decision'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('runtime snapshot is materialized as isolated read-only bytes', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-army-freeze-test-'));
  try {
    const snapshot = readRuntimeSnapshot(ROOT);
    const frozen = freezeRuntime(snapshot, temporary);
    for (const [name, bytes] of snapshot.entries) {
      assert.deepEqual(fs.readFileSync(path.join(frozen, name)), bytes);
      assert.equal(fs.statSync(path.join(frozen, name)).mode & 0o222, 0);
    }
    assert.notEqual(frozen, ROOT);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('entire worker and generator closure preserves relative paths and remains independent of live sources', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-army-closure-test-'));
  try {
    const snapshot = readRuntimeSnapshot(ROOT);
    const frozen = freezeTrainingRuntime(snapshot, temporary);
    const expected = new Set(runtimeClosureFiles().map(([name]) => name));
    expected.add('scripts/train-long-bot-causal-army.js');
    for (const name of expected) {
      assert.deepEqual(fs.readFileSync(path.join(frozen.directory, name)), fs.readFileSync(path.join(ROOT, name)));
      assert.equal(fs.statSync(path.join(frozen.directory, name)).mode & 0o222, 0);
    }
    assert.equal(new Set(frozen.files.map(file => file.name)).size, frozen.files.length);
    assert.deepEqual(new Set(frozen.files.map(file => file.name)), expected);
    assert.equal(frozen.generatorPath, path.join(frozen.directory, 'scripts/train-long-bot-causal-army.js'));
    const frozenWorker = require(path.join(frozen.directory, 'scripts/long-bot-causal-worker.js'));
    const realDirectory = fs.realpathSync(frozen.directory);
    assert.ok(frozenWorker.runtimeClosureFiles().every(([, source]) => fs.realpathSync(source).startsWith(`${realDirectory}${path.sep}`)));
    const options = { gamePath: path.join(frozen.directory, 'game.js'), runtimePath: path.join(frozen.directory, 'long-bot-engine.js'),
      trustedTrainingPolicy: { strategyProfile: 'v25', maxCandidates: 4, analysisNodeBudget: 4 } };
    assert.equal(frozenWorker.runtimeDigest(options), runtimeDigest(options));
    const second = freezeTrainingRuntime(snapshot, temporary, frozenWorker);
    const secondWorker = require(path.join(second.directory, 'scripts/long-bot-causal-worker.js'));
    const secondOptions = { ...options, gamePath: path.join(second.directory, 'game.js'),
      runtimePath: path.join(second.directory, 'long-bot-engine.js') };
    const baseline = secondWorker.runtimeDigest(secondOptions);
    // Tamper only with the test-owned original closure after taking the second snapshot.
    const originalDependency = path.join(frozen.directory, 'scripts/long-bot-paired-rollout.js');
    fs.chmodSync(originalDependency, 0o600);
    fs.writeFileSync(originalDependency, Buffer.concat([fs.readFileSync(originalDependency), Buffer.from('\n// test-owned changed source\n')]));
    assert.throws(() => frozenWorker.runtimeDigest(options), /changed after worker load/);
    assert.equal(secondWorker.runtimeDigest(secondOptions), baseline);
    assert.equal(second.fingerprint, frozen.fingerprint);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('exact execution retains full legal action identity and rejects a substituted after-state', () => {
  const runtime = loadRuntime(undefined, readRuntimeSnapshot(ROOT));
  const state = runtime.game.initialState('long');
  state.turn = 'white';
  runtime.game.applyRoll(state, [2, 3]);
  const sequence = runtime.game.bestMoveSequences(state, 'white')[0];
  const selectedAfter = clone(state);
  for (const move of sequence) assert.ok(runtime.game.applyMove(selectedAfter, move.from, move.die, { autoEnd: false }));
  const selected = { moves: clone(canonicalMoves(sequence)), after: compactAfter(selectedAfter) };
  const executed = exactExecute(runtime.game, state, sequence, { selected });
  assert.deepEqual(executed.moves, selected.moves);
  assert.deepEqual(executed.after, selected.after);
  const state2 = runtime.game.initialState('long');
  state2.turn = 'white';
  runtime.game.applyRoll(state2, [2, 3]);
  const forged = clone(selected);
  forged.after.off.white = 1;
  assert.throws(() => exactExecute(runtime.game, state2, sequence, { selected: forged }), /identity-mismatch/);
});

test('actual bounded self-play records exact frozen cold snapshots but censored games cannot train', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-army-actual-test-'));
  try {
    const options = parseOptions(['--seed', '99173', '--seed-count', '1', '--opponent-profiles', 'v19',
      '--nodes', '4', '--candidates', '4', '--max-plies', '1', '--review-games', '1']);
    let calls = 0;
    const dependencies = { artifactDirectory: temporary,
      async analyzeTrainingGame() { calls += 1; throw new Error('incomplete games must not reach reviewer'); } };
    const first = await runTraining(options, dependencies);
    const second = await runTraining({ ...options, workers: 1, output: '/not-used-for-identity.json' }, dependencies);
    assert.equal(first.summary.requestedGames, 2);
    assert.equal(first.summary.completedGames, 0);
    assert.equal(first.summary.censoredGames, 2);
    assert.equal(first.summary.trainingDecisions, 0);
    assert.equal(first.summary.trainingEvidenceCount, 0);
    assert.equal(first.summary.evidenceApplied, 0);
    assert.equal(first.certification, false);
    assert.equal(first.targetWinRateClaimed, false);
    assert.equal(first.runIdentity, second.runIdentity);
    assert.equal(first.processLimits.workers, 2);
    assert.equal(second.processLimits.workers, 1);
    assert.deepEqual(first.games, second.games);
    assert.deepEqual(first.games.map(game => game.bot_color), ['white', 'dark']);
    assert.deepEqual(first.games[0].provenance.streamSeeds, first.games[1].provenance.streamSeeds);
    assert.equal(calls, 0);
    const records = first.games.flatMap(game => game.decisions.map(decision => ({ game, decision })));
    assert.equal(records.length, 1, 'crossed first-turn games must record exactly one bot decision');
    for (const { game, decision } of records) {
      assert.equal(decision.source, 'engine');
      assert.equal(decision.engineVersion, 'long-analytic-v35');
      assert.equal(decision.experienceSize, 0);
      assert.equal(decision.experienceFrozen, true);
      assert.equal(decision.selected.experienceAdjustment, 0);
      assert.deepEqual(decision.replayInput.runtime.weights, PRODUCTION_WEIGHTS);
      assert.equal(validateIdentity(game, decision).ok, true);
      assert.equal(exactExecution(decision).ok, true);
      assert.equal(game.final_state.analysis.botMemory.coverage.complete, false);
      assert.deepEqual(decision.execution.after, game.turns[0].after);
    }
    for (const turn of first.games.flatMap(game => game.turns).filter(turn => !turn.pass)) {
      assert.deepEqual(turn.runtime.weights, PRODUCTION_WEIGHTS);
      assert.equal(turn.runtime.strategyProfile, turn.profile);
      assert.equal(turn.policyDispatch, 'production-hardbot-stable9');
    }
    const incompleteLoss = clone(records[0].game);
    incompleteLoss.winner = incompleteLoss.bot_color === 'white' ? 'dark' : 'white';
    const rejected = await analyzeTrainingGame(incompleteLoss);
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, 'training-coverage-incomplete');
    assert.equal(rejected.evidence.length, 0);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('corrupted exact-execution telemetry censors the run rather than silently substituting a move', () => {
  const snapshot = readRuntimeSnapshot(ROOT);
  const options = parseOptions(['--seed-count', '1', '--opponent-profiles', 'v19',
    '--nodes', '4', '--candidates', '4', '--max-plies', '1']);
  const runtimeFactory = () => {
    const runtime = loadRuntime(undefined, snapshot);
    const consume = runtime.engine.consumeLastDecision.bind(runtime.engine);
    runtime.engine.consumeLastDecision = () => {
      const decision = consume();
      if (decision) decision.selected.after.off.white += 1;
      return decision;
    };
    return runtime;
  };
  const games = [0, 1].map(leg => playTrainingGame(snapshot, options, {
    seed: options.seed, profile: 'v19', pairIndex: 0, leg, runIdentity: 'corrupt-test',
  }, { runtimeFactory }));
  assert.ok(games.some(game => game.censor_reason === 'policy-execution-identity-mismatch'));
  assert.ok(games.every(game => game.status === 'censored'));
  assert.equal(games.flatMap(game => game.decisions).length, 0);
  assert.ok(games.every(game => game.final_state.analysis.botMemory.coverage.complete === false));
});

test('both cold policies use the actual hard-bot production dispatcher with explicit profiles', () => {
  const snapshot = readRuntimeSnapshot(ROOT);
  const options = parseOptions(['--seed', '99173', '--seed-count', '1', '--opponent-profiles', 'v19',
    '--nodes', '4', '--candidates', '4', '--max-plies', '1']);
  const calls = [];
  const runtimeFactory = () => {
    const runtime = loadRuntime(undefined, snapshot);
    const plan = runtime.hardBot.plan.bind(runtime.hardBot);
    runtime.hardBot.plan = (state, policy) => {
      calls.push(clone(policy));
      return plan(state, policy);
    };
    return runtime;
  };
  const games = [0, 1].map(leg => playTrainingGame(snapshot, options, { seed: options.seed,
    profile: 'v19', pairIndex: 0, leg, runIdentity: 'dispatch-proof' }, { runtimeFactory }));
  assert.deepEqual(calls.map(policy => policy.strategyProfile), ['v25', 'v19']);
  assert.ok(calls.every(policy => policy.maxCandidates === 4 && policy.analysisNodeBudget === 4));
  assert.ok(games.every(game => game.provenance.policyDispatch === 'production-hardbot-stable9'));
  assert.ok(games.every(game => game.turns.length === 1));
  for (const turn of games.flatMap(game => game.turns)) assert.deepEqual(turn.runtime.weights, PRODUCTION_WEIGHTS);
});

test('production dispatcher fallback for either policy cannot produce a complete training ledger', () => {
  const snapshot = readRuntimeSnapshot(ROOT);
  const options = parseOptions(['--seed', '99173', '--seed-count', '1', '--opponent-profiles', 'v19',
    '--nodes', '4', '--candidates', '4', '--max-plies', '1']);
  const runtimeFactory = () => {
    const runtime = loadRuntime(undefined, snapshot);
    runtime.hardBot.consumeLastFallbackDecision = () => ({ reason: 'test-owned-fallback-marker' });
    return runtime;
  };
  const games = [0, 1].map(leg => playTrainingGame(snapshot, options, { seed: options.seed,
    profile: 'v19', pairIndex: 0, leg, runIdentity: 'fallback-proof' }, { runtimeFactory }));
  assert.ok(games.every(game => game.censor_reason === 'production-dispatch-fallback'));
  assert.ok(games.every(game => game.status === 'censored' && game.decisions.length === 0));
  assert.ok(games.every(game => game.final_state.analysis.botMemory.coverage.complete === false));
});

test('actual terminal cold loss has complete durable coverage and is accepted by the trusted worker', async () => {
  const snapshot = readRuntimeSnapshot(ROOT);
  const options = parseOptions(['--seed', '99173', '--seed-count', '1', '--opponent-profiles', 'v19',
    '--nodes', '4', '--candidates', '4', '--max-plies', '8']);
  const runtimeFactory = () => {
    const runtime = loadRuntime(undefined, snapshot);
    const initial = runtime.game.initialState.bind(runtime.game);
    runtime.game.initialState = () => ({ ...initial('long'),
      points: { 1: { color: 'white', count: 14 }, 13: { color: 'dark', count: 1 } },
      off: { white: 1, dark: 14 }, firstMoveDone: { white: true, dark: true } });
    return runtime;
  };
  const game = playTrainingGame(snapshot, options, { seed: options.seed, profile: 'v19',
    pairIndex: 0, leg: 0, runIdentity: 'actual-late-loss-test' }, { runtimeFactory });
  assert.equal(game.status, 'completed');
  assert.equal(game.winner, 'dark');
  assert.equal(game.bot_color, 'white');
  assert.equal(game.decisions.length, 1);
  assert.deepEqual(game.final_state.analysis.botMemory.coverage, {
    complete: true, expectedBotDecisions: 1, recordedBotDecisions: 1, recoveredBotDecisions: 0,
  });
  assert.equal(validateIdentity(game, game.decisions[0]).ok, true);
  assert.equal(exactExecution(game.decisions[0]).ok, true);
  const reviewed = await analyzeTrainingGame(game, {
    trustedTrainingPolicy: { strategyProfile: 'v25', maxCandidates: options.candidates,
      analysisNodeBudget: options.nodes, weights: PRODUCTION_WEIGHTS },
    rolloutLimits: { maxPlies: 1, maxElapsedMs: 100 },
  });
  assert.equal(reviewed.accepted, true);
  assert.equal(reviewed.summary.botDecisionsSeen, 1);
  assert.equal(reviewed.evidence.length, 0);
  assert.equal(reviewed.summary.evidenceCount, 0);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-army-trusted-policy-test-'));
  try {
    const seen = [];
    const report = await runTraining({ ...options, reviewMaxPlies: 1, reviewMs: 100 }, {
      artifactDirectory: temporary, runtimeFactory,
      async analyzeTrainingGame(input, workerOptions) {
        seen.push(clone(workerOptions));
        return analyzeTrainingGame(input, workerOptions);
      },
    });
    assert.equal(report.summary.completedGames, 2);
    assert.equal(report.summary.reviewAttempts, 1);
    assert.equal(report.summary.acceptedReviews, 1);
    assert.deepEqual(seen[0].trustedTrainingPolicy, {
      strategyProfile: 'v25', maxCandidates: 4, analysisNodeBudget: 4, weights: PRODUCTION_WEIGHTS,
    });
    assert.equal(seen[0].runtimeDigest, report.frozenRuntime.workerRuntimeDigest);
    assert.deepEqual(seen[0].reviewDecisionIndexes, [0]);
    assert.equal(report.processLimits.reviewHardTimeoutScope, 'one-decision-cohort');
    assert.equal(report.processLimits.reviewHardTimeoutMs,
      100 + REVIEW_REPLAY_BUDGET_MS + REVIEW_PREFLIGHT_GRACE_MS);
    assert.equal(report.processLimits.reviewReplayBudgetMs, REVIEW_REPLAY_BUDGET_MS);
    assert.equal(report.processLimits.reviewRolloutBudgetMs, 100);
    assert.equal(report.summary.trainingEvidenceCount, 0);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('a hard subprocess timeout exports an explicitly unknown incomplete ledger and no evidence', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-army-timeout-test-'));
  try {
    const options = parseOptions(['--seed-count', '1', '--opponent-profiles', 'v19',
      '--nodes', '4', '--candidates', '4', '--game-ms', '1', '--review-games', '1']);
    const report = await runTraining(options, { artifactDirectory: temporary });
    assert.equal(report.summary.censoredGames, 2);
    assert.equal(report.summary.censoredPairs, 1);
    assert.equal(report.summary.trainingEvidenceCount, 0);
    assert.equal(report.summary.reviewAttempts, 0);
    assert.ok(report.games.every(game => game.censor_reason === 'game-hard-time-cap'));
    assert.ok(report.games.every(game => game.decisionLedgerUnavailable === true));
    assert.ok(report.games.every(game => game.final_state.analysis.botMemory.coverage.expectedBotDecisions === null));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('review sampling caps select complete losses without truncating their durable ledger', async () => {
  const options = { ...DEFAULT_OPTIONS, reviewGames: 1, reviewDecisions: 2 };
  const game = (id, status, winner, count) => ({ id, status, winner, bot_color: 'white',
    decisions: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}` })),
    final_state: { analysis: { botMemory: { coverage: { complete: status === 'completed' } } } } });
  const calls = [];
  const result = await reviewTrainingGames([
    game('censored', 'censored', 'dark', 1), game('win', 'completed', 'white', 1),
    game('too-many', 'completed', 'dark', 3), game('eligible', 'completed', 'dark', 2),
    game('capped', 'completed', 'dark', 1),
  ], options, { runtimePath: 'frozen-runtime' }, async (input, workerOptions) => {
    calls.push({ input, workerOptions });
    return { accepted: false, reason: 'rollout-coverage-incomplete', evidence: [], summary: { evidenceCount: 0 } };
  });
  assert.equal(result.attempted, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.id, 'eligible');
  assert.equal(calls[0].input.decisions.length, 2);
  assert.equal(calls[0].workerOptions.limits.maxDecisionsPerGame, 2);
  assert.deepEqual(calls.map(call => call.workerOptions.reviewDecisionIndexes), [[1], [0]]);
  assert.equal(calls[0].input, calls[1].input);
  assert.deepEqual(result.skipped.map(value => value.reason),
    ['incomplete-game', 'not-loss-cohort', 'review-decision-cap', 'review-game-cap']);
  assert.equal(result.results[0].evidence.length, 0);
});

test('review bot-decision cap is separate from the full opponent-inclusive ledger cap', async () => {
  const options = { ...DEFAULT_OPTIONS, reviewGames: 1, reviewDecisions: 1 };
  const game = { id: 'mixed-ledger', status: 'completed', winner: 'dark', bot_color: 'white',
    decisions: [{ id: 'bot-1', actor: 'bot', color: 'white' },
      ...Array.from({ length: 240 }, (_, index) => ({ id: `opponent-${index}`, actor: 'opponent', color: 'dark' }))],
    final_state: { analysis: { botMemory: { coverage: { complete: true } } } } };
  const calls = [];
  const result = await reviewTrainingGames([game, { ...game, id: 'oversized',
    decisions: [...game.decisions, ...Array.from({ length: 80 }, () => ({ color: 'dark' }))] }],
  options, {}, async (input, workerOptions) => {
    calls.push({ input, workerOptions });
    return { accepted: false, evidence: [], summary: { evidenceCount: 0 } };
  });
  assert.equal(result.attempted, 1);
  assert.equal(calls[0].input.decisions.length, 241);
  assert.deepEqual(calls[0].workerOptions.limits, { maxDecisionsPerGame: 1, maxTotalDecisionsPerGame: 320 });
  assert.deepEqual(result.skipped, [{ gameId: 'oversized', reason: 'review-total-ledger-cap' }]);
});

function reviewLedger(count = 3) {
  return { id: 'scoped-loss-game', status: 'completed', winner: 'dark', bot_color: 'white',
    decisions: Array.from({ length: count }, (_, index) => ({ id: `scoped-decision-${index}`, actor: 'bot', color: 'white' })),
    final_state: { analysis: { botMemory: { coverage: { complete: true } } } } };
}

function strategicReviewLedger() {
  const game = reviewLedger(6);
  game.engine_version = ENGINE_VERSION;
  for (const decision of game.decisions) Object.assign(decision, {
    engineVersion: ENGINE_VERSION, source: 'engine', choiceCount: 2,
    stateSnapshotV2: { schema: 'long-state-v2', variant: 'long', phase: 'move', turn: 'white',
      points: { 6: { color: 'white', count: 14 }, 7: { color: 'white', count: 1 }, 13: { color: 'dark', count: 15 } },
      off: { white: 0, dark: 0 }, bar: { white: 0, dark: 0 } },
    selected: { features: {}, tactical: { distributionComplete: true,
      recoveryDistributionComplete: true, continuationCoverageComplete: true } },
  });
  return game;
}

function archivedActiveFourFeatures() {
  // Exact risk-relevant native values from frozen C31 screen game6/ply60.
  // This is an equivalent selector row, not a reconstructed execution or
  // causal label; no test depends on the original private report being present.
  return {
    primeRunBefore: 4, primeRunAfter: 2, primeScoreBefore: 436.64,
    primeScoreAfter: 16.8, primeScoreGain: -419.84,
    opponentMoveBlockBefore: 275.12, opponentMoveBlockAfter: 74.12,
    opponentMoveBlockGain: -201, headLandingBreak: 0,
    latentFenceExposureDelta: 0, fenceClosureDelta: 0,
    escapeGatewayDelta: 1.9544000000000004,
    homeShuffleMoves: 0, outsideReduction: 0,
  };
}

test('active-four-prime curriculum prioritizes exact archived blocking collapse ahead of late tier3 risks', () => {
  const game = strategicReviewLedger();
  game.decisions[0].choiceCount = 22;
  game.decisions[0].selected.features = archivedActiveFourFeatures();
  game.decisions[0].selected.tactical.continuationCoverageComplete = false;
  game.decisions[4].selected.features = { escapeGatewayDelta: -0.9349999999999996 };
  game.decisions[5].selected.features = { fenceClosureDelta: -118.45919999999998 };
  const original = clone(game);
  const options = { reviewSelection: 'strategic-risk', reviewWorkDecisions: 2 };
  const selection = selectReviewDecisionIndexes(game, options);
  assert.deepEqual(selection.indexes, [0, 5]);
  assert.deepEqual(selection.risks.map(risk => risk.tier), [4, 3]);
  assert.deepEqual(selection.risks[0].signals, ['active-four-prime-loss-with-choice']);
  assert.equal(selection.riskRole, 'curriculum-only');
  assert.equal(selection.outcomeUsed, false);
  assert.deepEqual(selectReviewDecisionIndexes(game, { reviewWorkDecisions: 2 }).indexes, [5, 4]);
  const noBlockLoss = clone(game);
  noBlockLoss.decisions[0].selected.features.opponentMoveBlockGain = 0;
  assert.deepEqual(selectReviewDecisionIndexes(noBlockLoss, options).indexes, [5, 4]);
  assert.deepEqual(game, original);
});

test('active-four-prime curriculum requires native active blocking loss, not cosmetic or malformed formation counts', () => {
  const game = strategicReviewLedger();
  const decision = game.decisions[0];
  decision.selected.features = archivedActiveFourFeatures();
  for (const after of [0, 1, 2, 3]) {
    const changed = clone(decision);
    changed.selected.features.primeRunAfter = after;
    assert.deepEqual(archivedStrategicRisk(game, changed),
      { tier: 4, signals: ['active-four-prime-loss-with-choice'] }, `4→${after}`);
  }
  for (const [field, values] of [
    ['primeRunBefore', [undefined, null, true, false, '4', NaN, Infinity, -Infinity, 3, 4.5, 16]],
    ['primeRunAfter', [undefined, null, true, false, '2', NaN, Infinity, -Infinity, -1, 4, 5, 1.5]],
    ['primeScoreBefore', [undefined, null, true, false, '436.64', NaN, Infinity, -Infinity, 0, -1]],
    ['opponentMoveBlockBefore', [undefined, null, true, false, '275.12', NaN, Infinity, -Infinity, 0, -1]],
    ['opponentMoveBlockGain', [undefined, null, true, false, '-201', NaN, Infinity, -Infinity, 0, 1]],
  ]) {
    for (const value of values) {
      const changed = clone(decision);
      changed.selected.features[field] = value;
      assert.equal(archivedStrategicRisk(game, changed).tier, 0, `${field}=${String(value)}`);
    }
  }
  for (const value of [undefined, null, true, false, '22', NaN, Infinity, -Infinity, -1, 0, 1, 1.5]) {
    const changed = clone(decision);
    changed.choiceCount = value;
    assert.equal(archivedStrategicRisk(game, changed).tier, 0, `choiceCount=${String(value)}`);
  }
  const cosmetic = clone(decision);
  cosmetic.selected.features.primeScoreBefore = 0;
  cosmetic.selected.features.opponentMoveBlockBefore = 0;
  assert.equal(archivedStrategicRisk(game, cosmetic).tier, 0);
});

test('active-four-prime curriculum is color symmetric and ignores game results, policy scores and client regret', () => {
  const options = { reviewSelection: 'strategic-risk', reviewWorkDecisions: 2 };
  const selections = [];
  for (const color of ['white', 'dark']) {
    const game = strategicReviewLedger();
    game.bot_color = color;
    for (const decision of game.decisions) {
      decision.color = color;
      decision.stateSnapshotV2.turn = color;
      if (color === 'dark') decision.stateSnapshotV2.points = {
        18: { color: 'dark', count: 14 }, 19: { color: 'dark', count: 1 },
        6: { color: 'white', count: 15 },
      };
    }
    game.decisions[0].selected.features = archivedActiveFourFeatures();
    game.decisions[5].selected.features = { escapeGatewayDelta: -3 };
    const original = clone(game);
    const selection = selectReviewDecisionIndexes(game, options);
    selections.push(selection);
    const changedOutcome = clone(game);
    changedOutcome.winner = color;
    changedOutcome.result_type = 'koks';
    changedOutcome.final_state.winner = color;
    for (const decision of changedOutcome.decisions) {
      decision.selected.score = -1e99;
      decision.counterfactualReplay = { regret: 1e99, trusted: true };
      decision.selected.experienceAdjustment = 1e99;
      decision.experience = { mistakeSeverity: 1e99 };
    }
    assert.deepEqual(selectReviewDecisionIndexes(changedOutcome, options), selection);
    assert.deepEqual(game, original);
    const reversedTie = clone(game);
    reversedTie.decisions[2].selected.features = archivedActiveFourFeatures();
    assert.deepEqual(selectReviewDecisionIndexes(reversedTie, options).indexes, [2, 0]);
  }
  assert.deepEqual(selections[0], selections[1]);
});

test('strategic-risk review selection prioritizes midgame structural risks rather than terminal outcome or regret', () => {
  const game = strategicReviewLedger();
  game.decisions[0].selected.features = { primeRunBefore: 6, primeRunAfter: 4 };
  game.decisions[1].selected.features = { headLandingBreak: 1 };
  game.decisions[2].selected.features = { homeShuffleMoves: 1, outsideReduction: 0 };
  game.decisions[3].selected.tactical = null;
  game.decisions[4].selected.features = { bearOffMoves: 2 };
  game.decisions[5].selected.features = { bearOffMoves: 4 };
  const original = clone(game);
  const options = { reviewSelection: 'strategic-risk', reviewWorkDecisions: 4 };
  const selection = selectReviewDecisionIndexes(game, options);
  assert.deepEqual(selection.indexes, [0, 1, 2, 3]);
  assert.deepEqual(selection.risks.map(risk => risk.tier), [4, 3, 2, 1]);
  assert.equal(selection.riskRole, 'curriculum-only');
  assert.equal(selection.outcomeUsed, false);
  const changedOutcome = clone(game);
  changedOutcome.winner = 'white';
  changedOutcome.result_type = 'koks';
  changedOutcome.final_state.winner = 'white';
  for (const decision of changedOutcome.decisions) {
    decision.selected.score = -1e99;
    decision.counterfactualReplay = { regret: 1e99, trusted: true };
    decision.experience = { mistakeSeverity: 1e99 };
  }
  assert.deepEqual(selectReviewDecisionIndexes(changedOutcome, options), selection);
  assert.deepEqual(game, original);
});

test('review selection keeps last as default, uses reverse-index ties and selects only bounded unique bot indexes', () => {
  const game = strategicReviewLedger();
  game.decisions[1].actor = 'opponent';
  game.decisions[1].color = 'dark';
  game.decisions[1].selected.features = { primeRunBefore: 6, primeRunAfter: 0 };
  assert.deepEqual(selectReviewDecisionIndexes(game, { reviewWorkDecisions: 2 }).indexes, [5, 4]);
  assert.deepEqual(selectReviewDecisionIndexes(game, { reviewSelection: 'last', reviewWorkDecisions: 2 }).indexes, [5, 4]);
  assert.deepEqual(selectReviewDecisionIndexes(game, { reviewSelection: 'strategic-risk', reviewWorkDecisions: 2 }).indexes, [5, 4]);
  game.decisions[0].selected.features = { escapeGatewayDelta: -1 };
  game.decisions[3].selected.features = { escapeGatewayDelta: -3 };
  const selection = selectReviewDecisionIndexes(game, { reviewSelection: 'strategic-risk', reviewWorkDecisions: 8 });
  assert.deepEqual(selection.indexes, [3, 0, 5, 4, 2]);
  assert.equal(new Set(selection.indexes).size, selection.indexes.length);
  assert.ok(selection.indexes.every(index => Number.isSafeInteger(index) && game.decisions[index].color === 'white'));
  for (const maximum of [0, 9, '2', true, null, NaN, 1.5]) {
    assert.throws(() => selectReviewDecisionIndexes(game, { reviewSelection: 'strategic-risk', reviewWorkDecisions: maximum }));
  }
  assert.throws(() => selectReviewDecisionIndexes(game, { reviewSelection: 'outcome', reviewWorkDecisions: 2 }));
  assert.throws(() => selectReviewDecisionIndexes({ ...game, decisions: Array(321).fill(game.decisions[0]) },
    { reviewSelection: 'strategic-risk', reviewWorkDecisions: 2 }), /ledger-cap/);
});

test('strategic-risk review selection never coerces malformed numeric signals or choice counts', () => {
  const game = strategicReviewLedger();
  for (const field of ['headLandingBreak', 'latentFenceExposureDelta', 'fenceClosureDelta', 'escapeGatewayDelta']) {
    for (const value of [undefined, null, true, false, '1', '-1', NaN, Infinity, -Infinity]) {
      const decision = clone(game.decisions[0]);
      decision.selected.features = { [field]: value };
      assert.equal(archivedStrategicRisk(game, decision).tier, 0, `${field}=${String(value)}`);
    }
  }
  for (const value of [undefined, null, true, false, '2', NaN, Infinity, -1, 0, 1, 1.5]) {
    const decision = clone(game.decisions[0]);
    decision.choiceCount = value;
    decision.selected.features = { primeRunBefore: 6, primeRunAfter: 3 };
    decision.selected.tactical = null;
    assert.equal(archivedStrategicRisk(game, decision).tier, 0, `choiceCount=${String(value)}`);
  }
  for (const field of ['primeRunBefore', 'primeRunAfter', 'homeShuffleMoves', 'outsideReduction']) {
    for (const value of [null, true, '0', NaN, Infinity, 0.5]) {
      const decision = clone(game.decisions[0]);
      decision.selected.features = field.startsWith('prime') ? { primeRunBefore: 6, primeRunAfter: 3 }
        : { homeShuffleMoves: 1, outsideReduction: 0 };
      decision.selected.features[field] = value;
      assert.equal(archivedStrategicRisk(game, decision).tier, 0, `${field}=${String(value)}`);
    }
  }
  for (const field of ['latentFenceExposureDelta', 'fenceClosureDelta', 'escapeGatewayDelta']) {
    const decision = clone(game.decisions[0]);
    decision.choiceCount = 1;
    decision.selected.features = { [field]: -0.25 };
    assert.equal(archivedStrategicRisk(game, decision).tier, 3, 'forced structural risk is selection-only, not blame');
  }
});

test('strategic-risk review selection preserves actual unclamped legal prime lengths', () => {
  const game = strategicReviewLedger();
  for (const [before, after] of [[5, 4], [6, 3], [7, 5], [15, 14]]) {
    const decision = clone(game.decisions[0]);
    decision.selected.features = { primeRunBefore: before, primeRunAfter: after };
    assert.deepEqual(archivedStrategicRisk(game, decision),
      { tier: 4, signals: ['prime-loss-with-choice'] }, `${before}→${after}`);
  }
  for (const [before, after] of [[16, 14], [16, 15], [15, 16], [7, 7], ['7', 5], [7, '5'], [true, 5], [null, 5]]) {
    const decision = clone(game.decisions[0]);
    decision.selected.features = { primeRunBefore: before, primeRunAfter: after };
    assert.equal(archivedStrategicRisk(game, decision).tier, 0, `${String(before)}→${String(after)}`);
  }
});

test('strategic-risk home-shuffle review selection uses only canonical original snapshot native checker counts', () => {
  const game = strategicReviewLedger();
  const decision = game.decisions[0];
  decision.selected.features = { homeShuffleMoves: 1, outsideReduction: 0 };
  assert.equal(archivedOutsideCount(game, decision), 1);
  assert.equal(archivedStrategicRisk(game, decision).tier, 2);
  for (const mutate of [
    snapshot => { snapshot.points[7].count = '1'; },
    snapshot => { snapshot.points[7].count = true; },
    snapshot => { snapshot.points[7].count = null; },
    snapshot => { snapshot.points[7].count = NaN; },
    snapshot => { snapshot.points[7].count = 1.5; },
    snapshot => { snapshot.points[7].count = 16; },
    snapshot => { snapshot.points['07'] = snapshot.points[7]; delete snapshot.points[7]; },
    snapshot => { snapshot.off.white = false; },
    snapshot => { snapshot.off.white = 1; },
    snapshot => { snapshot.bar.white = '0'; },
    snapshot => { snapshot.turn = 'dark'; },
    snapshot => { snapshot.variant = 'short'; },
    snapshot => { snapshot.points[7].color = 'unknown'; },
  ]) {
    const invalid = clone(decision);
    mutate(invalid.stateSnapshotV2);
    assert.equal(archivedOutsideCount(game, invalid), null);
    assert.equal(archivedStrategicRisk(game, invalid).tier, 0);
  }
  const darkGame = { ...game, bot_color: 'dark' };
  const darkDecision = clone(decision);
  darkDecision.color = 'dark';
  Object.assign(darkDecision.stateSnapshotV2, { turn: 'dark',
    points: { 18: { color: 'dark', count: 14 }, 19: { color: 'dark', count: 1 }, 6: { color: 'white', count: 15 } } });
  assert.equal(archivedOutsideCount(darkGame, darkDecision), 1);
  assert.equal(archivedStrategicRisk(darkGame, darkDecision).tier, 2);
});

test('strategic-risk review selection diagnostic tier distinguishes absent/incomplete analysis from malformed flags', () => {
  const game = strategicReviewLedger();
  for (const tactical of [undefined, null, {}, { distributionComplete: false },
    { distributionComplete: true, continuationCoverageComplete: false }]) {
    const decision = clone(game.decisions[0]);
    decision.selected.tactical = tactical;
    assert.equal(archivedStrategicRisk(game, decision).tier, 1);
  }
  for (const tactical of [false, 'missing', [], { distributionComplete: 'false' }, { distributionComplete: null }]) {
    const decision = clone(game.decisions[0]);
    decision.selected.tactical = tactical;
    assert.equal(archivedStrategicRisk(game, decision).tier, 0);
  }
  for (const version of ['long-analytic-v34', undefined]) {
    const decision = clone(game.decisions[0]);
    decision.engineVersion = version;
    decision.selected.features = { escapeGatewayDelta: -1 };
    assert.equal(archivedStrategicRisk(game, decision).tier, 0);
  }
  const wrongGeneration = { ...game, engine_version: 'long-analytic-v34' };
  const otherwiseRisky = clone(game.decisions[0]);
  otherwiseRisky.selected.features = { escapeGatewayDelta: -1 };
  assert.equal(archivedStrategicRisk(wrongGeneration, otherwiseRisky).tier, 0);
});

test('strategic-risk review selection forwards each selected original index with the complete immutable ledger', async () => {
  const game = strategicReviewLedger();
  game.decisions[0].selected.features = { primeRunBefore: 6, primeRunAfter: 4 };
  game.decisions[2].selected.features = { escapeGatewayDelta: -1 };
  const original = clone(game);
  const calls = [];
  const result = await reviewTrainingGames([game], { ...DEFAULT_OPTIONS, reviewSelection: 'strategic-risk', reviewWorkDecisions: 2 },
    { runtimeDigest: 'a'.repeat(64), policyImplementationId: 'd'.repeat(64) }, async (input, options) => {
      calls.push({ input, index: options.reviewDecisionIndexes[0] });
      return completedReviewChild(input, options.reviewDecisionIndexes[0], options.runtimeDigest);
    });
  assert.deepEqual(calls.map(call => call.index), [0, 2]);
  assert.ok(calls.every(call => call.input === game && call.input.decisions.length === 6));
  const aggregate = result.results[0];
  assert.equal(aggregate.reviewCoverage.scope, 'trusted-offline-strategic-risk');
  assert.equal(aggregate.reviewCoverage.ordering, 'strategic-tier-then-reverse-original-bot-ledger');
  assert.deepEqual(aggregate.reviewCoverage.requestedDecisionIndexes, [0, 2]);
  assert.deepEqual(aggregate.reviewCoverage.finishedDecisionIndexes, [0, 2]);
  assert.equal(aggregate.reviewCoverage.selectionCoversWholeLedger, false);
  assert.equal(aggregate.reviewCoverage.everyRequestedReviewFinished, true);
  assert.equal(aggregate.reviewSelection.riskRole, 'curriculum-only');
  assert.equal(aggregate.reviewSelection.outcomeUsed, false);
  assert.equal(aggregate.evidence.length, 1, 'risk ordering does not change independent exact observation dedup');
  assert.deepEqual(game, original);
});

function completedReviewChild(game, index, runtimeDigest, stateId = 'b'.repeat(64)) {
  // Trusted dependency-injection fixture for orchestration only. The real
  // worker's confidence/complete-cohort gates are tested in the rollout suite.
  const headers = { trustDomain: TRUST_DOMAIN, reviewerVersion: WORKER_RELEASE,
    engineVersion: ENGINE_VERSION, policyImplementationId: 'd'.repeat(64) };
  const evidence = { ...headers, schema: EVIDENCE_SCHEMA, outcomeUsed: false,
    evidenceId: `${index}`.padStart(64, '0'), trainingGameId: game.id,
    decisionId: game.decisions[index].id, runtimeDigest, stateId, selectedActionId: 'c'.repeat(64) };
  const review = { decisionId: evidence.decisionId, status: 'confirmed-regret', evidence,
    rollout: { coverage: { complete: true } }, outcomeUsed: false };
  return { ...headers, schema: RESULT_SCHEMA, accepted: true, gameId: game.id, runtimeDigest,
    reviewCoverage: { schema: 'long-server-game-review-coverage-v1', scope: 'trusted-offline-indexes',
      fullGameEnvelopeValidated: true, decisionSnapshotsVerified: 'reviewed-only',
      totalLedgerDecisions: game.decisions.length, totalBotDecisions: game.decisions.length,
      requestedDecisionIndexes: [index], attemptedDecisionIndexes: [index], finishedDecisionIndexes: [index],
      completedOutcomeCohorts: 1, selectionCoversWholeLedger: game.decisions.length === 1, everyRequestedReviewFinished: true },
    reviews: [review], evidence: [evidence], outcomeUsed: false };
}

test('last-N review runs separate whole-ledger children and retains complete evidence after a later hard kill', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-review-cohort-timeout-test-'));
  try {
    const neverFinishes = path.join(temporary, 'never-finishes.js');
    fs.writeFileSync(neverFinishes, 'setInterval(() => {}, 1000);\n');
    const game = reviewLedger();
    const original = clone(game);
    const runtimeDigest = 'a'.repeat(64);
    const seen = [];
    const results = await reviewTrainingGames([game], { ...DEFAULT_OPTIONS, reviewWorkDecisions: 2 },
      { runtimeDigest, policyImplementationId: 'd'.repeat(64) }, async (input, options) => {
        const [index] = options.reviewDecisionIndexes;
        seen.push({ index, input });
        assert.equal(input.decisions.length, 3);
        if (index === 2) return completedReviewChild(input, index, runtimeDigest);
        return childJob('review', { game: input }, temporary, 25, `${input.id}-${index}`, neverFinishes);
      });
    assert.deepEqual(seen.map(item => item.index), [2, 1]);
    assert.ok(seen.every(item => item.input === game));
    assert.deepEqual(game, original);
    const result = results.results[0];
    assert.equal(result.accepted, true);
    assert.equal(result.reason, 'review-hard-time-cap');
    assert.equal(result.evidence.length, 1);
    assert.equal(result.summary.confirmedRegret, 1);
    assert.equal(result.summary.rejected, 1);
    assert.equal(result.summary.evidenceCount, 1);
    assert.deepEqual(result.reviewCoverage, {
      schema: 'long-server-game-review-coverage-v1', fullGameEnvelopeValidated: true,
      decisionSnapshotsVerified: 'reviewed-only', scope: 'trusted-offline-last-n',
      ordering: 'reverse-original-bot-ledger', totalLedgerDecisions: 3, totalBotDecisions: 3,
      requestedDecisionIndexes: [2, 1], attemptedDecisionIndexes: [2, 1], finishedDecisionIndexes: [2],
      failedDecisionIndexes: [1], completedOutcomeCohorts: 1,
      selectionCoversWholeLedger: false, everyRequestedReviewFinished: false,
    });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('malformed later child identity cannot commit a false cohort or poison earlier exact evidence', async () => {
  const game = reviewLedger();
  const runtimeDigest = 'a'.repeat(64);
  const result = await reviewTrainingGames([game], { ...DEFAULT_OPTIONS, reviewWorkDecisions: 2 },
    { runtimeDigest, policyImplementationId: 'd'.repeat(64) }, async (input, options) => {
      const [index] = options.reviewDecisionIndexes;
      const child = completedReviewChild(input, index, runtimeDigest);
      if (index === 1) child.evidence[0] = { ...child.evidence[0], decisionId: 'wrong-decision' };
      return child;
    });
  const aggregate = result.results[0];
  assert.equal(aggregate.reason, 'review-worker-evidence-identity-mismatch');
  assert.equal(aggregate.evidence.length, 1);
  assert.equal(aggregate.summary.confirmedRegret, 1);
  assert.equal(aggregate.summary.rejected, 1);
  assert.deepEqual(aggregate.reviewCoverage.finishedDecisionIndexes, [2]);
  assert.deepEqual(aggregate.reviewCoverage.failedDecisionIndexes, [1]);
  assert.equal(aggregate.reviewCoverage.completedOutcomeCohorts, 1);
});

test('malformed scoped child headers, coverage and incomplete confirmed outcomes fail atomically', async () => {
  const mutations = [
    ['result-schema', child => { child.schema = 'forged'; }],
    ['result-trust', child => { child.trustDomain = 'client'; }],
    ['result-release', child => { child.reviewerVersion = 'old'; }],
    ['result-engine', child => { child.engineVersion = 'long-analytic-v34'; }],
    ['result-policy', child => { child.policyImplementationId = 'e'.repeat(64); }],
    ['result-runtime', child => { child.runtimeDigest = 'e'.repeat(64); }],
    ['result-outcome', child => { child.outcomeUsed = true; }],
    ['result-reviews-not-array', child => { child.reviews = { 0: child.reviews[0], length: 1 }; }],
    ['result-evidence-not-array', child => { child.evidence = { 0: child.evidence[0], length: 1 }; }],
    ['coverage-schema', child => { child.reviewCoverage.schema = 'forged'; }],
    ['coverage-scope', child => { child.reviewCoverage.scope = 'all-bot-decisions'; }],
    ['coverage-total-ledger', child => { child.reviewCoverage.totalLedgerDecisions = 1; }],
    ['coverage-total-bot', child => { child.reviewCoverage.totalBotDecisions = '3'; }],
    ['coverage-requested', child => { child.reviewCoverage.requestedDecisionIndexes = [1, 1]; }],
    ['coverage-attempted', child => { child.reviewCoverage.attemptedDecisionIndexes = [1, 0]; }],
    ['coverage-finished', child => { child.reviewCoverage.finishedDecisionIndexes = [2]; }],
    ['coverage-every-finished', child => { child.reviewCoverage.everyRequestedReviewFinished = false; }],
    ['coverage-whole-ledger', child => { child.reviewCoverage.selectionCoversWholeLedger = true; }],
    ['coverage-cohort-count', child => { child.reviewCoverage.completedOutcomeCohorts = 2; }],
    ['review-outcome', child => { child.reviews[0].outcomeUsed = true; }],
    ['review-status', child => { child.reviews[0].status = 'unrecognized'; }],
    ['confirmed-incomplete', child => {
      child.reviews[0].rollout.coverage.complete = false;
      child.reviewCoverage.completedOutcomeCohorts = 0;
    }],
    ['evidence-schema', child => { child.evidence[0].schema = 'forged'; }],
    ['evidence-trust', child => { child.evidence[0].trustDomain = 'client'; }],
    ['evidence-release', child => { child.evidence[0].reviewerVersion = 'old'; }],
    ['evidence-engine', child => { child.evidence[0].engineVersion = 'long-analytic-v34'; }],
    ['evidence-policy', child => { child.evidence[0].policyImplementationId = 'e'.repeat(64); }],
    ['evidence-outcome', child => { child.evidence[0].outcomeUsed = true; }],
  ];
  for (const [name, mutate] of mutations) {
    const game = reviewLedger();
    const runtimeDigest = 'a'.repeat(64);
    const result = await reviewTrainingGames([game], { ...DEFAULT_OPTIONS, reviewWorkDecisions: 2 },
      { runtimeDigest, policyImplementationId: 'd'.repeat(64) }, async (input, options) => {
        const [index] = options.reviewDecisionIndexes;
        const child = completedReviewChild(input, index, runtimeDigest);
        if (index === 1) mutate(child);
        return child;
      });
    const aggregate = result.results[0];
    assert.equal(aggregate.accepted, true, name);
    assert.match(aggregate.reason, /^review-worker-(scope|evidence)-identity-mismatch$/, name);
    assert.equal(aggregate.evidence.length, 1, name);
    assert.equal(aggregate.evidence[0].decisionId, 'scoped-decision-2', name);
    assert.equal(aggregate.summary.confirmedRegret, 1, name);
    assert.equal(aggregate.summary.rejected, 1, name);
    assert.equal(aggregate.reviewCoverage.completedOutcomeCohorts, 1, name);
    assert.deepEqual(aggregate.reviewCoverage.finishedDecisionIndexes, [2], name);
    assert.deepEqual(aggregate.reviewCoverage.failedDecisionIndexes, [1], name);
    assert.equal(aggregate.reviewCoverage.everyRequestedReviewFinished, false, name);
  }
});

test('finished diagnostic or rejected review is distinct from a completed outcome cohort', async () => {
  const game = reviewLedger(1);
  const runtimeDigest = 'a'.repeat(64);
  const result = await reviewTrainingGames([game], { ...DEFAULT_OPTIONS, reviewWorkDecisions: 1 },
    { runtimeDigest, policyImplementationId: 'd'.repeat(64) }, async (input, options) => {
      const child = completedReviewChild(input, options.reviewDecisionIndexes[0], runtimeDigest);
      child.reviews[0] = { decisionId: input.decisions[0].id, status: 'rejected',
        reason: 'rollout-ply-limit', evidence: null, outcomeUsed: false };
      child.evidence = [];
      child.reviewCoverage.completedOutcomeCohorts = 0;
      return child;
    });
  const aggregate = result.results[0];
  assert.equal(aggregate.accepted, true);
  assert.equal(aggregate.evidence.length, 0);
  assert.deepEqual(aggregate.reviewCoverage.finishedDecisionIndexes, [0]);
  assert.deepEqual(aggregate.reviewCoverage.failedDecisionIndexes, []);
  assert.equal(aggregate.reviewCoverage.everyRequestedReviewFinished, true);
  assert.equal(aggregate.reviewCoverage.completedOutcomeCohorts, 0);
  assert.equal(aggregate.summary.rejected, 1);
});

test('multiple scoped cohorts deduplicate the same exact observation without claiming independent positions', async () => {
  const game = reviewLedger(2);
  const runtimeDigest = 'a'.repeat(64);
  const result = await reviewTrainingGames([game], { ...DEFAULT_OPTIONS, reviewWorkDecisions: 2 },
    { runtimeDigest, policyImplementationId: 'd'.repeat(64) }, async (input, options) => completedReviewChild(input, options.reviewDecisionIndexes[0], runtimeDigest));
  const aggregate = result.results[0];
  assert.equal(aggregate.summary.confirmedRegret, 2);
  assert.equal(aggregate.summary.evidenceCount, 1);
  assert.equal(aggregate.evidence.length, 1);
  assert.equal(aggregate.reviewCoverage.selectionCoversWholeLedger, true);
  assert.equal(aggregate.reviewCoverage.everyRequestedReviewFinished, true);
  assert.equal(aggregate.reviewCoverage.completedOutcomeCohorts, 2);
  assert.deepEqual(aggregate.reviewCoverage.finishedDecisionIndexes, [1, 0]);
});

test('real near-terminal loss keeps its complete ledger while reviewing one predetermined final decision', async () => {
  const snapshot = readRuntimeSnapshot(ROOT);
  const options = parseOptions(['--seed', '99173', '--seed-count', '1', '--opponent-profiles', 'v19',
    '--nodes', '4', '--candidates', '4', '--max-plies', '16', '--review-work-decisions', '1']);
  const runtimeFactory = () => {
    const runtime = loadRuntime(undefined, snapshot);
    const initial = runtime.game.initialState.bind(runtime.game);
    runtime.game.initialState = () => ({ ...initial('long'),
      points: { 6: { color: 'white', count: 15 }, 13: { color: 'dark', count: 6 } },
      off: { white: 0, dark: 9 }, firstMoveDone: { white: true, dark: true } });
    return runtime;
  };
  const game = playTrainingGame(snapshot, options, { seed: options.seed, profile: 'v19',
    pairIndex: 0, leg: 0, runIdentity: 'actual-scoped-late-loss-test' }, { runtimeFactory });
  assert.equal(game.status, 'completed');
  assert.equal(game.winner, 'dark');
  assert.ok(game.decisions.length > 1, 'real fixture must have multiple original bot decisions');
  const original = clone(game);
  const workerOptions = { trustedTrainingPolicy: { strategyProfile: 'v25', maxCandidates: 4,
    analysisNodeBudget: 4, weights: PRODUCTION_WEIGHTS }, rolloutLimits: { maxPlies: 1, maxElapsedMs: 100 } };
  workerOptions.runtimeDigest = runtimeDigest(workerOptions);
  const reviews = await reviewTrainingGames([game], options, workerOptions);
  const result = reviews.results[0];
  assert.equal(result.accepted, true, result.reason);
  assert.equal(result.summary.botDecisionsSeen, 1);
  assert.equal(result.summary.decisionsSeen, game.decisions.length);
  assert.deepEqual(result.reviewCoverage.requestedDecisionIndexes, [game.decisions.length - 1]);
  assert.equal(result.reviewCoverage.selectionCoversWholeLedger, false);
  assert.equal(result.reviewCoverage.everyRequestedReviewFinished, true);
  assert.equal(result.reviewCoverage.fullGameEnvelopeValidated, true);
  assert.equal(result.evidence.length, 0, 'bounded censored rollout never becomes learned evidence');
  assert.deepEqual(game, original);
});
