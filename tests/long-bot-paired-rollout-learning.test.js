const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const {
  generatePairedPolicyOutcomes,
  simultaneousHoeffding,
  validatePairedOutcomeEvidence,
} = require('../scripts/long-bot-paired-rollout');
const {
  DEFAULT_LIMITS: SERVER_LIMITS,
  ENGINE_VERSION,
  EVIDENCE_SCHEMA,
  TRUST_DOMAIN,
  WORKER_RELEASE,
  PRODUCTION_POLICY,
  POLICY_ROLE,
  analyzeTrainingGame,
  collisionResistantIdentities,
  exactExecution,
  reviewTrustedDecision,
  regenerateArchivedSelection,
  runtimeClosureEntries,
  runtimeDigestFromEntries,
  runtimeDigest,
  verifiedRuntimeDigest,
  runClaimedBatch,
  policyImplementationId,
  serverOwnedPolicy,
  trustedReviewSelection,
  uniqueCausalEvidence,
  validateGameEnvelope,
} = require('../scripts/long-bot-causal-worker');
const { DEFAULT_LIMITS: SHADOW_LIMITS, afterPositionKey, loadRuntime, clearRuntimeCache } = require('../scripts/generate-long-bot-shadow-replay');

const ROOT = path.join(__dirname, '..');
const policyBuilder = require('../scripts/build-long-bot-engine');

function createBrowserLongBotEngine(game, options = {}) {
  const storage = options.experienceStorage;
  const context = { window: { NarduGame: game, sessionStorage: storage }, sessionStorage: storage,
    Date, Math, JSON, URL, setTimeout, clearTimeout, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'long-bot-engine.js'), 'utf8'), context);
  return new Proxy(context.window.NarduLongBotEngine, {
    get(target, key) {
      const value = target[key];
      return typeof value === 'function'
        ? (...args) => structuredClone(value.apply(target, args)) : value;
    },
  });
}

function fakeRuntime() {
  return {
    engine: { setExperience() {}, plan() { return []; } },
    game: {
      applyMove(state, from, die) {
        const source = state.points[from];
        if (!source || source.color !== state.turn || source.count < 1) return false;
        const to = from - die;
        source.count -= 1;
        if (!source.count) delete state.points[from];
        state.points[to] ||= { color: state.turn, count: 0 };
        state.points[to].count += 1;
        state.dice.splice(state.dice.indexOf(die), 1);
        return true;
      },
      hasAnyMoves() { return false; },
      endTurn(state) { state.turn = state.turn === 'dark' ? 'white' : 'dark'; state.phase = 'roll'; },
    },
  };
}

function fixture() {
  const before = {
    schema: 'long-state-v2', variant: 'long', phase: 'move', turn: 'dark',
    points: { 12: { color: 'dark', count: 2 }, 24: { color: 'white', count: 15 } },
    bar: { white: 0, dark: 0 }, off: { white: 0, dark: 13 },
    dice: [2, 4], rolled: [2, 4], firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false }, turnMoves: [],
  };
  const selected = {
    moves: [{ from: 12, to: 10, die: 2 }, { from: 12, to: 8, die: 4 }],
    after: {
      points: { 8: { color: 'dark', count: 1 }, 10: { color: 'dark', count: 1 }, 24: { color: 'white', count: 15 } },
      bar: { white: 0, dark: 0 }, off: { white: 0, dark: 13 },
    },
    features: { outsideReduction: 0, avoidableHomeShuffleMoves: 1 },
    experience: { contextKey: 'route|paired-test', actionKey: 'selected:route' },
    score: 999999999, experienceAdjustment: 0,
  };
  const recommended = {
    moves: [{ from: 12, to: 10, die: 2 }, { from: 10, to: 6, die: 4 }],
    after: {
      points: { 6: { color: 'dark', count: 1 }, 12: { color: 'dark', count: 1 }, 24: { color: 'white', count: 15 } },
      bar: { white: 0, dark: 0 }, off: { white: 0, dark: 13 },
    },
    features: { outsideReduction: 1, avoidableHomeShuffleMoves: 0 },
    experience: { contextKey: 'route|paired-test', actionKey: 'recommended:route' },
    score: -999999999,
  };
  const decision = {
    id: 'decision-paired-1', positionId: 'lb4-paired-test', actor: 'bot', color: 'dark',
    source: 'engine', engineVersion: ENGINE_VERSION, experienceFrozen: true,
    experienceFingerprint: 'lbe8-empty', stateFingerprintV2: 'lbs2-fixture',
    stateSnapshotV2: before,
    replayInput: { runtime: structuredClone(PRODUCTION_POLICY) },
    selected: structuredClone(selected), experience: structuredClone(selected.experience),
    execution: {
      complete: true, fallback: false, substituted: false, selectedMatchesExecuted: true,
      executedActionKey: selected.experience.actionKey,
      executed: structuredClone(selected),
    },
    counterfactualReplay: { policyScore: 999999999, regret: 999999999, trusted: true },
  };
  const replayExperience = {
    schema: 'long-experience-replay-v1', engineVersion: ENGINE_VERSION,
    fingerprint: decision.experienceFingerprint, size: 0, frozen: true,
    complete: true, patterns: [], patternCount: 0,
  };
  const game = {
    id: 'c3e03812-8835-4f8e-8e76-e1ea768e2929', room_code: 'PAIRED-1',
    engine_version: ENGINE_VERSION, difficulty: 'hard', bot_color: 'dark', winner: 'white',
    result_type: 'mars', decisions: [decision],
    final_state: {
      variant: 'long', analysis: { botMemory: {
        engineVersion: ENGINE_VERSION,
        coverage: { complete: true, expectedBotDecisions: 1, recordedBotDecisions: 1, recoveredBotDecisions: 0 },
        replayExperience,
      } },
    },
  };
  return { decision, game, selected, recommended, candidates: [selected, recommended] };
}

