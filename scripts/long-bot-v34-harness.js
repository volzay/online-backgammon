const { createHash } = require('node:crypto');
const {
  diceStreamSeeds,
  validateDerivedStreamSeeds,
} = require('./simulate-long-bot-regression');

const UINT32_MAX = 0xffffffff;
const WILSON_Z_95 = 1.959963984540054;
const DEFAULT_TARGET_WIN_RATE = 0.68;
const DEFAULT_MAX_SEVERE_LOSS_RATE = 0.1;
const DEFAULT_MIN_HOLDOUT_PAIRS = 200;
const DEFAULT_EXPECTED_ENGINE_VERSION = 'long-analytic-v34';
const DEFAULT_EXPECTED_CREDIT_VERSION = 8;
const SUITE_NAMESPACE = 'nardu/long-bot-v34/offline-suite/v1';

const DEFAULT_SPLIT_SIZES = Object.freeze({
  train: 6,
  validation: 4,
  holdout: 20,
});

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function suiteFingerprint(seedSplits, gamesPerSeed) {
  return sha256Json({
    namespace: SUITE_NAMESPACE,
    seedSplits,
    gamesPerSeed,
  });
}

function deriveSeed(split, index, used = new Set()) {
  assertCondition(['train', 'validation', 'holdout'].includes(split), `Unknown split: ${split}`);
  assertCondition(Number.isSafeInteger(index) && index >= 0, 'Seed index must be non-negative');
  for (let counter = 0; counter <= UINT32_MAX; counter += 1) {
    const digest = createHash('sha256')
      .update(SUITE_NAMESPACE)
      .update('\0')
      .update(split)
      .update('\0')
      .update(String(index))
      .update('\0')
      .update(String(counter))
      .digest();
    const seed = digest.readUInt32BE(0);
    if (seed !== 0 && !used.has(seed)) return seed;
  }
  throw new Error(`Could not derive a unique seed for ${split}[${index}]`);
}

function deriveSeedSplits(sizes = DEFAULT_SPLIT_SIZES) {
  const used = new Set();
  const splits = {};
  for (const split of ['train', 'validation', 'holdout']) {
    const size = Number(sizes[split]);
    assertCondition(Number.isSafeInteger(size) && size > 0, `${split} split size must be positive`);
    splits[split] = Object.freeze(Array.from({ length: size }, (_, index) => {
      const seed = deriveSeed(split, index, used);
      used.add(seed);
      return seed;
    }));
  }
  return Object.freeze(splits);
}

const DEFAULT_SEED_SPLITS = deriveSeedSplits();

function validateSeedSplits(splits) {
  assertCondition(splits && typeof splits === 'object', 'Seed splits are required');
  const owner = new Map();
  const normalized = {};
  for (const split of ['train', 'validation', 'holdout']) {
    const seeds = splits[split];
    assertCondition(Array.isArray(seeds) && seeds.length > 0, `${split} seeds are required`);
    normalized[split] = seeds.map(seed => {
      assertCondition(
        Number.isSafeInteger(seed) && seed > 0 && seed <= UINT32_MAX,
        `${split} seed ${seed} must be a positive 32-bit integer`,
      );
      assertCondition(!owner.has(seed), (
        `Seed ${seed} leaks across ${owner.get(seed)} and ${split} splits`
      ));
      owner.set(seed, split);
      return seed;
    });
  }
  return normalized;
}

function validateSuiteDiceStreams(seedSplits, gamesPerSeed) {
  const splits = validateSeedSplits(seedSplits);
  assertCondition(
    Number.isSafeInteger(gamesPerSeed) && gamesPerSeed >= 2 && gamesPerSeed % 2 === 0,
    'gamesPerSeed must be an even integer of at least 2',
  );
  const derivedDiceStreamCount = validateDerivedStreamSeeds(
    ['train', 'validation', 'holdout'].flatMap(split => splits[split]),
    gamesPerSeed / 2,
  );
  return { splits, derivedDiceStreamCount };
}

