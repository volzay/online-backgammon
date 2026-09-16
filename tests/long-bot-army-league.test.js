const test = require('node:test');
const assert = require('node:assert/strict');

const { diceStreamSeeds } = require('../scripts/simulate-long-bot-regression');
const {
  aggregateArmyReports,
  parseOptions,
  partitionPairIndices,
} = require('../scripts/league-long-bot-army');

const RESOURCES = Object.freeze({
  nodes: 8,
  candidates: 4,
  profile: 'v25',
  maxPlies: 320,
});
const IDENTITY = Object.freeze({
  harnessSourceFingerprint: `sha256:${'c'.repeat(64)}`,
  candidate: {
    engineVersion: 'candidate-test',
    runtimeFingerprint: `sha256:${'a'.repeat(64)}`,
    source: { kind: 'test' },
  },
  control: {
    engineVersion: 'long-analytic-v34',
    runtimeFingerprint: `sha256:${'b'.repeat(64)}`,
    source: { kind: 'test' },
  },
});

function options(pairs, overrides = {}) {
  return {
    pairs,
    workers: Math.min(4, pairs),
    minimumGames: pairs * 2,
    seed: 0x51a7c0de,
    resources: { ...RESOURCES },
    targetWinRate: 0.65,
    sidecarAnalysis: false,
    ...overrides,
  };
}

function pairLegs(pairIndex, seed, candidateWins = 2) {
  return [1, 2].map(leg => {
    const botColor = leg === 1 ? 'white' : 'dark';
    const botWon = leg <= candidateWins;
    return {
      game: pairIndex * 2 + leg,
      pair: pairIndex + 1,
      leg,
      botColor,
      controlColor: botColor === 'white' ? 'dark' : 'white',
      streamSeeds: diceStreamSeeds(seed, pairIndex),
      winner: botWon ? botColor : (botColor === 'white' ? 'dark' : 'white'),
      botWon,
      resultType: 'normal',
      productionDispatch: true,
      productionPolicyWeights: { homeEntry: 145000 },
      sidecarAnalysis: false,
    };
  });
}

function shardReports(assignments, runOptions, candidateWinsForPair = () => 2) {
  return assignments.map(assignment => ({
    schemaVersion: 1,
    shardId: assignment.shardId,
    pairIndices: [...assignment.pairIndices],
    completed: true,
    seed: runOptions.seed,
    resources: { ...runOptions.resources },
    sidecarAnalysis: runOptions.sidecarAnalysis,
    harnessSourceFingerprint: IDENTITY.harnessSourceFingerprint,
    candidate: {
      engineVersion: IDENTITY.candidate.engineVersion,
      runtimeFingerprint: IDENTITY.candidate.runtimeFingerprint,
    },
    control: {
      engineVersion: IDENTITY.control.engineVersion,
      runtimeFingerprint: IDENTITY.control.runtimeFingerprint,
    },
    results: assignment.pairIndices.flatMap(pairIndex => (
      pairLegs(pairIndex, runOptions.seed, candidateWinsForPair(pairIndex))
    )),
  }));
}

test('army partition has deterministic disjoint pair indices and unique dice streams', () => {
  const first = partitionPairIndices(17, 4);
  const second = partitionPairIndices(17, 4);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(shard => shard.pairIndices), [
    [0, 4, 8, 12, 16],
    [1, 5, 9, 13],
    [2, 6, 10, 14],
    [3, 7, 11, 15],
  ]);
  const indices = first.flatMap(shard => shard.pairIndices);
  assert.deepEqual([...indices].sort((left, right) => left - right),
    Array.from({ length: 17 }, (_, index) => index));
  assert.equal(new Set(indices).size, 17);

  const streamSeeds = indices.flatMap(pairIndex => {
    const streams = diceStreamSeeds(0x51a7c0de, pairIndex);
    return [streams.white, streams.dark];
  });
  assert.equal(new Set(streamSeeds).size, 34);
  assert.ok(streamSeeds.every(seed => Number.isInteger(seed) && seed > 0));
});

test('army aggregation certifies only a complete, sufficiently large, high-confidence run', () => {
  const runOptions = options(20);
  const assignments = partitionPairIndices(runOptions.pairs, runOptions.workers);
  const payload = aggregateArmyReports({
    options: runOptions,
    identity: IDENTITY,
    assignments,
    shardReports: shardReports(assignments, runOptions),
  });
  assert.equal(payload.completion.complete, true);
  assert.equal(payload.completion.stopReason, 'requested-pairs-completed');
  assert.equal(payload.summary.completedGames, 40);
  assert.equal(payload.summary.observedWinRate, 1);
  assert.ok(payload.summary.pairedWilson95.lower >= 0.65);
  assert.ok(payload.summary.pairedHoeffding95.lower >= 0.65);
  assert.equal(payload.summary.verdict, 'certified');
  assert.equal(payload.summary.passed, true);
  assert.equal(payload.pairs.length, 20);
  assert.deepEqual(payload.pairs.map(pair => pair.pairIndex),
    Array.from({ length: 20 }, (_, index) => index));
});