function outcomeOptions(recommended, records = []) {
  return {
    runtime: fakeRuntime(),
    outcomeRunner(runtime, after, botColor, seeds, limits, startedAt, metadata) {
      records.push({ sample: metadata.sample, seeds: { ...seeds }, position: afterPositionKey(metadata.candidate) });
      const won = afterPositionKey(metadata.candidate) === afterPositionKey(recommended);
      return { complete: true, winner: won ? 'dark' : 'white', botWon: won, plies: 1 };
    },
  };
}

test('paired rollouts use identical future dice for every legal after-state and strict simultaneous bounds', async () => {
  const { decision, candidates, recommended } = fixture();
  const records = [];
  const outcomes = await generatePairedPolicyOutcomes(decision, candidates, outcomeOptions(recommended, records));
  assert.equal(outcomes.ok, true);
  assert.equal(outcomes.eligible, true);
  assert.equal(outcomes.coverage.terminalOutcomes, 64);
  assert.equal(outcomes.coverage.samplesPerCandidate, 32);
  assert.equal(outcomes.coverage.confidenceMethod, 'hoeffding-union-bound-v1');
  for (let sample = 0; sample < 32; sample += 1) {
    const pair = records.filter(record => record.sample === sample);
    assert.equal(pair.length, 2);
    assert.deepEqual(pair[0].seeds, pair[1].seeds);
  }
  const interval = simultaneousHoeffding(32, 32, 2, 0.05);
  const expected = Math.sqrt(Math.log(80) / 64);
  assert.ok(Math.abs(interval.lower - (1 - expected)) < 1e-12);
  assert.equal(validatePairedOutcomeEvidence(outcomes, decision, candidates), '');
});

test('incomplete/censored outcomes reject the whole decision rather than becoming a loss', async () => {
  const { decision, candidates, recommended } = fixture();
  const options = outcomeOptions(recommended);
  options.outcomeRunner = (runtime, after, color, seeds, limits, start, metadata) => (
    metadata.sample === 3
      ? { complete: false, reason: 'rollout-ply-limit' }
      : { complete: true, winner: 'dark', botWon: true }
  );
  const outcomes = await generatePairedPolicyOutcomes(decision, candidates, options);
  assert.equal(outcomes.ok, false);
  assert.equal(outcomes.reason, 'rollout-ply-limit');
  assert.equal(outcomes.candidates, undefined);
  assert.equal(outcomes.coverage.complete, false);
});

test('sample gate, broad candidate caps, and ambiguous estimates fail closed', async () => {
  const { decision, candidates, recommended } = fixture();
  let outcomes = await generatePairedPolicyOutcomes(decision, candidates, {
    ...outcomeOptions(recommended), rolloutLimits: { samples: 16, minSamples: 16 },
  });
  assert.equal(outcomes.ok, false);
  assert.equal(outcomes.reason, 'rollout-sample-gate');
  outcomes = await generatePairedPolicyOutcomes(decision, candidates, {
    ...outcomeOptions(recommended), rolloutLimits: { maxUniquePositions: 1 },
  });
  assert.equal(outcomes.reason, 'rollout-position-limit');
  outcomes = await generatePairedPolicyOutcomes(decision, candidates, {
    runtime: fakeRuntime(),
    outcomeRunner(runtime, after, color, seeds, limits, start, metadata) {
      const limit = afterPositionKey(metadata.candidate) === afterPositionKey(recommended) ? 18 : 16;
      const won = metadata.sample < limit;
      return { complete: true, winner: won ? 'dark' : 'white', botWon: won };
    },
  });
  assert.equal(outcomes.ok, true);
  assert.equal(outcomes.eligible, false);
  assert.ok(outcomes.regret > 0);
  assert.ok(outcomes.regretLcb < 0);
});

test('actual frozen v35 terminal rollouts complete a small exact late-race cohort', async () => {
  clearRuntimeCache();
  const runtime = loadRuntime();
  const state = runtime.game.initialState('long');
  Object.assign(state, {
    phase: 'move', turn: 'dark',
    points: { 16: { color: 'dark', count: 1 }, 13: { color: 'dark', count: 1 }, 5: { color: 'white', count: 1 } },
    off: { white: 14, dark: 13 }, bar: { white: 0, dark: 0 }, dice: [1, 2], rolled: [1, 2],
    firstMoveDone: { white: true, dark: true }, headPlayedThisTurn: { white: false, dark: false },
    turnMoves: [], history: [],
  });
  const unique = new Map();
  for (const moves of runtime.game.bestMoveSequences(state, 'dark')) {
    const after = structuredClone(state);
    for (const move of moves) assert.equal(runtime.game.applyMove(after, move.from, move.die, { autoEnd: false }), true);
    const candidate = {
      moves: moves.map(move => ({ from: move.from, to: move.bearOff ? 0 : move.to, die: move.die })),
      after, features: {}, experience: { contextKey: 'bearoff|actual-smoke', actionKey: `action:${unique.size}` },
    };
    if (!unique.has(afterPositionKey(candidate))) unique.set(afterPositionKey(candidate), candidate);
  }
  const candidates = [...unique.values()];
  assert.ok(candidates.length >= 2);
  const decision = {
    color: 'dark', selected: candidates[0],
    stateSnapshotV2: {
      schema: 'long-state-v2', variant: 'long', phase: state.phase, turn: state.turn,
      points: state.points, off: state.off, bar: state.bar, dice: state.dice, rolled: state.rolled,
      firstMoveDone: state.firstMoveDone, headPlayedThisTurn: state.headPlayedThisTurn, turnMoves: [],
    },
  };
  const outcomes = await generatePairedPolicyOutcomes(decision, candidates, {
    runtime, rolloutLimits: { maxElapsedMs: 60000, maxPlies: 40 },
  });
  assert.equal(outcomes.ok, true, outcomes.reason);
  assert.equal(outcomes.coverage.terminalOutcomes, candidates.length * 32);
  assert.equal(validatePairedOutcomeEvidence(outcomes, decision, candidates), '');
  assert.ok(outcomes.candidates.every(candidate => candidate.rolloutSamples === 32));
});