function wilsonInterval(successes, trials, z = WILSON_Z_95) {
  assertCondition(Number.isFinite(successes), 'Wilson successes must be finite');
  assertCondition(Number.isSafeInteger(trials) && trials >= 0, 'Wilson trials must be non-negative');
  assertCondition(successes >= 0 && successes <= trials, 'Wilson successes must be within trials');
  assertCondition(Number.isFinite(z) && z > 0, 'Wilson z must be positive');
  if (trials === 0) return { lower: 0, upper: 1, center: null, trials: 0, successes: 0 };
  const proportion = successes / trials;
  const zSquared = z ** 2;
  const denominator = 1 + zSquared / trials;
  const center = (proportion + zSquared / (2 * trials)) / denominator;
  const halfWidth = z * Math.sqrt(
    proportion * (1 - proportion) / trials + zSquared / (4 * trials ** 2),
  ) / denominator;
  return {
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    center,
    trials,
    successes,
  };
}

function resultMultiplier(resultType) {
  if (resultType === 'koks') return 3;
  if (resultType === 'mars') return 2;
  if (resultType === 'normal') return 1;
  throw new Error(`Unsupported result type: ${resultType}`);
}

function resultMatchPoints(result) {
  assertCondition(result && typeof result.botWon === 'boolean', 'Result has no botWon flag');
  const points = resultMultiplier(result.resultType);
  return result.botWon
    ? { bot: points, control: 0, net: points }
    : { bot: 0, control: points, net: -points };
}

function validatePairedPayload(seed, payload, gamesPerSeed, expectedLearning) {
  assertCondition(payload && typeof payload === 'object', `Seed ${seed} has no payload`);
  assertCondition(Array.isArray(payload.results), `Seed ${seed} has no results`);
  assertCondition(payload.results.length === gamesPerSeed, `Seed ${seed} game count mismatch`);
  assertCondition(gamesPerSeed > 0 && gamesPerSeed % 2 === 0, 'gamesPerSeed must be even');
  if (typeof expectedLearning === 'boolean') {
    assertCondition(
      payload.summary?.options?.learn === expectedLearning,
      `Seed ${seed} learning mode does not match the ${expectedLearning ? 'train' : 'evaluation'} split`,
    );
  }

  const pairs = new Map();
  for (const result of payload.results) {
    assertCondition(Number.isSafeInteger(result.pair), `Seed ${seed} has invalid pair`);
    assertCondition(result.leg === 1 || result.leg === 2, `Seed ${seed} has invalid leg`);
    assertCondition(
      result.botColor === (result.leg === 1 ? 'white' : 'dark'),
      `Seed ${seed} pair ${result.pair} does not swap bot color`,
    );
    assertCondition(
      result.controlColor === (result.botColor === 'white' ? 'dark' : 'white'),
      `Seed ${seed} pair ${result.pair} has invalid control color`,
    );
    assertCondition(
      result.botWon === (result.winner === result.botColor),
      `Seed ${seed} pair ${result.pair} has inconsistent winner`,
    );
    assertCondition(
      canonicalJson(result.streamSeeds) === canonicalJson(diceStreamSeeds(seed, result.pair - 1)),
      `Seed ${seed} pair ${result.pair} has unexpected dice stream seeds`,
    );
    resultMultiplier(result.resultType);
    const pair = pairs.get(result.pair) || [];
    pair.push(result);
    pairs.set(result.pair, pair);
  }

  assertCondition(pairs.size === gamesPerSeed / 2, `Seed ${seed} pair count mismatch`);
  for (const [pairNumber, pair] of pairs) {
    assertCondition(pair.length === 2, `Seed ${seed} pair ${pairNumber} is incomplete`);
    assertCondition(new Set(pair.map(result => result.leg)).size === 2,
      `Seed ${seed} pair ${pairNumber} repeats a leg`);
    assertCondition(new Set(pair.map(result => result.botColor)).size === 2,
      `Seed ${seed} pair ${pairNumber} does not cross colors`);
    assertCondition(
      canonicalJson(pair[0].streamSeeds) === canonicalJson(pair[1].streamSeeds),
      `Seed ${seed} pair ${pairNumber} does not reuse the same dice streams`,
    );
  }
  return pairs;
}

