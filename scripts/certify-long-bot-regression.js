const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  diceStreamSeeds,
  fileFingerprint,
  loadRuntime,
  parseCliTokens,
  readRuntimeSnapshot,
  validateDerivedStreamSeeds,
} = require('./simulate-long-bot-regression');

const SIMULATOR = path.join(__dirname, 'simulate-long-bot-regression.js');
const DEFAULT_SEEDS = [430419993, 2654435761, 1013904223, 2246822519, 3266489917];
const UINT32_MAX = 0xffffffff;
const MAX_TIMEOUT_MS = 0x7fffffff;
const DEFAULT_SEED_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_JOBS = 1;
const MAX_JOBS = 8;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;
const CHILD_KILL_GRACE_MS = 1000;
const FAMILY_ERROR_RATE = 0.05;
const PER_BOUND_ERROR_RATE = FAMILY_ERROR_RATE / 2;
const BONFERRONI_ONE_SIDED_Z = 1.959963984540054;
const SUPPORTED_PROFILES = new Set(['v19', 'v24']);
const VALUE_OPTIONS = new Set([
  'seeds', 'games-per-seed', 'seed-timeout-ms', 'jobs', 'min-win-rate',
  'max-severe-loss-rate', 'output', 'bot-nodes', 'control-nodes',
  'bot-candidates', 'control-candidates', 'max-plies', 'bot-profile',
  'control-profile', 'experience',
  'checkpoint-dir',
]);
const FLAG_OPTIONS = new Set(['require-confidence', 'include-results', 'trace', 'learn']);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SIMULATOR_OPTION_DEFAULTS = Object.freeze({
  botNodes: 480,
  controlNodes: 64,
  botCandidates: 64,
  controlCandidates: 24,
  maxPlies: 320,
  botProfile: 'v24',
  controlProfile: 'v19',
  experience: '',
  trace: false,
});

function positiveIntegerOption(parsed, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!parsed.values.has(name)) return fallback;
  const raw = parsed.values.get(name);
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`--${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`--${name} must be a positive integer not greater than ${maximum}`);
  }
  return value;
}

function ratioOption(parsed, name, fallback) {
  if (!parsed.values.has(name)) return fallback;
  const value = Number(parsed.values.get(name));
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--${name} must be a number from 0 to 1`);
  }
  return value;
}

function stringOption(parsed, name, fallback = '') {
  if (!parsed.values.has(name)) return fallback;
  const value = parsed.values.get(name).trim();
  if (!value) throw new Error(`--${name} must not be empty`);
  return value;
}

function profileOption(parsed, name, fallback) {
  const value = stringOption(parsed, name, fallback).toLowerCase();
  if (!SUPPORTED_PROFILES.has(value)) {
    throw new Error(`--${name} must be one of: ${[...SUPPORTED_PROFILES].join(', ')}`);
  }
  return value;
}

function parseSeeds(value = '') {
  if (!value) return [...DEFAULT_SEEDS];
  const rawSeeds = value.split(',').map(seed => seed.trim());
  if (rawSeeds.length < 3) throw new Error('--seeds must contain at least three independent seeds');
  if (rawSeeds.some(seed => !/^[1-9]\d*$/.test(seed))) {
    throw new Error('--seeds must contain positive decimal 32-bit integers');
  }
  const seeds = rawSeeds.map(Number);
  if (seeds.some(seed => !Number.isSafeInteger(seed) || seed > UINT32_MAX)) {
    throw new Error('--seeds must contain positive decimal 32-bit integers');
  }
  if (new Set(seeds).size !== seeds.length) throw new Error('--seeds must be unique');
  return seeds;
}