test('worker finishes a forced single-position decision without selection replay or terminal rollout', async () => {
  const { game, decision, selected } = fixture();
  let selectionCalls = 0;
  let rolloutCalls = 0;
  const result = await reviewTrustedDecision(game, decision, {
    runtimeDigest: runtimeDigest(),
    shadowReplayGenerator() {
      return { ok: true, replay: {
        coverage: { complete: true, legalSequenceCount: 1, expectedCandidates: 1 },
        candidates: [selected],
      } };
    },
    archivedSelectionReplay() { selectionCalls += 1; throw new Error('must not replay a forced action'); },
    pairedOutcomeGenerator() { rolloutCalls += 1; throw new Error('must not start a terminal cohort'); },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'rollout-alternatives-missing');
  assert.equal(result.evidence, null);
  assert.equal(result.outcomeUsed, false);
  assert.equal(selectionCalls, 0);
  assert.equal(rolloutCalls, 0);
});

test('worker ignores client/static regret and learns only its regenerated terminal-outcome evidence', async () => {
  const { game, decision, candidates, selected, recommended } = fixture();
  let regenerated = 0;
  const result = await reviewTrustedDecision(game, decision, {
    runtimeDigest: runtimeDigest(),
    shadowReplayGenerator() {
      regenerated += 1;
      return { ok: true, replay: { coverage: { complete: true, legalSequenceCount: 2, expectedCandidates: 2 }, candidates } };
    },
    archivedSelectionReplay() { return { ok: true, selected }; },
    pairedOutcomeGenerator(value, cohort) {
      return generatePairedPolicyOutcomes(value, cohort, outcomeOptions(recommended));
    },
  });
  assert.equal(regenerated, 1);
  assert.equal(result.status, 'confirmed-regret');
  assert.equal(result.evidence.schema, EVIDENCE_SCHEMA);
  assert.equal(result.evidence.reviewerVersion, WORKER_RELEASE);
  assert.equal(result.evidence.trustDomain, TRUST_DOMAIN);
  assert.equal(result.evidence.policyRole, POLICY_ROLE);
  assert.equal(result.evidence.historicalImplementationAttested, false);
  assert.equal(result.evidence.outcomeUsed, false);
  assert.equal(result.evidence.rolloutSampleCount, 32);
  assert.ok(result.evidence.regretLcb > 0.08);
  assert.match(result.evidence.evidenceId, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.evidence.categories, ['missed-home-entry', 'avoidable-home-shuffle']);
  assert.equal(result.evidence.selectedWinProbability, 0);
  assert.equal(result.evidence.recommendedWinProbability, 1);
});

test('worker refuses unsigned recursive memory and exact-action substitutions', async () => {
  const { game, decision } = fixture();
  decision.execution.executed.moves.reverse();
  assert.equal(exactExecution(decision).ok, false);
  decision.execution.executed = structuredClone(decision.selected);
  game.final_state.analysis.botMemory.replayExperience.patterns = [{ creditVersion: 9 }];
  game.final_state.analysis.botMemory.replayExperience.patternCount = 1;
  game.final_state.analysis.botMemory.replayExperience.size = 1;
  const result = await reviewTrustedDecision(game, decision);
  assert.equal(result.reason, 'recursive-experience-provenance-unsigned');
  assert.equal(result.evidence, null);
});

test('trusted server replay has a bounded 120-second cap while standalone shadow keeps five seconds', async () => {
  assert.equal(SERVER_LIMITS.maxElapsedMs, 120000);
  assert.equal(SHADOW_LIMITS.maxElapsedMs, 5000);
  for (const maximum of [undefined, 1, 250]) {
    const { game, decision } = fixture();
    let seenLimits;
    let outcomesStarted = false;
    const result = await reviewTrustedDecision(game, decision, {
      ...(maximum === undefined ? {} : { shadowLimits: { maxElapsedMs: maximum } }),
      shadowReplayGenerator(inputGame, inputDecision, options) {
        seenLimits = options.limits;
        return { ok: false, reason: 'shadow-replay-time-limit' };
      },
      pairedOutcomeGenerator() { outcomesStarted = true; throw new Error('Incomplete shadow must not learn'); },
    });
    assert.equal(seenLimits.maxElapsedMs, maximum === undefined ? 120000 : maximum);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'shadow-replay-time-limit');
    assert.equal(result.evidence, null);
    assert.equal(outcomesStarted, false);
  }
});

test('canonical cold replay counters reject coerced zero values before causal replay', async () => {
  for (const field of ['size', 'patternCount']) {
    for (const value of [null, false, '', '0', undefined, -1, 0.5]) {
      const { game, decision } = fixture();
      game.final_state.analysis.botMemory.replayExperience[field] = value;
      let replayed = false;
      const result = await reviewTrustedDecision(game, decision, {
        shadowReplayGenerator() { replayed = true; throw new Error('Noncanonical cold memory must reject'); },
      });
      assert.equal(result.status, 'rejected', `${field}=${String(value)}`);
      assert.equal(result.reason, 'recursive-experience-provenance-unsigned');
      assert.equal(result.evidence, null);
      assert.equal(replayed, false);
    }
  }
});

test('worker rejects malformed dice/checker ledgers and unbounded archived policy before replay', async () => {
  for (const mutate of [
    decision => { decision.stateSnapshotV2.dice = Array(100).fill(2); },
    decision => { decision.stateSnapshotV2.points[12].count = 10000; },
    decision => { decision.replayInput.runtime.analysisNodeBudget = 10000000; },
    decision => { decision.replayInput.runtime.weights = { pip: Infinity }; },
  ]) {
    const { game, decision } = fixture();
    mutate(decision);
    let replayed = false;
    const result = await reviewTrustedDecision(game, decision, {
      shadowReplayGenerator() { replayed = true; throw new Error('Unsafe input must not replay'); },
    });
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /^(decision-state-envelope-invalid|archived-runtime-resource-limit|unapproved-production-policy)$/);
    assert.equal(replayed, false);
    assert.equal(result.evidence, null);
  }
});