function summarizeSplit(records, seeds, gamesPerSeed, expectedLearning) {
  assertCondition(Array.isArray(records), 'Split records must be an array');
  assertCondition(records.length === seeds.length, 'Split seed result count mismatch');
  const expectedSeeds = new Set(seeds);
  const seenSeeds = new Set();
  const results = [];
  const pairScores = [];
  const engineVersions = new Set();
  const runtimeFingerprints = new Set();
  const simulatorHarnessFingerprints = new Set();
  const experienceFingerprints = new Set();
  const botProfiles = new Set();
  const controlProfiles = new Set();

  for (const record of records) {
    assertCondition(expectedSeeds.has(record.seed), `Unexpected split seed ${record.seed}`);
    assertCondition(!seenSeeds.has(record.seed), `Duplicate split seed result ${record.seed}`);
    seenSeeds.add(record.seed);
    const pairs = validatePairedPayload(record.seed, record.payload, gamesPerSeed, expectedLearning);
    results.push(...record.payload.results);
    engineVersions.add(String(record.payload.summary?.engineVersion || ''));
    runtimeFingerprints.add(String(record.payload.summary?.runtimeFingerprint || ''));
    simulatorHarnessFingerprints.add(String(
      record.payload.summary?.simulatorHarnessFingerprint || '',
    ));
    experienceFingerprints.add(String(record.payload.summary?.experienceFingerprint || ''));
    botProfiles.add(String(record.payload.summary?.options?.botProfile || ''));
    controlProfiles.add(String(record.payload.summary?.options?.controlProfile || ''));
    for (const pair of pairs.values()) {
      pairScores.push(pair.filter(result => result.botWon).length / 2);
    }
  }
  assertCondition(seenSeeds.size === expectedSeeds.size, 'Split is missing seed results');

  const wins = results.filter(result => result.botWon).length;
  const severeLosses = results.filter(result => (
    !result.botWon && result.resultType !== 'normal'
  )).length;
  const points = results.reduce((total, result) => {
    const value = resultMatchPoints(result);
    total.bot += value.bot;
    total.control += value.control;
    total.net += value.net;
    return total;
  }, { bot: 0, control: 0, net: 0 });
  const resultBreakdown = Object.fromEntries(['normal', 'mars', 'koks'].map(resultType => {
    const multiplier = resultMultiplier(resultType);
    const matching = results.filter(result => result.resultType === resultType);
    const botWins = matching.filter(result => result.botWon).length;
    const controlWins = matching.length - botWins;
    return [resultType, {
      multiplier,
      games: matching.length,
      botWins,
      controlWins,
      botPoints: botWins * multiplier,
      controlPoints: controlWins * multiplier,
      netPoints: (botWins - controlWins) * multiplier,
    }];
  }));
  const games = results.length;
  const pairs = pairScores.length;
  const pairedSuccesses = pairScores.reduce((sum, score) => sum + score, 0);
  const winRate = games ? wins / games : 0;
  const severeLossRate = games ? severeLosses / games : 0;
  const gameWinWilson95 = wilsonInterval(wins, games);
  const pairedWinWilson95 = wilsonInterval(pairedSuccesses, pairs);
  return {
    seeds: [...seeds],
    seedCount: seeds.length,
    games,
    pairs,
    wins,
    losses: games - wins,
    winRate,
    winPercent: winRate * 100,
    severeLosses,
    severeLossRate,
    severeLossPercent: severeLossRate * 100,
    matchPoints: {
      ...points,
      botShare: points.bot + points.control ? points.bot / (points.bot + points.control) : 0,
      netPerGame: games ? points.net / games : 0,
    },
    resultBreakdown,
    gameWinWilson95: {
      ...gameWinWilson95,
      lowerPercent: gameWinWilson95.lower * 100,
      upperPercent: gameWinWilson95.upper * 100,
    },
    // A pair is the independent sampling unit. Split pairs contribute 0.5 success.
    pairedWinWilson95: {
      ...pairedWinWilson95,
      lowerPercent: pairedWinWilson95.lower * 100,
      upperPercent: pairedWinWilson95.upper * 100,
    },
    severeLossWilson95: wilsonInterval(severeLosses, games),
    pairOutcomes: {
      sweeps: pairScores.filter(score => score === 1).length,
      splits: pairScores.filter(score => score === 0.5).length,
      losses: pairScores.filter(score => score === 0).length,
    },
    engineVersions: [...engineVersions].filter(Boolean),
    runtimeFingerprints: [...runtimeFingerprints].filter(Boolean),
    simulatorHarnessFingerprints: [...simulatorHarnessFingerprints].filter(Boolean),
    experienceFingerprints: [...experienceFingerprints].filter(Boolean),
    botProfiles: [...botProfiles].filter(Boolean),
    controlProfiles: [...controlProfiles].filter(Boolean),
  };
}