function resolveJobs(parsed, seedCount) {
  if (!Number.isSafeInteger(seedCount) || seedCount < 1) {
    throw new Error('seed count must be a positive integer');
  }
  const requested = positiveIntegerOption(parsed, 'jobs', DEFAULT_JOBS, MAX_JOBS);
  return {
    requested,
    effective: Math.min(requested, seedCount),
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function boundedMeanDiagnostics(values) {
  if (!values.length) throw new Error('At least one paired observation is required');
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error('Paired observations must be finite numbers from 0 to 1');
  }
  const average = mean(values);
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
    : 0;
  const standardError = Math.sqrt(variance / values.length);
  const hoeffdingMargin = Math.sqrt(Math.log(1 / PER_BOUND_ERROR_RATE) / (2 * values.length));
  return {
    observations: values.length,
    mean: average,
    sampleVariance: variance,
    standardError,
    perBoundErrorRate: PER_BOUND_ERROR_RATE,
    normalLower95: Math.max(0, average - BONFERRONI_ONE_SIDED_Z * standardError),
    normalUpper95: Math.min(1, average + BONFERRONI_ONE_SIDED_Z * standardError),
    hoeffdingLower95: Math.max(0, average - hoeffdingMargin),
    hoeffdingUpper95: Math.min(1, average + hoeffdingMargin),
  };
}

function minimumPairsForConfidence(criteria) {
  const tightestHeadroom = Math.min(1 - criteria.minWinRate, criteria.maxSevereLossRate);
  if (!(tightestHeadroom > 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil(Math.log(1 / PER_BOUND_ERROR_RATE) / (2 * tightestHeadroom ** 2));
}

function validateConfidenceCapacity(pairCount, criteria) {
  const minimum = minimumPairsForConfidence(criteria);
  if (!Number.isFinite(minimum)) {
    throw new Error(
      '--require-confidence cannot certify a perfect boundary '
      + '(min win rate 1 or max severe-loss rate 0) with a finite Hoeffding sample',
    );
  }
  if (pairCount < minimum) {
    throw new Error(
      `--require-confidence needs at least ${minimum} independent pairs `
      + `(${minimum * 2} games) for these thresholds; configured ${pairCount} pairs`,
    );
  }
  return minimum;
}

function pairedScores(results) {
  const pairs = new Map();
  for (const result of results) {
    const pair = pairs.get(result.pair) || [];
    pair.push(result);
    pairs.set(result.pair, pair);
  }
  return [...pairs.values()].map(pair => {
    if (pair.length !== 2) throw new Error('Certification received an incomplete paired result');
    return {
      winRate: pair.filter(result => result.botWon).length / 2,
      severeLossRate: pair.filter(result => !result.botWon && result.resultType !== 'normal').length / 2,
    };
  });
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(`Invalid simulator payload: ${message}`);
}

function assertInteger(value, message) {
  assertCondition(Number.isSafeInteger(value) && value >= 0, message);
}

function assertClose(actual, expected, message) {
  assertCondition(
    Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-12,
    `${message} (expected ${expected}, received ${actual})`,
  );
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

function comparableOptions(options) {
  const comparable = { ...options };
  delete comparable.seed;
  delete comparable.output;
  return comparable;
}

function checkpointFilename(seed) {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > UINT32_MAX) {
    throw new Error('Checkpoint seed must be a positive 32-bit integer');
  }
  return `seed-${seed}.json`;
}

function checkpointPath(checkpointDirectory, seed) {
  if (typeof checkpointDirectory !== 'string' || !checkpointDirectory.trim()) {
    throw new Error('Checkpoint directory must not be empty');
  }
  return path.join(checkpointDirectory, checkpointFilename(seed));
}

function ensureCheckpointDirectory(checkpointDirectory) {
  fs.mkdirSync(checkpointDirectory, { recursive: true });
  const stat = fs.lstatSync(checkpointDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Checkpoint path is not a real directory: ${checkpointDirectory}`);
  }
}

function syncDirectory(directory) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function persistCheckpointAtomic(checkpointDirectory, seed, payload) {
  ensureCheckpointDirectory(checkpointDirectory);
  const destination = checkpointPath(checkpointDirectory, seed);
  if (fs.existsSync(destination)) {
    throw new Error(`Checkpoint already exists for seed ${seed}; refusing to overwrite it`);
  }
  const temporary = path.join(
    checkpointDirectory,
    `.${checkpointFilename(seed)}.${process.pid}.${process.hrtime.bigint()}.tmp`,
  );
  let descriptor = null;
  let installed = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    // A hard link publishes the complete, fsynced file atomically and cannot replace
    // a checkpoint that appeared concurrently.
    fs.linkSync(temporary, destination);
    installed = true;
    fs.unlinkSync(temporary);
    syncDirectory(checkpointDirectory);
    return destination;
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Checkpoint already exists for seed ${seed}; refusing to overwrite it`);
    }
    throw new Error(`Could not persist checkpoint for seed ${seed}: ${error.message}`);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    if (installed && !fs.existsSync(destination)) {
      throw new Error(`Checkpoint publication failed for seed ${seed}`);
    }
  }
}

function currentExecutionIdentity(requestedOptions, dependencies = {}) {
  const simulator = dependencies.simulator || SIMULATOR;
  const runtimeRoot = dependencies.runtimeRoot || path.join(__dirname, '..');
  const runtimeSnapshot = readRuntimeSnapshot(runtimeRoot);
  const experienceFile = requestedOptions.experience
    ? path.resolve(runtimeRoot, requestedOptions.experience)
    : '';
  const runtime = loadRuntime(experienceFile, runtimeSnapshot);
  return {
    engineVersion: runtime.engine.version,
    runtimeFingerprint: runtime.runtimeFingerprint,
    simulatorHarnessFingerprint: fileFingerprint(simulator),
    experienceFingerprint: runtime.experienceFingerprint,
  };
}

function assertExecutionIdentity(metadata, expectedIdentity, seed) {
  if (!expectedIdentity) return;
  for (const field of [
    'engineVersion', 'runtimeFingerprint', 'simulatorHarnessFingerprint', 'experienceFingerprint',
  ]) {
    assertCondition(
      metadata[field] === expectedIdentity[field],
      `seed ${seed} ${field} does not match the current certification runtime`,
    );
  }
}

function requestedSimulatorOptions(parsed, gamesPerSeed) {
  return {
    games: gamesPerSeed,
    botNodes: positiveIntegerOption(parsed, 'bot-nodes', SIMULATOR_OPTION_DEFAULTS.botNodes),
    controlNodes: positiveIntegerOption(
      parsed, 'control-nodes', SIMULATOR_OPTION_DEFAULTS.controlNodes,
    ),
    botCandidates: positiveIntegerOption(
      parsed, 'bot-candidates', SIMULATOR_OPTION_DEFAULTS.botCandidates,
    ),
    controlCandidates: positiveIntegerOption(
      parsed, 'control-candidates', SIMULATOR_OPTION_DEFAULTS.controlCandidates,
    ),
    maxPlies: positiveIntegerOption(parsed, 'max-plies', SIMULATOR_OPTION_DEFAULTS.maxPlies),
    minWinRate: 0,
    maxSevereLossRate: 1,
    botProfile: profileOption(parsed, 'bot-profile', SIMULATOR_OPTION_DEFAULTS.botProfile),
    controlProfile: profileOption(
      parsed, 'control-profile', SIMULATOR_OPTION_DEFAULTS.controlProfile,
    ),
    experience: stringOption(parsed, 'experience', SIMULATOR_OPTION_DEFAULTS.experience),
    trace: parsed.flags.has('trace'),
    learn: false,
  };
}

function validateSeedPayload(seedPayload, gamesPerSeed, requestedOptions) {
  const { seed, payload } = seedPayload || {};
  assertCondition(requestedOptions && typeof requestedOptions === 'object',
    'certifier has no requested simulator options');
  assertCondition(payload && typeof payload === 'object', `seed ${seed} has no payload object`);
  const { summary, results } = payload;
  assertCondition(summary && typeof summary === 'object', `seed ${seed} has no summary object`);
  assertCondition(Array.isArray(results), `seed ${seed} has no results array`);
  assertCondition(summary.games === gamesPerSeed, `seed ${seed} summary.games mismatch`);
  assertCondition(results.length === gamesPerSeed, `seed ${seed} results length mismatch`);
  assertCondition(typeof summary.engineVersion === 'string' && summary.engineVersion.length > 0,
    `seed ${seed} has no engine version`);
  for (const field of [
    'runtimeFingerprint', 'simulatorHarnessFingerprint', 'experienceFingerprint',
  ]) {
    assertCondition(SHA256_PATTERN.test(summary[field]), `seed ${seed} has invalid ${field}`);
  }
  assertCondition(summary.options && typeof summary.options === 'object',
    `seed ${seed} has no options object`);
  assertCondition(summary.options.games === gamesPerSeed, `seed ${seed} options.games mismatch`);
  assertCondition(summary.options.seed === seed, `seed ${seed} options.seed mismatch`);
  assertCondition(summary.options.learn === false, `seed ${seed} unexpectedly enabled learning`);
  assertCondition(summary.options.minWinRate === 0, `seed ${seed} child minWinRate was not neutral`);
  assertCondition(summary.options.maxSevereLossRate === 1,
    `seed ${seed} child maxSevereLossRate was not neutral`);
  assertCondition(SUPPORTED_PROFILES.has(summary.options.botProfile),
    `seed ${seed} has unsupported bot profile`);
  assertCondition(SUPPORTED_PROFILES.has(summary.options.controlProfile),
    `seed ${seed} has unsupported control profile`);
  const actualOptionsJson = canonicalJson(comparableOptions(summary.options));
  const requestedOptionsJson = canonicalJson(requestedOptions);
  assertCondition(
    actualOptionsJson === requestedOptionsJson,
    `seed ${seed} simulator options do not match the certifier request `
      + `(expected ${requestedOptionsJson}, received ${actualOptionsJson})`,
  );

  const pairCount = gamesPerSeed / 2;
  const pairs = new Map();
  for (const result of results) {
    assertInteger(result.game, `seed ${seed} result has invalid game number`);
    assertInteger(result.pair, `seed ${seed} result has invalid pair number`);
    assertInteger(result.leg, `seed ${seed} result has invalid leg number`);
    assertCondition(result.pair >= 1 && result.pair <= pairCount,
      `seed ${seed} result has out-of-range pair ${result.pair}`);
    assertCondition(result.leg === 1 || result.leg === 2,
      `seed ${seed} pair ${result.pair} has invalid leg ${result.leg}`);
    assertCondition(result.game === (result.pair - 1) * 2 + result.leg,
      `seed ${seed} pair ${result.pair} leg ${result.leg} has wrong game number`);
    assertCondition(result.botColor === (result.leg === 1 ? 'white' : 'dark'),
      `seed ${seed} pair ${result.pair} leg ${result.leg} has wrong bot color`);
    assertCondition(result.controlColor === (result.botColor === 'white' ? 'dark' : 'white'),
      `seed ${seed} pair ${result.pair} leg ${result.leg} has wrong control color`);
    assertCondition(result.winner === 'white' || result.winner === 'dark',
      `seed ${seed} pair ${result.pair} leg ${result.leg} has invalid winner`);
    assertCondition(typeof result.botWon === 'boolean',
      `seed ${seed} pair ${result.pair} leg ${result.leg} has invalid botWon`);
    assertCondition(result.botWon === (result.winner === result.botColor),
      `seed ${seed} pair ${result.pair} leg ${result.leg} botWon contradicts winner`);
    assertCondition(['normal', 'mars', 'koks'].includes(result.resultType),
      `seed ${seed} pair ${result.pair} leg ${result.leg} has invalid result type`);
    for (const field of ['plies', 'botRolls', 'controlRolls', 'botDoubles', 'controlDoubles']) {
      assertInteger(result[field], `seed ${seed} pair ${result.pair} has invalid ${field}`);
    }
    assertCondition(result.botDoubles <= result.botRolls,
      `seed ${seed} pair ${result.pair} has more bot doubles than rolls`);
    assertCondition(result.controlDoubles <= result.controlRolls,
      `seed ${seed} pair ${result.pair} has more control doubles than rolls`);
    const expectedSeeds = diceStreamSeeds(seed, result.pair - 1);
    assertCondition(
      result.streamSeeds?.white === expectedSeeds.white
        && result.streamSeeds?.dark === expectedSeeds.dark,
      `seed ${seed} pair ${result.pair} has wrong derived stream seeds`,
    );
    const pair = pairs.get(result.pair) || [];
    pair.push(result);
    pairs.set(result.pair, pair);
  }
  for (let pairNumber = 1; pairNumber <= pairCount; pairNumber += 1) {
    const pair = pairs.get(pairNumber) || [];
    assertCondition(pair.length === 2, `seed ${seed} pair ${pairNumber} is incomplete`);
    assertCondition(new Set(pair.map(result => result.leg)).size === 2,
      `seed ${seed} pair ${pairNumber} repeats a leg`);
    assertCondition(new Set(pair.map(result => result.botColor)).size === 2,
      `seed ${seed} pair ${pairNumber} does not swap bot color`);
    assertCondition(canonicalJson(pair[0].streamSeeds) === canonicalJson(pair[1].streamSeeds),
      `seed ${seed} pair ${pairNumber} does not reuse the same physical streams`);
  }

  const botWins = results.filter(result => result.botWon).length;
  const severeBotLosses = results.filter(
    result => !result.botWon && result.resultType !== 'normal',
  ).length;
  const botRolls = results.reduce((sum, result) => sum + result.botRolls, 0);
  const controlRolls = results.reduce((sum, result) => sum + result.controlRolls, 0);
  const botDoubles = results.reduce((sum, result) => sum + result.botDoubles, 0);
  const controlDoubles = results.reduce((sum, result) => sum + result.controlDoubles, 0);
  const pairValues = [...pairs.values()];
  const expectedSummary = {
    botWins,
    controlWins: gamesPerSeed - botWins,
    severeBotLosses,
    botRolls,
    controlRolls,
    botDoubles,
    controlDoubles,
    pairSweeps: pairValues.filter(pair => pair.every(result => result.botWon)).length,
    pairSplits: pairValues.filter(pair => pair.filter(result => result.botWon).length === 1).length,
    pairLosses: pairValues.filter(pair => pair.every(result => !result.botWon)).length,
  };
  for (const [field, expected] of Object.entries(expectedSummary)) {
    assertCondition(summary[field] === expected,
      `seed ${seed} summary.${field} mismatch (expected ${expected}, received ${summary[field]})`);
  }
  assertClose(summary.winRate, botWins / gamesPerSeed, `seed ${seed} winRate mismatch`);
  assertClose(summary.severeLossRate, severeBotLosses / gamesPerSeed,
    `seed ${seed} severeLossRate mismatch`);
  assertClose(summary.botDoubleRate, botRolls ? botDoubles / botRolls : 0,
    `seed ${seed} botDoubleRate mismatch`);
  assertClose(summary.controlDoubleRate, controlRolls ? controlDoubles / controlRolls : 0,
    `seed ${seed} controlDoubleRate mismatch`);
  assertClose(summary.doubleRateDifference,
    (botRolls ? botDoubles / botRolls : 0) - (controlRolls ? controlDoubles / controlRolls : 0),
    `seed ${seed} doubleRateDifference mismatch`);
  assertCondition(summary.passed === true, `seed ${seed} neutral child gate did not pass`);
  return {
    engineVersion: summary.engineVersion,
    runtimeFingerprint: summary.runtimeFingerprint,
    simulatorHarnessFingerprint: summary.simulatorHarnessFingerprint,
    experienceFingerprint: summary.experienceFingerprint,
    comparableOptions: comparableOptions(summary.options),
  };
}

function validatePayloadForExecution(payload, seed, gamesPerSeed, requestedOptions, expectedIdentity) {
  const metadata = validateSeedPayload({ seed, payload }, gamesPerSeed, requestedOptions);
  assertExecutionIdentity(metadata, expectedIdentity, seed);
  return metadata;
}

function loadCheckpoint(
  checkpointDirectory,
  seed,
  gamesPerSeed,
  requestedOptions,
  expectedIdentity,
) {
  const file = checkpointPath(checkpointDirectory, seed);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not inspect checkpoint for seed ${seed}: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Checkpoint for seed ${seed} is stale or invalid: not a regular file`);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Checkpoint for seed ${seed} is stale or invalid: ${error.message}`);
  }
  try {
    validatePayloadForExecution(
      payload,
      seed,
      gamesPerSeed,
      requestedOptions,
      expectedIdentity,
    );
  } catch (error) {
    throw new Error(`Checkpoint for seed ${seed} is stale or invalid: ${error.message}`);
  }
  return payload;
}