function actualArchivedDecision(policy, roll = [1, 2]) {
  clearRuntimeCache();
  const runtime = loadRuntime();
  const state = runtime.game.initialState('long');
  state.turn = 'dark';
  runtime.game.applyRoll(state, roll);
  runtime.engine.beginExperienceSession('production-policy-audit');
  runtime.engine.setExperience([], 'production-policy-audit');
  runtime.engine.freezeExperience('production-policy-audit');
  runtime.engine.plan(state, policy);
  const decision = structuredClone(runtime.engine.consumeLastDecision());
  decision.execution = {
    complete: true, fallback: false, substituted: false, selectedMatchesExecuted: true,
    executedActionKey: decision.selected.experience.actionKey,
    executed: structuredClone(decision.selected),
  };
  const replayExperience = structuredClone(runtime.engine.experienceReplaySnapshot());
  const game = {
    id: 'c3e03812-8835-4f8e-8e76-e1ea768e2929', room_code: 'POLICY-TEST',
    engine_version: ENGINE_VERSION, difficulty: 'hard', bot_color: 'dark', winner: 'white',
    decisions: [decision], final_state: { variant: 'long', analysis: { botMemory: {
      engineVersion: ENGINE_VERSION,
      coverage: { complete: true, expectedBotDecisions: 1, recordedBotDecisions: 1, recoveredBotDecisions: 0 },
      replayExperience: { ...replayExperience, complete: true, patternCount: 0 },
    } } },
  };
  return { game, decision };
}

test('real client-chosen cold policy cannot enter production learning even when it reproduces', async () => {
  const { game, decision } = actualArchivedDecision({
    strategyProfile: 'v25', maxCandidates: 1, analysisNodeBudget: 1,
    weights: { homeEntry: -1000000, distribution: -1000000 },
  });
  game.provenance = { trainingOnly: true };
  assert.equal(regenerateArchivedSelection(game, decision).reason, 'unapproved-production-policy');
  let rolloutReached = false;
  const review = await reviewTrustedDecision(game, decision, {
    pairedOutcomeGenerator() { rolloutReached = true; throw new Error('Must not reach rollout'); },
  });
  assert.equal(review.reason, 'unapproved-production-policy');
  assert.equal(rolloutReached, false);
});

test('real stable production dispatch policy reaches legal replay and skips a forced terminal cohort', async () => {
  const { game, decision } = actualArchivedDecision(PRODUCTION_POLICY);
  assert.equal(regenerateArchivedSelection(game, decision).ok, true);
  let rolloutReached = false;
  const review = await reviewTrustedDecision(game, decision, {
    pairedOutcomeGenerator() { rolloutReached = true; return { ok: false, reason: 'smoke-terminal-not-generated' }; },
  });
  assert.equal(rolloutReached, false, review.reason);
  assert.equal(review.reason, 'rollout-alternatives-missing');
  decision.replayInput.runtime.weights.homeEntry += 1;
  assert.equal((await reviewTrustedDecision(game, decision)).reason, 'unapproved-production-policy');
});

test('real forced expanded doubles skip terminal cohorts but mixed four-die encodings fail closed', async () => {
  let game;
  let decision;
  for (const roll of [[1, 1], [1, 1, 1, 1]]) {
    ({ game, decision } = actualArchivedDecision(PRODUCTION_POLICY, roll));
    assert.deepEqual(decision.stateSnapshotV2.rolled, roll);
    let rolloutReached = false;
    const review = await reviewTrustedDecision(game, decision, {
      pairedOutcomeGenerator() { rolloutReached = true; return { ok: false, reason: 'double-smoke-terminal-not-generated' }; },
    });
    assert.equal(rolloutReached, false, review.reason);
    assert.equal(review.reason, 'rollout-alternatives-missing');
  }
  for (const rolled of [[1, 2, 1, 2], [1, 1, 1, 2], [1, 1, 1], [1, 1, 1, 1, 1]]) {
    decision.stateSnapshotV2.rolled = rolled;
    assert.equal((await reviewTrustedDecision(game, decision)).reason, 'decision-state-envelope-invalid');
  }
});

test('offline policy requires an explicit trusted option and is forbidden in production claimed jobs', async () => {
  const policy = { strategyProfile: 'v25', maxCandidates: 24, analysisNodeBudget: 64 };
  const { game, decision } = actualArchivedDecision(policy);
  game.provenance = { trainingOnly: true, trustedTrainingPolicy: policy };
  assert.equal(regenerateArchivedSelection(game, decision).reason, 'unapproved-production-policy');
  assert.equal(regenerateArchivedSelection(game, decision, { trustedTrainingPolicy: policy }).ok, true);
  const other = { ...policy, analysisNodeBudget: 32 };
  assert.equal(regenerateArchivedSelection(game, decision, { trustedTrainingPolicy: other }).reason, 'trusted-training-policy-mismatch');
  await assert.rejects(runClaimedBatch({ trustedTrainingPolicy: policy }), /offline-only/);
});

function claimedArchiveJob() {
  const trainingGame = { id: '42c6ab46-f84a-567f-8f75-cd948a9c8a2e', room_code: 'CLAIM-TEST',
    engine_version: ENGINE_VERSION, difficulty: 'hard', bot_color: 'white', winner: 'dark',
    decisions: [], final_state: { variant: 'long' } };
  const archiveFingerprintSource = JSON.stringify(trainingGame);
  return { jobId: 1, runtimeDigest: runtimeDigest(), policyImplementationId: policyImplementationId(),
    archiveFingerprintSource, archiveFingerprint: crypto.createHash('sha256').update(archiveFingerprintSource).digest('hex'),
    trainingGame };
}

async function mockedClaimBatch(claimed, options = {}) {
  const calls = [];
  const previousFetch = global.fetch;
  global.fetch = async (url, request) => {
    const name = url.split('/').at(-1);
    calls.push({ name, args: JSON.parse(request.body) });
    return { ok: true, text: async () => JSON.stringify(name === 'claim_long_bot_causal_review_jobs' ? claimed : null) };
  };
  try {
    return { result: await runClaimedBatch({ supabaseUrl: 'https://claimed.example',
      serviceRoleKey: 'test-only', workerId: 'claim-test-worker', ...options }), calls };
  } catch (error) { return { error, calls }; }
  finally { global.fetch = previousFetch; }
}