function validationPassed(summary, criteria = {}, trainedExperience = null) {
  const targetWinRate = Number(criteria.targetWinRate ?? DEFAULT_TARGET_WIN_RATE);
  const maxSevereLossRate = Number(
    criteria.maxSevereLossRate ?? DEFAULT_MAX_SEVERE_LOSS_RATE,
  );
  const expectedEngineVersion = String(
    criteria.expectedEngineVersion || DEFAULT_EXPECTED_ENGINE_VERSION,
  );
  const expectedCreditVersion = Number(
    criteria.expectedCreditVersion ?? DEFAULT_EXPECTED_CREDIT_VERSION,
  );
  return summary.winRate >= targetWinRate
    && summary.severeLossRate <= maxSevereLossRate
    && summary.engineVersions.length === 1
    && summary.engineVersions[0] === expectedEngineVersion
    && String(trainedExperience?.engineVersion || '') === expectedEngineVersion
    && Number(trainedExperience?.creditVersion) === expectedCreditVersion;
}

function evaluateHoldoutGate(summary, options = {}) {
  const targetWinRate = Number(options.targetWinRate ?? DEFAULT_TARGET_WIN_RATE);
  const maxSevereLossRate = Number(
    options.maxSevereLossRate ?? DEFAULT_MAX_SEVERE_LOSS_RATE,
  );
  const minHoldoutPairs = Number(options.minHoldoutPairs ?? DEFAULT_MIN_HOLDOUT_PAIRS);
  const expectedEngineVersion = String(
    options.expectedEngineVersion || DEFAULT_EXPECTED_ENGINE_VERSION,
  );
  const expectedCreditVersion = Number(
    options.expectedCreditVersion ?? DEFAULT_EXPECTED_CREDIT_VERSION,
  );
  const creditVersion = options.creditVersion === null
    || options.creditVersion === undefined
    || options.creditVersion === ''
    ? Number.NaN
    : Number(options.creditVersion);
  const experienceEngineVersion = String(options.experienceEngineVersion || '');
  assertCondition(targetWinRate > 0 && targetWinRate < 1, 'Target win rate must be between 0 and 1');
  assertCondition(maxSevereLossRate >= 0 && maxSevereLossRate < 1,
    'Maximum severe-loss rate must be from 0 to less than 1');
  assertCondition(Number.isSafeInteger(minHoldoutPairs) && minHoldoutPairs >= DEFAULT_MIN_HOLDOUT_PAIRS,
    `Minimum holdout pairs cannot be lower than ${DEFAULT_MIN_HOLDOUT_PAIRS}`);

  const checks = {
    sampleSufficient: summary.pairs >= minHoldoutPairs,
    pointWinRate: summary.winRate >= targetWinRate,
    pairedWilsonLower: summary.pairedWinWilson95.lower >= targetWinRate,
    severeLossRate: summary.severeLossRate <= maxSevereLossRate,
    engineVersion: summary.engineVersions.length === 1
      && summary.engineVersions[0] === expectedEngineVersion,
    experienceEngineVersion: experienceEngineVersion === expectedEngineVersion,
    creditVersion: creditVersion === expectedCreditVersion,
    immutableRuntime: summary.runtimeFingerprints.length === 1,
    immutableExperience: summary.experienceFingerprints.length === 1,
  };
  return {
    targetWinRate,
    maxSevereLossRate,
    minHoldoutPairs,
    expectedEngineVersion,
    expectedCreditVersion,
    observedCreditVersion: Number.isFinite(creditVersion) ? creditVersion : null,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

function buildReport({
  seedSplits,
  gamesPerSeed,
  trainRecords,
  validationRecords,
  holdoutRecords = null,
  trainedExperience,
  criteria = {},
}) {
  const suiteValidation = validateSuiteDiceStreams(seedSplits, gamesPerSeed);
  const { splits } = suiteValidation;
  const train = summarizeSplit(trainRecords, splits.train, gamesPerSeed, true);
  const validation = summarizeSplit(validationRecords, splits.validation, gamesPerSeed, false);
  const validationQualified = validationPassed(validation, criteria, trainedExperience);
  assertCondition(
    validationQualified || holdoutRecords === null,
    'Holdout results must not be consumed after validation failed',
  );
  const holdout = holdoutRecords === null
    ? null
    : summarizeSplit(holdoutRecords, splits.holdout, gamesPerSeed, false);
  const completedSplits = [train, validation, ...(holdout ? [holdout] : [])];
  for (const field of [
    'engineVersions',
    'runtimeFingerprints',
    'simulatorHarnessFingerprints',
    'botProfiles',
    'controlProfiles',
  ]) {
    const identities = new Set(completedSplits.flatMap(summary => summary[field]));
    assertCondition(identities.size === 1, `Splits do not share one ${field}`);
  }
  assertCondition(validation.experienceFingerprints.length === 1,
    'Validation did not use one frozen experience snapshot');
  assertCondition(
    validation.experienceFingerprints[0] === String(trainedExperience?.fingerprint || ''),
    'Validation did not use the trained experience snapshot',
  );
  if (holdout) {
    assertCondition(holdout.experienceFingerprints.length === 1,
      'Holdout did not use one frozen experience snapshot');
    assertCondition(
      validation.experienceFingerprints[0] === holdout.experienceFingerprints[0],
      'Validation and holdout used different experience snapshots',
    );
  }
  const gate = holdout
    ? evaluateHoldoutGate(holdout, {
      ...criteria,
      creditVersion: trainedExperience?.creditVersion,
      experienceEngineVersion: trainedExperience?.engineVersion,
    })
    : {
      passed: false,
      reason: 'validation-not-qualified',
    };
  return {
    schemaVersion: 1,
    harness: 'long-bot-v34-offline-training-certification',
    methodology: {
      splitIsolation: 'train, validation, and holdout seeds are disjoint and checked before play',
      pairing: 'each pair reuses physical white/dark streams while candidate and control swap colors',
      scoring: 'ordinary=1, mars=2, koks=3 match points',
      confidence: 'two-sided Wilson 95% interval; paired score is the independent unit',
      holdoutPolicy: 'holdout is run only after validation qualifies and never updates experience',
      dicePolicy: 'deterministic seeded fair streams; no result-dependent dice changes',
      resultScope: 'the reported rate applies only to the configured frozen runtime/control profile',
    },
    suite: {
      namespace: SUITE_NAMESPACE,
      fingerprint: suiteFingerprint(splits, gamesPerSeed),
      splits,
      gamesPerSeed,
      derivedDiceStreamCount: suiteValidation.derivedDiceStreamCount,
    },
    trainedExperience: trainedExperience || null,
    criteria: {
      targetWinRate: Number(criteria.targetWinRate ?? DEFAULT_TARGET_WIN_RATE),
      maxSevereLossRate: Number(
        criteria.maxSevereLossRate ?? DEFAULT_MAX_SEVERE_LOSS_RATE,
      ),
      minHoldoutPairs: Number(
        criteria.minHoldoutPairs ?? DEFAULT_MIN_HOLDOUT_PAIRS,
      ),
      expectedEngineVersion: String(
        criteria.expectedEngineVersion || DEFAULT_EXPECTED_ENGINE_VERSION,
      ),
      expectedCreditVersion: Number(
        criteria.expectedCreditVersion ?? DEFAULT_EXPECTED_CREDIT_VERSION,
      ),
    },
    train,
    validation: {
      ...validation,
      qualified: validationQualified,
    },
    holdout,
    gate,
  };
}

module.exports = {
  DEFAULT_EXPECTED_CREDIT_VERSION,
  DEFAULT_EXPECTED_ENGINE_VERSION,
  DEFAULT_MAX_SEVERE_LOSS_RATE,
  DEFAULT_MIN_HOLDOUT_PAIRS,
  DEFAULT_SEED_SPLITS,
  DEFAULT_SPLIT_SIZES,
  DEFAULT_TARGET_WIN_RATE,
  SUITE_NAMESPACE,
  WILSON_Z_95,
  buildReport,
  deriveSeedSplits,
  evaluateHoldoutGate,
  resultMatchPoints,
  sha256Json,
  summarizeSplit,
  suiteFingerprint,
  validatePairedPayload,
  validateSeedSplits,
  validateSuiteDiceStreams,
  validationPassed,
  wilsonInterval,
};