function loadCheckpointSet(
  checkpointDirectory,
  seeds,
  gamesPerSeed,
  requestedOptions,
  expectedIdentity,
) {
  const checkpoints = new Map();
  for (const seed of seeds) {
    const payload = loadCheckpoint(
      checkpointDirectory,
      seed,
      gamesPerSeed,
      requestedOptions,
      expectedIdentity,
    );
    if (payload) checkpoints.set(seed, payload);
  }
  if (checkpoints.size) {
    validateSeedPayloads(
      [...checkpoints].map(([seed, payload]) => ({ seed, payload })),
      gamesPerSeed,
      requestedOptions,
    );
  }
  return checkpoints;
}

async function runSeedWithCheckpoint(
  seed,
  games,
  forwardedArgs,
  timeoutMs,
  checkpointDirectory,
  requestedOptions,
  expectedIdentity,
  dependencies = {},
) {
  if (checkpointDirectory) {
    const preloaded = dependencies.preloadedCheckpoints;
    const checkpoint = preloaded instanceof Map
      ? preloaded.get(seed) || null
      : loadCheckpoint(
        checkpointDirectory,
        seed,
        games,
        requestedOptions,
        expectedIdentity,
      );
    if (checkpoint) return checkpoint;
  }

  const seedRunner = dependencies.seedRunner || runSeed;
  const payload = await seedRunner(
    seed,
    games,
    forwardedArgs,
    timeoutMs,
    dependencies.seedDependencies || {},
  );
  validatePayloadForExecution(
    payload,
    seed,
    games,
    requestedOptions,
    expectedIdentity,
  );
  if (checkpointDirectory) persistCheckpointAtomic(checkpointDirectory, seed, payload);
  return payload;
}