test('production queue claim carries verified installed runtime digest before any work', async () => {
  const digest = runtimeDigest();
  const { result, calls } = await mockedClaimBatch([]);
  assert.equal(result.claimed, 0);
  assert.deepEqual(calls, [{ name: 'claim_long_bot_causal_review_jobs', args: {
    p_worker_id: 'claim-test-worker', p_limit: 1, p_runtime_digest: digest } }]);
  const mismatch = await mockedClaimBatch([], { runtimeDigest: '0'.repeat(64) });
  assert.match(mismatch.error.message, /Frozen worker runtime digest/);
  assert.deepEqual(mismatch.calls, [], 'a stale installed digest never leases or attempts a job');
});

test('production queue verified archive projection is bound to completion result', async () => {
  const job = claimedArchiveJob();
  const { result, error, calls } = await mockedClaimBatch([job]);
  assert.equal(error, undefined);
  assert.equal(result.claimed, 1);
  assert.equal(result.completed[0].accepted, false);
  assert.equal(result.completed[0].reason, 'decisions-missing');
  assert.equal(result.completed[0].archiveFingerprint, job.archiveFingerprint);
  assert.equal(result.completed[0].runtimeDigest, job.runtimeDigest);
  assert.equal(result.completed[0].policyImplementationId, job.policyImplementationId);
  assert.deepEqual(calls.map(call => call.name),
    ['claim_long_bot_causal_review_jobs', 'complete_long_bot_causal_review_job']);
  assert.equal(calls[1].args.p_job_id, 1);
  assert.equal(calls[1].args.p_result.archiveFingerprint, job.archiveFingerprint);
});

test('production queue rejects stale or malformed native claim identities without consuming any job', async () => {
  const native = claimedArchiveJob();
  const variants = [
    { ...native, runtimeDigest: undefined }, { ...native, runtimeDigest: null },
    { ...native, runtimeDigest: '0'.repeat(64) }, { ...native, runtimeDigest: { value: native.runtimeDigest } },
    { ...native, policyImplementationId: undefined }, { ...native, policyImplementationId: '0'.repeat(64) },
    { ...native, archiveFingerprint: null }, { ...native, archiveFingerprint: 'not-a-sha' },
    { ...native, archiveFingerprint: '0'.repeat(64) },
    { ...native, archiveFingerprintSource: null }, { ...native, archiveFingerprintSource: {} },
    { ...native, jobId: '1' }, { ...native, jobId: 0 },
    { ...native, trainingGame: { ...native.trainingGame, winner: 'white' } },
    { ...native, trainingGame: { ...native.trainingGame, finalState: { variant: 'short' } } },
    { ...native, trainingGame: null },
  ];
  for (const source of ['not-json', '[]', '{}']) variants.push({ ...native,
    archiveFingerprintSource: source,
    archiveFingerprint: crypto.createHash('sha256').update(source).digest('hex') });
  for (const claimed of [null, {}, [native, native], ...variants.map(job => [job])]) {
    const { error, calls } = await mockedClaimBatch(claimed);
    assert.ok(error, 'malformed claim must reject before review or any completion/failure RPC');
    assert.deepEqual(calls.map(call => call.name), ['claim_long_bot_causal_review_jobs']);
  }
});

test('offline dispatch policy accepts only omitted or exact production-stable weights', async () => {
  const policy = { strategyProfile: 'v25', maxCandidates: 24, analysisNodeBudget: 64 };
  assert.deepEqual(serverOwnedPolicy({ trustedTrainingPolicy: policy }), policy);
  const explicit = { ...policy, weights: { ...PRODUCTION_POLICY.weights } };
  assert.deepEqual(serverOwnedPolicy({ trustedTrainingPolicy: explicit }), explicit);
  const { game, decision } = actualArchivedDecision(explicit);
  assert.equal(regenerateArchivedSelection(game, decision, { trustedTrainingPolicy: explicit }).ok, true);
  assert.equal(regenerateArchivedSelection(game, decision).reason, 'unapproved-production-policy');
  await assert.rejects(runClaimedBatch({ trustedTrainingPolicy: explicit }), /offline-only/);
  for (const weights of [
    {}, null, { homeEntry: PRODUCTION_POLICY.weights.homeEntry },
    { ...PRODUCTION_POLICY.weights, homeEntry: PRODUCTION_POLICY.weights.homeEntry + 1 },
    { ...PRODUCTION_POLICY.weights, distribution: Infinity },
    { ...PRODUCTION_POLICY.weights, trapRisk: NaN },
    { ...PRODUCTION_POLICY.weights, added: 1 },
  ]) assert.throws(() => serverOwnedPolicy({ trustedTrainingPolicy: { ...policy, weights } }), /Invalid explicit trusted offline/);
});

test('release digest covers every transitive executable dependency including simulator dice and dispatch', () => {
  clearRuntimeCache();
  const entries = runtimeClosureEntries();
  const names = entries.map(([name]) => name);
  for (const name of ['game', 'engine-bundle', 'worker', 'reviewer', 'paired-rollout', 'shadow-replay', 'simulator-dice', 'production-dispatch', 'policy-build-binding']) {
    assert.ok(names.includes(name), `${name} must be in the executable closure`);
  }
  for (const name of policyBuilder.SOURCES) assert.ok(names.includes(`policy-source:${name}`));
  const initial = runtimeDigestFromEntries(entries);
  for (const [name] of entries) {
    const changed = entries.map(([entryName, bytes]) => [entryName, entryName === name ? Buffer.concat([bytes, Buffer.from('\n// changed executable dependency')]) : bytes]);
    assert.notEqual(runtimeDigestFromEntries(changed), initial, `${name} must change the active release digest`);
  }
  assert.notEqual(runtimeDigestFromEntries(entries, {
    trustedTrainingPolicy: { strategyProfile: 'v25', maxCandidates: 24, analysisNodeBudget: 64 },
  }), initial);
  assert.throws(() => verifiedRuntimeDigest({ runtimeDigest: 'a'.repeat(64) }), /does not match its executable closure/);
  assert.equal(verifiedRuntimeDigest({ runtimeDigest: initial }), initial);
});