test('army aggregation rejects an observed 65 percent without bounded-pair confidence', () => {
  const runOptions = options(20);
  const assignments = partitionPairIndices(runOptions.pairs, runOptions.workers);
  // 13 pair sweeps and 7 pair losses = exactly 65% across 40 games.
  const payload = aggregateArmyReports({
    options: runOptions,
    identity: IDENTITY,
    assignments,
    shardReports: shardReports(assignments, runOptions, pairIndex => pairIndex < 13 ? 2 : 0),
  });
  assert.equal(payload.summary.observedWinRate, 0.65);
  assert.equal(payload.summary.checks.observedThresholdMet, true);
  assert.equal(payload.summary.checks.pairedHoeffdingLowerThresholdMet, false);
  assert.equal(payload.summary.verdict, 'not-certified');
  assert.equal(payload.summary.reason, 'confidence-below-target');
  assert.equal(payload.summary.passed, false);
});

test('an eight-pair sweep cannot be certified by fractional Wilson alone', () => {
  const runOptions = options(8);
  const assignments = partitionPairIndices(runOptions.pairs, runOptions.workers);
  const payload = aggregateArmyReports({
    options: runOptions,
    identity: IDENTITY,
    assignments,
    shardReports: shardReports(assignments, runOptions),
  });
  assert.ok(payload.summary.pairedWilson95.lower >= 0.65);
  assert.ok(payload.summary.pairedHoeffding95.lower < 0.65);
  assert.equal(payload.summary.verdict, 'not-certified');
});

test('army aggregation fails closed on missing shard, altered seeds, or runtime mismatch', () => {
  const runOptions = options(8, { targetWinRate: 0 });
  const assignments = partitionPairIndices(runOptions.pairs, runOptions.workers);

  const missing = aggregateArmyReports({
    options: runOptions,
    identity: IDENTITY,
    assignments,
    shardReports: shardReports(assignments, runOptions).slice(1),
    workerFailures: [{ shardId: 0, exitCode: 2, signal: null, error: 'test', stderr: '' }],
  });
  assert.equal(missing.completion.complete, false);
  assert.equal(missing.completion.stopReason, 'worker-failure');
  assert.equal(missing.summary.passed, false);

  const alteredSeedReports = shardReports(assignments, runOptions);
  alteredSeedReports[0].results[0].streamSeeds.white += 1;
  const alteredSeed = aggregateArmyReports({
    options: runOptions,
    identity: IDENTITY,
    assignments,
    shardReports: alteredSeedReports,
  });
  assert.equal(alteredSeed.completion.complete, false);
  assert.match(alteredSeed.completion.integrityErrors.join('\n'), /deterministic color-bound dice/);
  assert.equal(alteredSeed.summary.passed, false);

  const alteredRuntimeReports = shardReports(assignments, runOptions);
  alteredRuntimeReports[1].candidate.runtimeFingerprint = `sha256:${'c'.repeat(64)}`;
  const alteredRuntime = aggregateArmyReports({
    options: runOptions,
    identity: IDENTITY,
    assignments,
    shardReports: alteredRuntimeReports,
  });
  assert.equal(alteredRuntime.completion.complete, false);
  assert.match(alteredRuntime.completion.integrityErrors.join('\n'), /different candidate runtime/);
  assert.equal(alteredRuntime.summary.passed, false);
});

test('army CLI requires an attainable even minimum game count', () => {
  const parsed = parseOptions([
    '--pairs', '8',
    '--workers', '3',
    '--min-games', '12',
    '--nodes', '8',
    '--candidates', '4',
  ]);
  assert.equal(parsed.pairs, 8);
  assert.equal(parsed.workers, 3);
  assert.equal(parsed.minimumGames, 12);
  assert.equal(parsed.expectedCandidateVersion, 'long-analytic-v35');
  assert.equal(parsed.expectedControlVersion, 'long-analytic-v34');
  assert.deepEqual(parsed.resources, {
    nodes: 8,
    candidates: 4,
    profile: 'v25',
    maxPlies: 320,
  });
  assert.throws(() => parseOptions(['--pairs', '8', '--min-games', '11']), /even integer/);
  assert.throws(() => parseOptions(['--pairs', '8', '--min-games', '18']), /cannot exceed/);
});