function validateSeedPayloads(seedPayloads, gamesPerSeed, requestedOptions) {
  assertCondition(Array.isArray(seedPayloads) && seedPayloads.length > 0,
    'certification has no seed payloads');
  const metadata = seedPayloads.map(payload => (
    validateSeedPayload(payload, gamesPerSeed, requestedOptions)
  ));
  const baseline = metadata[0];
  for (let index = 1; index < metadata.length; index += 1) {
    const current = metadata[index];
    for (const field of [
      'engineVersion', 'runtimeFingerprint', 'simulatorHarnessFingerprint', 'experienceFingerprint',
    ]) {
      assertCondition(current[field] === baseline[field],
        `seed payloads do not share one ${field}`);
    }
    assertCondition(canonicalJson(current.comparableOptions) === canonicalJson(baseline.comparableOptions),
      'seed payloads do not share identical simulator options');
  }
  return baseline;
}

function aggregatePayloads(seedPayloads, criteria) {
  const summaries = seedPayloads.map(item => item.payload.summary);
  const pairScores = seedPayloads.flatMap(item => pairedScores(item.payload.results));
  const games = summaries.reduce((sum, summary) => sum + summary.games, 0);
  const botWins = summaries.reduce((sum, summary) => sum + summary.botWins, 0);
  const severeBotLosses = summaries.reduce((sum, summary) => sum + summary.severeBotLosses, 0);
  const botRolls = summaries.reduce((sum, summary) => sum + summary.botRolls, 0);
  const controlRolls = summaries.reduce((sum, summary) => sum + summary.controlRolls, 0);
  const botDoubles = summaries.reduce((sum, summary) => sum + summary.botDoubles, 0);
  const controlDoubles = summaries.reduce((sum, summary) => sum + summary.controlDoubles, 0);
  const winRate = botWins / games;
  const severeLossRate = severeBotLosses / games;
  const winConfidence = boundedMeanDiagnostics(pairScores.map(pair => pair.winRate));
  const severeConfidence = boundedMeanDiagnostics(pairScores.map(pair => pair.severeLossRate));
  const observedPassed = winRate >= criteria.minWinRate
    && severeLossRate <= criteria.maxSevereLossRate;
  const confidencePassed = winConfidence.hoeffdingLower95 >= criteria.minWinRate
    && severeConfidence.hoeffdingUpper95 <= criteria.maxSevereLossRate;
  return {
    engineVersions: [...new Set(summaries.map(summary => summary.engineVersion))],
    runtimeFingerprints: [...new Set(summaries.map(summary => summary.runtimeFingerprint))],
    simulatorHarnessFingerprints: [
      ...new Set(summaries.map(summary => summary.simulatorHarnessFingerprint)),
    ],
    experienceFingerprints: [...new Set(summaries.map(summary => summary.experienceFingerprint))],
    seeds: seedPayloads.length,
    games,
    pairs: pairScores.length,
    botWins,
    controlWins: games - botWins,
    winRate,
    severeBotLosses,
    severeLossRate,
    pairSweeps: summaries.reduce((sum, summary) => sum + summary.pairSweeps, 0),
    pairSplits: summaries.reduce((sum, summary) => sum + summary.pairSplits, 0),
    pairLosses: summaries.reduce((sum, summary) => sum + summary.pairLosses, 0),
    botRolls,
    controlRolls,
    botDoubles,
    controlDoubles,
    botDoubleRate: botRolls ? botDoubles / botRolls : 0,
    controlDoubleRate: controlRolls ? controlDoubles / controlRolls : 0,
    doubleRateDifference: (botRolls ? botDoubles / botRolls : 0)
      - (controlRolls ? controlDoubles / controlRolls : 0),
    pairedWinConfidence95: winConfidence,
    pairedSevereLossConfidence95: severeConfidence,
    observedPassed,
    confidencePassed,
    passed: observedPassed && (!criteria.requireConfidence || confidencePassed),
  };
}