test('noncircular policy implementation SHA covers all TS/rules/dispatch preimages and matches the actual bundle', () => {
  const entries = policyBuilder.readPolicySourceEntries();
  const id = policyBuilder.policyImplementationId(entries);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(policyImplementationId(), id);
  for (const [name] of entries) {
    const changed = entries.map(([entryName, bytes]) => [entryName, entryName === name ? Buffer.concat([bytes, Buffer.from('\n// changed policy source')]) : bytes]);
    assert.notEqual(policyBuilder.policyImplementationId(changed), id, name);
  }
});

test('worker rejects a built implementation header that does not match the actual rules preimage', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-policy-binding-negative-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const gamePath = path.join(directory, 'game.js');
  fs.writeFileSync(gamePath, `${fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8')}\n// stale rules/preimage\n`);
  assert.throws(() => policyImplementationId({ gamePath }), /does not match its source\/rules\/production-weight preimage/);
  const runtimePath = path.join(directory, 'long-bot-engine.js');
  fs.writeFileSync(runtimePath, `${fs.readFileSync(path.join(ROOT, 'long-bot-engine.js'), 'utf8')}\n// modified executable, unchanged header\n`);
  assert.throws(() => policyImplementationId({ runtimePath }), /does not match its canonical policy implementation preimage/);
});

test('collision-resistant identities are canonical but preserve exact move order', () => {
  const { decision, selected, recommended } = fixture();
  const first = collisionResistantIdentities(decision, selected, recommended);
  const reordered = structuredClone(decision);
  reordered.stateSnapshotV2 = Object.fromEntries(Object.entries(reordered.stateSnapshotV2).reverse());
  assert.deepEqual(collisionResistantIdentities(reordered, selected, recommended), first);
  const reverseMoves = structuredClone(selected);
  reverseMoves.moves.reverse();
  assert.notEqual(collisionResistantIdentities(decision, reverseMoves, recommended).selectedActionId, first.selectedActionId);
});

test('mixed ledgers and incomplete game coverage never reach causal analysis', async () => {
  const { game } = fixture();
  assert.equal(validateGameEnvelope(game), '');
  game.decisions[0].engineVersion = 'long-analytic-v34';
  const result = await analyzeTrainingGame(game);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'mixed-engine-ledger');
  assert.equal(result.evidence.length, 0);
});

test('trusted offline work scope validates the complete envelope and reviews only requested snapshots', async () => {
  const { game, decision, candidates, selected, recommended } = fixture();
  game.decisions = Array.from({ length: 3 }, (_, index) => ({ ...structuredClone(decision), id: `scoped-${index}` }));
  Object.assign(game.final_state.analysis.botMemory.coverage, { expectedBotDecisions: 3, recordedBotDecisions: 3 });
  const original = structuredClone(game);
  const seen = [];
  const options = {
    trustedTrainingPolicy: structuredClone(PRODUCTION_POLICY), reviewDecisionIndexes: [2],
    shadowReplayGenerator(input, value) {
      seen.push({ game: input, decision: value });
      return { ok: true, replay: { coverage: { complete: true, legalSequenceCount: 2, expectedCandidates: 2 }, candidates } };
    },
    archivedSelectionReplay() { return { ok: true, selected }; },
    pairedOutcomeGenerator(value, cohort) {
      return generatePairedPolicyOutcomes(value, cohort, outcomeOptions(recommended));
    },
  };
  const result = await analyzeTrainingGame(game, options);
  assert.equal(result.accepted, true, result.reason);
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].decisionId, 'scoped-2');
  assert.equal(result.summary.decisionsSeen, 3);
  assert.equal(result.summary.botDecisionsSeen, 1);
  assert.equal(result.summary.evidenceCount, 1);
  assert.equal(result.selection.policyRole, 'current-frozen-cold-re-review');
  assert.equal(result.selection.historicalImplementationAttested, false);
  assert.equal(result.evidence[0].policyImplementationId, result.policyImplementationId);
  assert.equal(result.evidence[0].policyRole, result.selection.policyRole);
  assert.equal(result.evidence[0].historicalImplementationAttested, false);
  assert.deepEqual(result.reviewCoverage, {
    schema: 'long-server-game-review-coverage-v1', fullGameEnvelopeValidated: true,
    decisionSnapshotsVerified: 'reviewed-only', scope: 'trusted-offline-indexes',
    totalLedgerDecisions: 3, totalBotDecisions: 3,
    requestedDecisionIndexes: [2], attemptedDecisionIndexes: [2], finishedDecisionIndexes: [2],
    completedOutcomeCohorts: 1, selectionCoversWholeLedger: false, everyRequestedReviewFinished: true,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].game, game);
  assert.equal(seen[0].game.decisions.length, 3);
  assert.deepEqual(game, original, 'work selection must not truncate or mutate durable telemetry');

  game.final_state.analysis.botMemory.coverage.expectedBotDecisions = 2;
  const rejected = await analyzeTrainingGame(game, options);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'training-coverage-incomplete');
  assert.equal(rejected.reviewCoverage.fullGameEnvelopeValidated, false);
  assert.deepEqual(rejected.reviewCoverage.attemptedDecisionIndexes, []);
  assert.equal(rejected.evidence.length, 0);
  assert.equal(seen.length, 1, 'invalid untruncated envelope must reject before any scoped replay');

  game.final_state.analysis.botMemory.coverage.expectedBotDecisions = 3;
  game.decisions[0].engineVersion = 'long-analytic-v34';
  const mixed = await analyzeTrainingGame(game, options);
  assert.equal(mixed.accepted, false);
  assert.equal(mixed.reason, 'mixed-engine-ledger');
  assert.equal(mixed.reviewCoverage.fullGameEnvelopeValidated, false);
  assert.equal(mixed.evidence.length, 0);
  assert.equal(seen.length, 1, 'an unselected mixed-generation record invalidates the full envelope');
});

