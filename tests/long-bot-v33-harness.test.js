const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  diceStreamSeeds,
  exportExperiencePatterns,
  readLocalExperienceSnapshot,
} = require('../scripts/simulate-long-bot-regression');
const {
  DEFAULT_MIN_HOLDOUT_PAIRS,
  DEFAULT_SEED_SPLITS,
  buildReport,
  evaluateHoldoutGate,
  resultMatchPoints,
  summarizeSplit,
  suiteFingerprint,
  validateSeedSplits,
  validateSuiteDiceStreams,
  wilsonInterval,
} = require('../scripts/long-bot-v33-harness');
const {
  assertExperienceIdentity,
  EMPTY_EXPERIENCE_FINGERPRINT,
  dryRunReport,
  describeExperience,
  parseOptions,
  runPipeline,
} = require('../scripts/train-certify-long-bot-v33');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function pairedPayload(seed, {
  games = 2,
  wins = games,
  severeLosses = 0,
  learn = false,
  engineVersion = 'long-analytic-v33',
  runtimeFingerprint = HASH_A,
  experienceFingerprint = HASH_B,
} = {}) {
  let severeRemaining = severeLosses;
  const results = Array.from({ length: games }, (_, index) => {
    const pair = Math.floor(index / 2) + 1;
    const leg = index % 2 + 1;
    const botColor = leg === 1 ? 'white' : 'dark';
    const controlColor = botColor === 'white' ? 'dark' : 'white';
    const botWon = index < wins;
    const resultType = !botWon && severeRemaining-- > 0
      ? (index % 2 ? 'koks' : 'mars')
      : 'normal';
    return {
      game: index + 1,
      pair,
      leg,
      botColor,
      controlColor,
      streamSeeds: diceStreamSeeds(seed, pair - 1),
      winner: botWon ? botColor : controlColor,
      botWon,
      resultType,
    };
  });
  return {
    summary: {
      engineVersion,
      runtimeFingerprint,
      simulatorHarnessFingerprint: `sha256:${'c'.repeat(64)}`,
      experienceFingerprint,
      options: { learn, botProfile: 'v25', controlProfile: 'v19' },
    },
    results,
  };
}

test('v33 suite seeds are deterministic and strictly disjoint', () => {
  const validated = validateSeedSplits(DEFAULT_SEED_SPLITS);
  const all = Object.values(validated).flat();
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(validateSeedSplits(DEFAULT_SEED_SPLITS), validated);
  assert.throws(() => validateSeedSplits({
    train: [1, 2],
    validation: [3, 1],
    holdout: [4],
  }), /leaks across train and validation/);
  assert.throws(() => validateSeedSplits({
    train: [1],
    validation: [2],
    holdout: [],
  }), /holdout seeds are required/);
  const suite = validateSuiteDiceStreams(validated, 20);
  assert.equal(suite.derivedDiceStreamCount, all.length * 20 / 2 * 2);
});

test('simulator exports the newest local experience generation deterministically', () => {
  const storage = new Map([
    ['unrelated', '[]'],
    ['narduh-long-bot-experience-v7', JSON.stringify([{
      creditVersion: 7,
      contextKey: 'old',
      actionKey: 'old',
    }])],
    ['narduh-long-bot-experience-v8', JSON.stringify([{
      creditVersion: 8,
      contextKey: 'new',
      actionKey: 'new',
    }])],
  ]);
  const snapshot = readLocalExperienceSnapshot(storage);
  assert.equal(snapshot.storageKey, 'narduh-long-bot-experience-v8');
  assert.equal(snapshot.creditVersion, 8);
  assert.equal(snapshot.patterns[0].contextKey, 'new');
  assert.deepEqual(
    exportExperiencePatterns([{ contextKey: 'stable', updatedAt: 'volatile' }]),
    [{ contextKey: 'stable' }],
  );
});