function forwardedSimulatorArgs(parsed) {
  const args = [];
  for (const name of [
    'bot-nodes', 'control-nodes', 'bot-candidates', 'control-candidates',
    'max-plies', 'bot-profile', 'control-profile', 'experience',
  ]) {
    if (parsed.values.has(name)) args.push(`--${name}`, parsed.values.get(name));
  }
  if (parsed.flags.has('trace')) args.push('--trace');
  return args;
}

function collectChildResult(child, timeoutMs) {
  return new Promise(resolve => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let childError = null;
    let terminationError = null;
    let killTimer = null;
    let settled = false;

    const terminate = error => {
      if (terminationError) return;
      terminationError = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), CHILD_KILL_GRACE_MS);
    };
    const capture = target => chunk => {
      if (terminationError) return;
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CHILD_OUTPUT_BYTES) {
        terminate(new Error(`child output exceeded ${MAX_CHILD_OUTPUT_BYTES} bytes`));
        return;
      }
      target.push(chunk);
    };
    const timeoutTimer = setTimeout(() => {
      terminate(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status,
        signal,
        error: terminationError || childError,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    };

    child.stdout.on('data', capture(stdoutChunks));
    child.stderr.on('data', capture(stderrChunks));
    child.once('error', error => {
      childError = error;
      if (!child.pid) finish(null, null);
    });
    child.once('close', finish);
  });
}