test('scoped work is explicit trusted offline input, unique and restricted to original bot indexes', async () => {
  const { game, decision } = fixture();
  game.decisions.push({ ...structuredClone(decision), id: 'opponent', actor: 'opponent', color: 'white' });
  const policy = { trustedTrainingPolicy: structuredClone(PRODUCTION_POLICY) };
  assert.equal(trustedReviewSelection(game).reason, '');
  assert.deepEqual(trustedReviewSelection(game).indexes, [0]);
  game.provenance = { trainingOnly: true, reviewDecisionIndexes: [0] };
  assert.equal(trustedReviewSelection(game, { reviewDecisionIndexes: [0] }).reason,
    'offline-review-scope-requires-trusted-policy');
  for (const indexes of [[], [0, 0], [1], [2], ['0'], [NaN], Array(9).fill(0), null]) {
    assert.equal(trustedReviewSelection(game, { ...policy, reviewDecisionIndexes: indexes }).reason,
      'trusted-review-decision-indexes-invalid');
  }
  assert.deepEqual(trustedReviewSelection(game, { ...policy, reviewDecisionIndexes: [0] }).indexes, [0]);
  await assert.rejects(runClaimedBatch({ reviewDecisionIndexes: [0] }), /offline-only/);
  await assert.rejects(runClaimedBatch({ ...policy, reviewDecisionIndexes: [0] }), /offline-only/);
});

test('full-envelope coverage counts remain native finite integers under scoped offline review', async () => {
  for (const field of ['expectedBotDecisions', 'recordedBotDecisions', 'recoveredBotDecisions']) {
    for (const value of [true, false, '1', '0', '', null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const { game } = fixture();
      game.final_state.analysis.botMemory.coverage[field] = value;
      let replayed = false;
      const result = await analyzeTrainingGame(game, {
        trustedTrainingPolicy: structuredClone(PRODUCTION_POLICY), reviewDecisionIndexes: [0],
        shadowReplayGenerator() { replayed = true; throw new Error('Malformed full envelope must reject'); },
      });
      assert.equal(result.accepted, false, `${field}=${String(value)}`);
      assert.equal(result.reason, 'training-coverage-incomplete');
      assert.equal(result.reviewCoverage.fullGameEnvelopeValidated, false);
      assert.equal(result.evidence.length, 0);
      assert.equal(replayed, false);
    }
  }
});

test('exact observation deduplication is independent of replay order, decision IDs and export IDs', () => {
  const first = { runtimeDigest: 'a'.repeat(64), stateId: 'b'.repeat(64), selectedActionId: 'c'.repeat(64),
    evidenceId: 'first', decisionId: 'decision-1' };
  const duplicate = { ...first, evidenceId: 'second', decisionId: 'decision-2' };
  const separate = { ...first, stateId: 'd'.repeat(64), evidenceId: 'third' };
  assert.deepEqual(uniqueCausalEvidence([first, duplicate, separate, first]), [first, separate]);
  assert.deepEqual(uniqueCausalEvidence([duplicate, separate, first]), [duplicate, separate]);
});

test('opponent telemetry does not consume the bot decision review budget', () => {
  const { game, decision } = fixture();
  game.decisions = [
    ...Array.from({ length: 80 }, (_, index) => ({ ...structuredClone(decision), id: `bot-${index}` })),
    ...Array.from({ length: 81 }, (_, index) => ({ ...structuredClone(decision), id: `opponent-${index}`, actor: 'opponent', color: 'white' })),
  ];
  game.final_state.analysis.botMemory.coverage.expectedBotDecisions = 80;
  game.final_state.analysis.botMemory.coverage.recordedBotDecisions = 80;
  assert.equal(validateGameEnvelope(game), '');
  game.decisions.push(...Array.from({ length: 160 }, () => ({ ...structuredClone(decision), actor: 'opponent', color: 'white' })));
  assert.equal(validateGameEnvelope(game), 'decision-ledger-limit');
});

test('server causal SQL keeps ingestion private and replaces outcome-labelled public patterns', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/long-bot-causal-learning-v35.sql'), 'utf8');
  assert.match(sql, /revoke all on private\.long_bot_causal_evidence from public, anon, authenticated, service_role/);
  assert.match(sql, /grant execute on function public\.complete_long_bot_causal_review_job\(bigint, text, jsonb\) to service_role/);
  assert.doesNotMatch(sql, /grant execute on function public\.complete_long_bot_causal_review_job[^;]*to anon/);
  assert.match(sql, /for update of queued skip locked/);
  assert.match(sql, /'creditVersion', 9/);
  assert.match(sql, /'confidenceMethod' is distinct from 'hoeffding-union-bound-v1'/);
  assert.match(sql, /regretLcb'\), 0\) <= 0\.08/);
  assert.match(sql, /least\(32, count\(distinct evidence\.state_id\)\)/);
  assert.match(sql, /queued\.attempts >= 3 and \(/);
  assert.match(sql, /queued\.status = 'leased' and queued\.lease_until <= pg_catalog\.now\(\)/);
  assert.match(sql, /'policyImplementationId', policy_implementation_id/);
  assert.doesNotMatch(sql, /count\(distinct evidence\.evidence_id\)/);
  assert.doesNotMatch(sql, /compute_long_bot_experience_patterns/);
});

function causalPattern() {
  return {
    creditVersion: 9, evidenceSchema: 'long-server-causal-pattern-v1',
    reviewerVersion: WORKER_RELEASE, trustDomain: TRUST_DOMAIN,
    runtimeDigest: 'a'.repeat(64), aggregateId: 'b'.repeat(64),
    policyImplementationId: policyImplementationId(),
    contextKey: 'route|paired-test', actionKey: 'selected:route',
    samples: 3, losses: 3, wins: 0, lossWeight: 4.5,
    signalWeight: 4.5, severeLosses: 0, winWeight: 0, outcomeUsed: false,
  };
}

test('v35 consumes causal v9 only from live server RPC and never from local cache', async () => {
  const pattern = causalPattern();
  const storage = new Map([['narduh-long-bot-server-experience-v15', JSON.stringify({
    savedAt: Date.now(), playerKey: 'tester', creditVersion: 8, patterns: [pattern],
  })]]);
  const applied = [];
  const context = {
    window: {
      NarduLongBotEngine: { version: ENGINE_VERSION, policyImplementationId: policyImplementationId(), setExperience(patterns, source) { applied.push({ patterns, source }); } },
      NarduSupabase: { configured() { return true; }, async client() { return { async rpc() { return { data: [pattern], error: null }; } }; } },
    },
    localStorage: { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, value); }, removeItem(key) { storage.delete(key); } },
    Date, Math, JSON, Map, Uint8Array, TextEncoder, fetch, console,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'rooms-client.js'), 'utf8'), context);
  const result = await context.window.NarduRooms.loadLongBotExperience({ playerName: 'tester' });
  assert.equal(result.length, 1);
  assert.equal(applied.some(item => item.source === 'server-cache' && item.patterns.length), false);
  assert.equal(applied.some(item => item.source === 'server' && item.patterns.length === 1), true);
  assert.equal(storage.has('narduh-long-bot-server-experience-v15'), false);
});