test('experience description fails closed on mixed credit generations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-v33-credit-test-'));
  const file = path.join(directory, 'experience.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      creditVersion: 8,
      patterns: [
        { creditVersion: 7, contextKey: 'old', actionKey: 'old' },
        { creditVersion: 8, contextKey: 'new', actionKey: 'new' },
      ],
    }));
    const description = describeExperience(file);
    assert.deepEqual(description.patternCreditVersions, [7, 8]);
    assert.equal(description.declaredCreditVersion, 8);
    assert.equal(description.creditVersion, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Wilson lower bound prevents a small or marginal sample from claiming 68 percent', () => {
  const marginal = wilsonInterval(68, 100);
  const strong = wilsonInterval(180, 200);
  assert.ok(marginal.lower < 0.68);
  assert.ok(strong.lower > 0.68);

  const smallPerfect = evaluateHoldoutGate({
    pairs: 20,
    winRate: 1,
    severeLossRate: 0,
    pairedWinWilson95: wilsonInterval(20, 20),
    engineVersions: ['long-analytic-v33'],
    runtimeFingerprints: [HASH_A],
    experienceFingerprints: [HASH_B],
  }, { creditVersion: 8, experienceEngineVersion: 'long-analytic-v33' });
  assert.equal(smallPerfect.checks.sampleSufficient, false);
  assert.equal(smallPerfect.passed, false);
});

test('split summary reports ordinary, Mars, and Koks match points', () => {
  const seed = 101;
  const payload = pairedPayload(seed, { games: 6, wins: 3, severeLosses: 2 });
  payload.results[0].resultType = 'normal';
  payload.results[1].resultType = 'mars';
  payload.results[2].resultType = 'koks';
  payload.results[3].resultType = 'normal';
  payload.results[4].resultType = 'mars';
  payload.results[5].resultType = 'koks';
  const summary = summarizeSplit([{ seed, payload }], [seed], 6, false);

  assert.deepEqual(resultMatchPoints({ botWon: true, resultType: 'koks' }), {
    bot: 3, control: 0, net: 3,
  });
  assert.equal(summary.wins, 3);
  assert.equal(summary.winRate, 0.5);
  assert.equal(summary.winPercent, 50);
  assert.equal(summary.severeLosses, 2);
  assert.ok(Math.abs(summary.severeLossPercent - 100 / 3) < 1e-12);
  assert.equal(summary.matchPoints.bot, 6);
  assert.equal(summary.matchPoints.control, 6);
  assert.equal(summary.matchPoints.net, 0);
  assert.deepEqual(summary.resultBreakdown.normal, {
    multiplier: 1,
    games: 2,
    botWins: 1,
    controlWins: 1,
    botPoints: 1,
    controlPoints: 1,
    netPoints: 0,
  });
  assert.equal(summary.resultBreakdown.mars.multiplier, 2);
  assert.equal(summary.resultBreakdown.koks.multiplier, 3);
  assert.deepEqual(summary.pairOutcomes, { sweeps: 1, splits: 1, losses: 1 });
});

test('published experience identity is checked byte-for-byte', () => {
  const description = {
    fingerprint: HASH_A,
    patternCount: 12,
    creditVersion: 8,
    engineVersion: 'long-analytic-v33',
    storageKey: 'narduh-long-bot-experience-v8',
  };
  assert.doesNotThrow(() => assertExperienceIdentity(description, { ...description }));
  assert.throws(() => assertExperienceIdentity(description, {
    ...description,
    fingerprint: HASH_B,
  }), /fingerprint mismatch/);
});