async function runSeed(seed, games, forwardedArgs, timeoutMs, dependencies = {}) {
  const simulator = dependencies.simulator || SIMULATOR;
  const cwd = dependencies.cwd || path.join(__dirname, '..');
  const tempRoot = dependencies.tempRoot || os.tmpdir();
  const spawnProcess = dependencies.spawnProcess || spawn;
  const tempDirectory = fs.mkdtempSync(path.join(tempRoot, 'long-bot-cert-'));
  const output = path.join(tempDirectory, 'result.json');
  try {
    const childProcess = spawnProcess(process.execPath, [
      simulator,
      '--games', String(games),
      '--seed', String(seed),
      '--min-win-rate', '0',
      '--max-severe-loss-rate', '1',
      '--output', output,
      ...forwardedArgs,
    ], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = await collectChildResult(childProcess, timeoutMs);
    if (child.error || child.status !== 0 || !fs.existsSync(output)) {
      const detail = [
        child.error ? `${child.error.code || child.error.name}: ${child.error.message}` : '',
        child.status === null ? `terminated by ${child.signal || 'unknown signal'}` : '',
        child.stdout,
        child.stderr,
      ].filter(Boolean).join('\n').trim();
      throw new Error(`Seed ${seed} failed${detail ? `:\n${detail}` : ''}`);
    }
    try {
      return JSON.parse(fs.readFileSync(output, 'utf8'));
    } catch (error) {
      throw new Error(`Seed ${seed} produced invalid JSON: ${error.message}`);
    }
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function runSeedsOrdered(seeds, jobs, runner, onComplete = () => {}) {
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new Error('At least one seed is required');
  }
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > seeds.length) {
    throw new Error('Effective job count must be between 1 and the seed count');
  }
  if (typeof runner !== 'function' || typeof onComplete !== 'function') {
    throw new Error('Seed runner and completion callback must be functions');
  }

  const results = new Array(seeds.length);
  const completed = new Array(seeds.length).fill(false);
  let nextIndex = 0;
  let nextCompletionIndex = 0;
  let firstError = null;

  const flushCompletions = () => {
    while (completed[nextCompletionIndex]) {
      onComplete(results[nextCompletionIndex], seeds[nextCompletionIndex], nextCompletionIndex);
      nextCompletionIndex += 1;
    }
  };
  const worker = async () => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= seeds.length) return;
      try {
        results[index] = await runner(seeds[index], index);
        completed[index] = true;
        flushCompletions();
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  };

  await Promise.all(Array.from({ length: jobs }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

async function main() {
  const parsed = parseCliTokens(process.argv.slice(2), VALUE_OPTIONS, FLAG_OPTIONS);
  if (parsed.flags.has('learn')) {
    throw new Error('--learn is not allowed in certification because adaptive pairs are not independent');
  }
  const seeds = parseSeeds(stringOption(parsed, 'seeds'));
  const jobs = resolveJobs(parsed, seeds.length);
  const gamesPerSeed = positiveIntegerOption(parsed, 'games-per-seed', 20);
  if (gamesPerSeed < 2 || gamesPerSeed % 2 !== 0) {
    throw new Error('--games-per-seed must be an even number of at least 2');
  }
  const seedTimeoutMs = positiveIntegerOption(
    parsed, 'seed-timeout-ms', DEFAULT_SEED_TIMEOUT_MS, MAX_TIMEOUT_MS,
  );
  const criteria = {
    minWinRate: ratioOption(parsed, 'min-win-rate', 0.7),
    maxSevereLossRate: ratioOption(parsed, 'max-severe-loss-rate', 0.1),
    requireConfidence: parsed.flags.has('require-confidence'),
  };
  profileOption(parsed, 'bot-profile', 'v24');
  profileOption(parsed, 'control-profile', 'v19');
  const pairCount = seeds.length * gamesPerSeed / 2;
  const minimumConfidencePairs = minimumPairsForConfidence(criteria);
  if (criteria.requireConfidence) validateConfidenceCapacity(pairCount, criteria);
  validateDerivedStreamSeeds(seeds, gamesPerSeed / 2);

  const output = stringOption(parsed, 'output');
  const checkpointDirectory = parsed.values.has('checkpoint-dir')
    ? path.resolve(stringOption(parsed, 'checkpoint-dir'))
    : '';
  const includeResults = parsed.flags.has('include-results');
  const forwardedArgs = forwardedSimulatorArgs(parsed);
  const requestedOptions = requestedSimulatorOptions(parsed, gamesPerSeed);
  const expectedIdentity = currentExecutionIdentity(requestedOptions);
  if (checkpointDirectory) ensureCheckpointDirectory(checkpointDirectory);
  const preloadedCheckpoints = checkpointDirectory
    ? loadCheckpointSet(
      checkpointDirectory,
      seeds,
      gamesPerSeed,
      requestedOptions,
      expectedIdentity,
    )
    : new Map();
  const certifierHarnessFingerprint = fileFingerprint(__filename);
  console.log(
    `certification: ${seeds.length} seeds, ${gamesPerSeed} games per seed, `
    + `${jobs.effective} parallel jobs`,
  );
  const payloads = await runSeedsOrdered(seeds, jobs.effective, seed => (
    runSeedWithCheckpoint(
      seed,
      gamesPerSeed,
      forwardedArgs,
      seedTimeoutMs,
      checkpointDirectory,
      requestedOptions,
      expectedIdentity,
      { preloadedCheckpoints },
    )
  ), (payload, seed) => {
    const summary = payload.summary;
    console.log(
      `seed ${seed}: ${summary.botWins}/${summary.games} `
      + `(${(summary.winRate * 100).toFixed(1)}%), severe ${summary.severeBotLosses}`,
    );
  });
  const seedPayloads = seeds.map((seed, index) => ({ seed, payload: payloads[index] }));
  validateSeedPayloads(seedPayloads, gamesPerSeed, requestedOptions);
  const aggregate = aggregatePayloads(seedPayloads, criteria);
  const perSeed = seedPayloads.map(({ seed, payload }) => {
    const summary = JSON.parse(JSON.stringify(payload.summary));
    summary.options.output = '';
    return {
      seed,
      summary,
      observedPassed: summary.winRate >= criteria.minWinRate
        && summary.severeLossRate <= criteria.maxSevereLossRate,
      ...(includeResults ? { results: payload.results } : {}),
    };
  });
  const report = {
    schemaVersion: 2,
    certifierHarnessFingerprint,
    methodology: {
      pairing: 'white stream A and dark stream B stay fixed; bot and control swap colors per leg',
      independentUnit: 'paired score (sweep=1, split=0.5, loss=0); adaptive learning is forbidden',
      confidence: 'Bonferroni-adjusted simultaneous 95% one-sided normal diagnostic and Hoeffding bounds',
      control: 'v19 is a current-runtime ablation profile, not a frozen historical implementation',
      runtime: 'both profiles use the same immutable fingerprinted runtime bytes',
      diceStreams: 'SHA-256 domain-separated, non-zero, collision-checked xorshift32 seeds',
    },
    criteria,
    options: {
      seeds,
      gamesPerSeed,
      seedTimeoutMs,
      jobs: {
        requested: jobs.requested,
        effective: jobs.effective,
        default: DEFAULT_JOBS,
        maximum: MAX_JOBS,
      },
      minimumConfidencePairs: Number.isFinite(minimumConfidencePairs)
        ? minimumConfidencePairs
        : null,
      forwardedSimulatorArgs: forwardedArgs,
      requestedSimulatorOptions: requestedOptions,
      checkpointDirectory,
    },
    aggregate,
    perSeed,
  };
  if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(aggregate));
  if (!aggregate.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 2;
  });
}

module.exports = {
  DEFAULT_JOBS,
  DEFAULT_SEEDS,
  MAX_JOBS,
  aggregatePayloads,
  boundedMeanDiagnostics,
  checkpointFilename,
  checkpointPath,
  currentExecutionIdentity,
  ensureCheckpointDirectory,
  loadCheckpoint,
  loadCheckpointSet,
  minimumPairsForConfidence,
  pairedScores,
  parseSeeds,
  requestedSimulatorOptions,
  resolveJobs,
  runSeed,
  runSeedWithCheckpoint,
  runSeedsOrdered,
  persistCheckpointAtomic,
  validateConfidenceCapacity,
  validateSeedPayload,
  validateSeedPayloads,
};