test('a v35 tab rejects live causal patterns from another policy implementation and unbuilt modules fail closed', async () => {
  const pattern = causalPattern();
  for (const currentId of ['f'.repeat(64), '', undefined]) {
    const applied = [];
    const context = {
      window: {
        NarduLongBotEngine: { version: ENGINE_VERSION, policyImplementationId: currentId, setExperience(patterns) { applied.push(patterns); } },
        NarduSupabase: { configured() { return true; }, async client() { return { async rpc() { return { data: [pattern], error: null }; } }; } },
      }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      Date, Math, JSON, Map, Uint8Array, TextEncoder, fetch, console,
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'rooms-client.js'), 'utf8'), context);
    const result = await context.window.NarduRooms.loadLongBotExperience({ playerName: 'tester' });
    assert.equal(result.length, 0);
    assert.equal(applied.some(patterns => patterns.length > 0), false);
  }
  const { createBrowserLongBotEngine: createRawBrowserEngine } = await import(pathToFileURL(path.join(ROOT, 'bot-engine/long/browser.ts')).href);
  const raw = createRawBrowserEngine(loadRuntime().game, { experienceStorage: null });
  assert.equal(raw.policyImplementationId, '');
  raw.setExperience([{ ...pattern, policyImplementationId: '' }], 'server');
  assert.equal(raw.experienceSnapshot().size, 0);
});

test('trusted server-fed frozen session resumes the identical policy without accepting legacy memory', async () => {
  clearRuntimeCache();
  const game = loadRuntime().game;
  const values = new Map();
  const storage = {
    get length() { return values.size; }, key(index) { return [...values.keys()][index]; },
    getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); },
  };
  const first = createBrowserLongBotEngine(game, { experienceStorage: storage });
  first.beginExperienceSession('trusted-resume');
  first.setExperience([causalPattern()], 'server');
  const snapshot = first.freezeExperience('trusted-resume');
  assert.ok(snapshot.size > 0);
  const resumed = createBrowserLongBotEngine(game, { experienceStorage: storage });
  const restored = resumed.beginExperienceSession('trusted-resume');
  assert.equal(restored.frozen, true);
  assert.equal(restored.fingerprint, snapshot.fingerprint);
  assert.equal(restored.size, snapshot.size);
});

test('moving from a restored causal session to a new room clears its old policy', async () => {
  clearRuntimeCache();
  const game = loadRuntime().game;
  const values = new Map();
  const storage = {
    get length() { return values.size; }, key(index) { return [...values.keys()][index]; },
    getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); },
  };
  const original = createBrowserLongBotEngine(game, { experienceStorage: storage });
  original.beginExperienceSession('old-causal-room');
  original.setExperience([causalPattern()], 'server');
  const originalSnapshot = original.freezeExperience('old-causal-room');

  const resumed = createBrowserLongBotEngine(game, { experienceStorage: storage });
  assert.equal(resumed.beginExperienceSession('old-causal-room').size, 1);
  resumed.setExperience([], 'server');
  // Reannouncing the same room must not drain a mid-game refresh.
  assert.equal(resumed.beginExperienceSession('old-causal-room').fingerprint, originalSnapshot.fingerprint);
  const nextSnapshot = resumed.beginExperienceSession('new-cold-room');
  assert.equal(nextSnapshot.size, 0);
  assert.equal(nextSnapshot.frozen, false);
  assert.notEqual(nextSnapshot.fingerprint, originalSnapshot.fingerprint);
  assert.deepEqual(resumed.experienceReplaySnapshot().patterns, []);
});

test('restoring a saved session isolates preloaded live sources and defers their latest payload', async () => {
  clearRuntimeCache();
  const game = loadRuntime().game;
  const values = new Map();
  const storage = {
    get length() { return values.size; }, key(index) { return [...values.keys()][index]; },
    getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); },
  };
  const original = createBrowserLongBotEngine(game, { experienceStorage: storage });
  original.beginExperienceSession('saved-causal-room');
  original.setExperience([causalPattern()], 'server');
  const savedSnapshot = original.freezeExperience();

  const resumed = createBrowserLongBotEngine(game, { experienceStorage: storage });
  const prefetched = { ...causalPattern(), actionKey: 'prefetched-live-action' };
  const latest = { ...causalPattern(), actionKey: 'latest-live-action' };
  resumed.setExperience([prefetched], 'server');
  const restored = resumed.beginExperienceSession('saved-causal-room');
  assert.equal(restored.fingerprint, savedSnapshot.fingerprint);
  assert.equal(restored.size, savedSnapshot.size);
  assert.deepEqual(resumed.experienceReplaySnapshot().patterns.map(pattern => pattern.actionKey), ['selected:route']);
  assert.deepEqual(restored.pendingSources, ['server']);
  resumed.setExperience([latest], 'server');
  assert.equal(resumed.beginExperienceSession('saved-causal-room').fingerprint, savedSnapshot.fingerprint);

  const next = resumed.beginExperienceSession('next-causal-room');
  assert.equal(next.size, 1);
  assert.deepEqual(resumed.experienceReplaySnapshot().patterns.map(pattern => pattern.actionKey), ['latest-live-action']);
  assert.deepEqual(next.pendingSources, []);
});