test('holdout gate rejects wrong engine generation and experience credit', () => {
  const summary = {
    pairs: DEFAULT_MIN_HOLDOUT_PAIRS,
    winRate: 0.9,
    severeLossRate: 0,
    pairedWinWilson95: wilsonInterval(180, 200),
    engineVersions: ['long-analytic-v32'],
    runtimeFingerprints: [HASH_A],
    experienceFingerprints: [HASH_B],
  };
  const gate = evaluateHoldoutGate(summary, {
    creditVersion: 7,
    experienceEngineVersion: 'long-analytic-v32',
  });
  assert.equal(gate.checks.engineVersion, false);
  assert.equal(gate.checks.creditVersion, false);
  assert.equal(gate.passed, false);

  const eligible = evaluateHoldoutGate({
    ...summary,
    engineVersions: ['long-analytic-v33'],
  }, { creditVersion: 8, experienceEngineVersion: 'long-analytic-v33' });
  assert.equal(eligible.passed, true);
});

test('pipeline never evaluates holdout after validation fails', async () => {
  const calls = [];
  const options = {
    initialExperience: '',
    seedSplits: { train: [11], validation: [22], holdout: [33] },
    gamesPerSeed: 2,
    jobs: 1,
    criteria: {
      targetWinRate: 0.68,
      maxSevereLossRate: 0.1,
      minHoldoutPairs: DEFAULT_MIN_HOLDOUT_PAIRS,
      expectedEngineVersion: 'long-analytic-v33',
      expectedCreditVersion: 8,
    },
  };
  const runners = {
    async train(seed) {
      calls.push(`train:${seed}`);
      return {
        record: {
          seed,
          payload: pairedPayload(seed, {
            learn: true,
            experienceFingerprint: EMPTY_EXPERIENCE_FINGERPRINT,
          }),
        },
        experience: 'trained-token',
      };
    },
    async evaluate(seed, experience, split) {
      calls.push(`${split}:${seed}:${experience}`);
      if (split === 'holdout') throw new Error('holdout must remain sealed');
      return { seed, payload: pairedPayload(seed, { wins: 0 }) };
    },
    async describeExperience() {
      return {
        engineVersion: 'long-analytic-v33',
        creditVersion: 8,
        fingerprint: HASH_B,
        patternCount: 10,
      };
    },
  };
  const outcome = await runPipeline(options, runners);
  assert.deepEqual(calls, ['train:11', 'validation:22:trained-token']);
  assert.equal(outcome.report.validation.qualified, false);
  assert.equal(outcome.report.holdout, null);
  assert.equal(outcome.report.gate.passed, false);
  assert.equal(outcome.report.gate.reason, 'validation-not-qualified');
});

test('pipeline may inspect a qualified holdout but cannot certify its tiny sample', async () => {
  const calls = [];
  const options = {
    initialExperience: '',
    seedSplits: { train: [51], validation: [52], holdout: [53] },
    gamesPerSeed: 2,
    jobs: 1,
    criteria: {
      targetWinRate: 0.68,
      maxSevereLossRate: 0.1,
      minHoldoutPairs: DEFAULT_MIN_HOLDOUT_PAIRS,
      expectedEngineVersion: 'long-analytic-v33',
      expectedCreditVersion: 8,
    },
  };
  const runners = {
    async train(seed) {
      return {
        record: {
          seed,
          payload: pairedPayload(seed, {
            learn: true,
            experienceFingerprint: EMPTY_EXPERIENCE_FINGERPRINT,
          }),
        },
        experience: 'trained-token',
      };
    },
    async evaluate(seed, experience, split) {
      calls.push(split);
      return { seed, payload: pairedPayload(seed) };
    },
    async describeExperience() {
      return {
        engineVersion: 'long-analytic-v33',
        creditVersion: 8,
        fingerprint: HASH_B,
        patternCount: 10,
      };
    },
  };
  const outcome = await runPipeline(options, runners);
  assert.deepEqual(calls, ['validation', 'holdout']);
  assert.equal(outcome.report.validation.qualified, true);
  assert.equal(outcome.report.holdout.games, 2);
  assert.equal(outcome.report.gate.checks.sampleSufficient, false);
  assert.equal(outcome.report.gate.passed, false);
  assert.deepEqual(outcome.report.trainingChain, [{
    seed: 51,
    inputExperienceFingerprint: EMPTY_EXPERIENCE_FINGERPRINT,
    outputExperienceFingerprint: HASH_B,
    outputPatternCount: 10,
  }]);
});

test('pipeline rejects a training child that ignored its input experience', async () => {
  const options = {
    initialExperience: '',
    seedSplits: { train: [71], validation: [72], holdout: [73] },
    gamesPerSeed: 2,
    jobs: 1,
    criteria: {
      targetWinRate: 0.68,
      maxSevereLossRate: 0.1,
      minHoldoutPairs: DEFAULT_MIN_HOLDOUT_PAIRS,
      expectedEngineVersion: 'long-analytic-v33',
      expectedCreditVersion: 8,
    },
  };
  await assert.rejects(() => runPipeline(options, {
    async train(seed) {
      return {
        record: { seed, payload: pairedPayload(seed, { learn: true }) },
        experience: 'ignored-input',
      };
    },
    async evaluate() {
      throw new Error('evaluation must not run');
    },
    async describeExperience() {
      return {
        engineVersion: 'long-analytic-v33',
        creditVersion: 8,
        fingerprint: HASH_B,
        patternCount: 10,
      };
    },
  }), /did not load the preceding experience snapshot/);
});

test('report rejects holdout consumption when validation did not qualify', () => {
  const seedSplits = { train: [41], validation: [42], holdout: [43] };
  assert.throws(() => buildReport({
    seedSplits,
    gamesPerSeed: 2,
    trainRecords: [{ seed: 41, payload: pairedPayload(41, { learn: true }) }],
    validationRecords: [{ seed: 42, payload: pairedPayload(42, { wins: 0 }) }],
    holdoutRecords: [{ seed: 43, payload: pairedPayload(43) }],
    trainedExperience: { engineVersion: 'long-analytic-v33', creditVersion: 8 },
  }), /Holdout results must not be consumed/);
});

test('report rejects runtime drift between train and validation', () => {
  const seedSplits = { train: [61], validation: [62], holdout: [63] };
  assert.throws(() => buildReport({
    seedSplits,
    gamesPerSeed: 2,
    trainRecords: [{ seed: 61, payload: pairedPayload(61, { learn: true }) }],
    validationRecords: [{
      seed: 62,
      payload: pairedPayload(62, { runtimeFingerprint: `sha256:${'d'.repeat(64)}` }),
    }],
    holdoutRecords: null,
    trainedExperience: {
      engineVersion: 'long-analytic-v33',
      creditVersion: 8,
      fingerprint: HASH_B,
    },
  }), /Splits do not share one runtimeFingerprints/);
});

test('CLI dry run is reproducible and cannot lower the minimum holdout sample', () => {
  const options = parseOptions(['--dry-run']);
  const report = dryRunReport(options);
  assert.equal(report.projected.holdoutPairs, DEFAULT_MIN_HOLDOUT_PAIRS);
  assert.equal(report.projected.sampleSufficient, true);
  assert.equal(report.criteria.targetWinRate, 0.68);
  assert.notEqual(
    suiteFingerprint(options.seedSplits, 20),
    suiteFingerprint(options.seedSplits, 22),
  );
  assert.throws(() => parseOptions([
    '--dry-run',
    '--min-holdout-pairs', String(DEFAULT_MIN_HOLDOUT_PAIRS - 1),
  ]), /cannot be lower/);
  assert.throws(() => parseOptions([
    '--dry-run',
    '--train-seeds', '1,2',
    '--validation-seeds', '3,4',
    '--holdout-seeds', '5,1',
  ]), /leaks across train and holdout/);
  assert.throws(() => parseOptions([
    '--output', '/tmp/same.json',
    '--trained-experience-output', '/tmp/same.json',
  ]), /must be different files/);
  assert.throws(() => parseOptions([
    '--dry-run',
    '--expected-engine-version', 'long-analytic-v32',
  ]), /Unknown option/);
});
