#!/usr/bin/env node

/*
 * Honest, equal-resource long-bot league.
 *
 * The candidate is loaded from the working tree (or --candidate-runtime-dir),
 * while the control is loaded from immutable bytes resolved from a git commit
 * or an explicit runtime directory. Both engines receive exactly the same
 * profile, candidate cap, node budget and rules implementation. Every random
 * sample is a two-leg match with colors and color-bound dice streams crossed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  diceStreamSeeds,
  fingerprintNamedBuffers,
  loadRuntime,
  parseCliTokens,
  playGame,
  readRuntimeSnapshot,
  validateDerivedStreamSeeds,
} = require('./simulate-long-bot-regression');

const ROOT = path.join(__dirname, '..');
const RUNTIME_FILES = Object.freeze(['game.js', 'long-bot-engine.js', 'strong-bot.js']);
// Capture the actual harness bytes at module load. A sidecar-enabled result
// must never be mistaken for a run made by the older in-state-ledger harness.
const HARNESS_FILES = Object.freeze([
  'scripts/simulate-long-bot-regression.js',
  'scripts/league-long-bot-frozen-runtime.js',
  'scripts/league-long-bot-army.js',
  'scripts/league-long-bot-army-worker.js',
]);
const HARNESS_SOURCE_FINGERPRINT = fingerprintNamedBuffers(
  HARNESS_FILES.map(file => [file, fs.readFileSync(path.join(ROOT, file))]),
);
function leagueHarnessFingerprint() { return HARNESS_SOURCE_FINGERPRINT; }
const UINT32_MAX = 0xffffffff;
const WILSON_Z_95 = 1.959963984540054;
const DEFAULT_SEED = 0x4c424c31;
const DEFAULT_PAIRS = 200;
const DEFAULT_TARGET_WIN_RATE = 0.65;
const DEFAULT_EXPECTED_CANDIDATE_VERSION = 'long-analytic-v35';
const DEFAULT_EXPECTED_CONTROL_VERSION = 'long-analytic-v34';
const DEFAULT_RESOURCES = Object.freeze({
  profile: 'v25',
  nodes: 480,
  candidates: 64,
  maxPlies: 320,
});

const VALUE_OPTIONS = new Set([
  'pairs',
  'seed',
  'nodes',
  'candidates',
  'profile',
  'max-plies',
  'target-win-rate',
  'candidate-runtime-dir',
  'control-runtime-dir',
  'control-git-ref',
  'expected-candidate-version',
  'expected-control-version',
  'output',
]);
const FLAG_OPTIONS = new Set(['trace', 'sidecar-analysis']);
const SUPPORTED_PROFILES = new Set(['v19', 'v25']);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

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

function parseOptions(argv) {
  const parsed = parseCliTokens(argv, VALUE_OPTIONS, FLAG_OPTIONS);
  const controlRuntimeDirectory = stringOption(parsed, 'control-runtime-dir');
  const explicitControlGitRef = stringOption(parsed, 'control-git-ref');
  if (controlRuntimeDirectory && explicitControlGitRef) {
    throw new Error('Use either --control-runtime-dir or --control-git-ref, not both');
  }
  const profile = stringOption(parsed, 'profile', DEFAULT_RESOURCES.profile).toLowerCase();
  if (!SUPPORTED_PROFILES.has(profile)) {
    throw new Error(`--profile must be one of: ${[...SUPPORTED_PROFILES].join(', ')}`);
  }
  return {
    pairs: positiveIntegerOption(parsed, 'pairs', DEFAULT_PAIRS),
    seed: positiveIntegerOption(parsed, 'seed', DEFAULT_SEED, UINT32_MAX),
    resources: {
      nodes: positiveIntegerOption(parsed, 'nodes', DEFAULT_RESOURCES.nodes),
      candidates: positiveIntegerOption(parsed, 'candidates', DEFAULT_RESOURCES.candidates),
      profile,
      maxPlies: positiveIntegerOption(parsed, 'max-plies', DEFAULT_RESOURCES.maxPlies),
    },
    targetWinRate: ratioOption(parsed, 'target-win-rate', DEFAULT_TARGET_WIN_RATE),
    candidateRuntimeDirectory: path.resolve(stringOption(
      parsed,
      'candidate-runtime-dir',
      ROOT,
    )),
    control: controlRuntimeDirectory
      ? { kind: 'directory', directory: path.resolve(controlRuntimeDirectory) }
      : { kind: 'git', ref: explicitControlGitRef || 'HEAD' },
    expectedControlVersion: stringOption(
      parsed,
      'expected-control-version',
      DEFAULT_EXPECTED_CONTROL_VERSION,
    ),
    expectedCandidateVersion: stringOption(
      parsed,
      'expected-candidate-version',
      DEFAULT_EXPECTED_CANDIDATE_VERSION,
    ),
    output: stringOption(parsed, 'output'),
    trace: parsed.flags.has('trace'),
    sidecarAnalysis: parsed.flags.has('sidecar-analysis'),
  };
}

function snapshotFromEntries(entries) {
  const normalized = entries.map(([name, bytes]) => [name, Buffer.from(bytes)]);
  return {
    entries: normalized,
    fingerprint: fingerprintNamedBuffers(normalized),
  };
}

function readRuntimeDirectory(directory) {
  const stat = fs.statSync(directory);
  assertCondition(stat.isDirectory(), `Runtime path is not a directory: ${directory}`);
  return readRuntimeSnapshot(directory);
}

function resolveCommit(repository, ref) {
  const resolved = execFileSync(
    'git',
    ['rev-parse', '--verify', `${ref}^{commit}`],
    { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  assertCondition(/^[0-9a-f]{40,64}$/.test(resolved), `Could not resolve git commit: ${ref}`);
  return resolved;
}

function readGitRuntimeSnapshot(repository, ref = 'HEAD') {
  const commit = resolveCommit(repository, ref);
  const entries = RUNTIME_FILES.map(file => [
    file,
    execFileSync('git', ['show', `${commit}:${file}`], {
      cwd: repository,
      encoding: null,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }),
  ]);
  return {
    ...snapshotFromEntries(entries),
    source: { kind: 'git', requestedRef: ref, commit },
  };
}

function runtimeFileFingerprint(snapshot, filename) {
  const entry = snapshot.entries.find(([name]) => name === filename);
  assertCondition(entry, `Runtime snapshot is missing ${filename}`);
  return fingerprintNamedBuffers([[filename, entry[1]]]);
}

function wilsonInterval(successes, trials, z = WILSON_Z_95) {
  assertCondition(Number.isFinite(successes), 'Wilson successes must be finite');
  assertCondition(Number.isSafeInteger(trials) && trials >= 0, 'Wilson trials must be non-negative');
  assertCondition(successes >= 0 && successes <= trials, 'Wilson successes must be within trials');
  assertCondition(Number.isFinite(z) && z > 0, 'Wilson z must be positive');
  if (trials === 0) {
    return { lower: 0, upper: 1, center: null, trials: 0, successes: 0 };
  }
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

function boundedPairInterval(scoreSum, pairs, alpha = 0.05) {
  assertCondition(Number.isFinite(scoreSum), 'Pair score sum must be finite');
  assertCondition(Number.isSafeInteger(pairs) && pairs >= 0, 'Pair count must be non-negative');
  assertCondition(scoreSum >= 0 && scoreSum <= pairs, 'Pair scores must be within zero and one');
  assertCondition(Number.isFinite(alpha) && alpha > 0 && alpha < 1,
    'Pair interval alpha must be between zero and one');
  if (pairs === 0) {
    return { lower: 0, upper: 1, mean: null, pairs: 0, scoreSum: 0, alpha, method: 'hoeffding-bounded-pair' };
  }
  // A crossed pair has a bounded score in {0, 0.5, 1}, not a Bernoulli
  // outcome. Hoeffding applies to the independent pair units without treating
  // split pairs as fractional Bernoulli trials. Wilson remains diagnostic.
  const mean = scoreSum / pairs;
  const radius = Math.sqrt(Math.log(2 / alpha) / (2 * pairs));
  return {
    lower: Math.max(0, mean - radius),
    upper: Math.min(1, mean + radius),
    mean,
    pairs,
    scoreSum,
    alpha,
    method: 'hoeffding-bounded-pair',
  };
}

function validatePairedResults(results, pairs, seed) {
  assertCondition(Array.isArray(results), 'League results must be an array');
  assertCondition(results.length === pairs * 2, 'League result count does not match pair count');
  const productionWeights = new Set(results.map(result => productionWeightsKey(result)));
  assertCondition(productionWeights.size === 1, 'League production weights are not identical');
  for (let pairIndex = 0; pairIndex < pairs; pairIndex += 1) {
    const pairNumber = pairIndex + 1;
    const pair = results.filter(result => result.pair === pairNumber);
    assertCondition(pair.length === 2, `Pair ${pairNumber} is incomplete`);
    assertCondition(
      pair.every(result => result.leg === 1 || result.leg === 2)
        && new Set(pair.map(result => result.leg)).size === 2,
      `Pair ${pairNumber} must contain legs 1 and 2 exactly once`,
    );
    assertCondition(pair.every(result => result.game === pairIndex * 2 + result.leg),
      `Pair ${pairNumber} has an inconsistent global game number`);
    assertCondition(pair.every(result => result.botColor === 'white' || result.botColor === 'dark'),
      `Pair ${pairNumber} has an invalid candidate color`);
    assertCondition(new Set(pair.map(result => result.botColor)).size === 2,
      `Pair ${pairNumber} does not swap candidate color`);
    assertCondition(pair.every(result => (
      result.controlColor === (result.botColor === 'white' ? 'dark' : 'white')
    )), `Pair ${pairNumber} has inconsistent control colors`);
    const expectedStreams = diceStreamSeeds(seed, pairIndex);
    assertCondition(pair.every(result => (
      JSON.stringify(result.streamSeeds) === JSON.stringify(expectedStreams)
    )), `Pair ${pairNumber} does not reuse the exact color-bound dice streams`);
    assertCondition(pair.every(result => typeof result.botWon === 'boolean'),
      `Pair ${pairNumber} has an invalid winner flag`);
    assertCondition(pair.every(result => result.winner === 'white' || result.winner === 'dark'),
      `Pair ${pairNumber} has an invalid winner color`);
    assertCondition(pair.every(result => result.botWon === (result.winner === result.botColor)),
      `Pair ${pairNumber} has an inconsistent winner flag`);
  }
}

function productionWeightsKey(result) {
  assertCondition(result?.productionDispatch === true,
    'League leg does not use the production hard-bot dispatcher');
  const weights = result.productionPolicyWeights;
  assertCondition(weights && typeof weights === 'object' && !Array.isArray(weights),
    'League leg omits production policy weights');
  const entries = Object.entries(weights).sort(([left], [right]) => left.localeCompare(right));
  assertCondition(entries.length > 0
    && entries.every(([, value]) => typeof value === 'number' && Number.isFinite(value)),
  'League leg has invalid production policy weights');
  return JSON.stringify(entries);
}

function summarizeResults(results, options) {
  validatePairedResults(results, options.pairs, options.seed);
  const candidateWins = results.filter(result => result.botWon).length;
  const pairScores = Array.from({ length: options.pairs }, (_, pairIndex) => {
    const pairNumber = pairIndex + 1;
    return results.filter(result => result.pair === pairNumber && result.botWon).length / 2;
  });
  const pairedSuccesses = pairScores.reduce((sum, score) => sum + score, 0);
  const observedWinRate = candidateWins / results.length;
  const gameWilson95 = wilsonInterval(candidateWins, results.length);
  // A pair, not an individual leg, is the independent sampling unit. A split
  // contributes half a success. This avoids pretending the crossed legs are
  // two independent observations.
  const pairedWilson95 = wilsonInterval(pairedSuccesses, options.pairs);
  const pairedHoeffding95 = boundedPairInterval(pairedSuccesses, options.pairs);
  const observedThresholdMet = observedWinRate >= options.targetWinRate;
  const confidenceThresholdMet = pairedHoeffding95.lower >= options.targetWinRate;
  return {
    pairs: options.pairs,
    games: results.length,
    candidateWins,
    controlWins: results.length - candidateWins,
    observedWinRate,
    observedWinPercent: observedWinRate * 100,
    targetWinRate: options.targetWinRate,
    targetWinPercent: options.targetWinRate * 100,
    pairOutcomes: {
      sweeps: pairScores.filter(score => score === 1).length,
      splits: pairScores.filter(score => score === 0.5).length,
      losses: pairScores.filter(score => score === 0).length,
    },
    gameWilson95,
    pairedWilson95,
    pairedHoeffding95,
    checks: {
      observedThresholdMet,
      pairedWilsonLowerThresholdMet: pairedWilson95.lower >= options.targetWinRate,
      pairedHoeffdingLowerThresholdMet: confidenceThresholdMet,
    },
    verdict: observedThresholdMet && confidenceThresholdMet
      ? 'certified'
      : observedThresholdMet
        ? 'not-certified'
        : 'failed',
    passed: observedThresholdMet && confidenceThresholdMet,
  };
}

function buildRuntimeLeague(
  candidateSnapshot,
  controlSnapshot,
  expectedControlVersion,
  expectedCandidateVersion = DEFAULT_EXPECTED_CANDIDATE_VERSION,
) {
  // No historical experience is imported on either side. The comparison is
  // between the strategy runtimes themselves, not between unequal databases.
  const candidate = loadRuntime(undefined, candidateSnapshot);
  const control = loadRuntime(undefined, controlSnapshot);
  assertCondition(
    candidate.engine.version === expectedCandidateVersion,
    `Candidate version mismatch: expected ${expectedCandidateVersion}, received ${candidate.engine.version}`,
  );
  assertCondition(
    control.engine.version === expectedControlVersion,
    `Frozen control version mismatch: expected ${expectedControlVersion}, received ${control.engine.version}`,
  );
  assertCondition(candidate.engine !== control.engine, 'Candidate and control engines are not isolated');
  assertCondition(
    candidateSnapshot.fingerprint !== controlSnapshot.fingerprint,
    'Candidate and control runtime snapshots are identical',
  );
  assertCondition(
    runtimeFileFingerprint(candidateSnapshot, 'game.js')
      === runtimeFileFingerprint(controlSnapshot, 'game.js'),
    'Candidate and control game.js differ; strategy league would be confounded by different rules',
  );
  return {
    game: candidate.game,
    engine: candidate.engine,
    controlEngine: control.engine,
    hardBot: candidate.hardBot,
    controlHardBot: control.hardBot,
    candidate,
    control,
  };
}

function playLeaguePairs(runtime, options, pairIndices, onPair = null) {
  assertCondition(options.sidecarAnalysis === undefined || typeof options.sidecarAnalysis === 'boolean',
    'League sidecar analysis flag must be a native boolean');
  const results = [];
  const playOptions = {
    seed: options.seed,
    maxPlies: options.resources.maxPlies,
    botProfile: options.resources.profile,
    controlProfile: options.resources.profile,
    botCandidates: options.resources.candidates,
    controlCandidates: options.resources.candidates,
    botNodes: options.resources.nodes,
    controlNodes: options.resources.nodes,
    productionDispatch: true,
    trace: options.trace,
    sidecarAnalysis: options.sidecarAnalysis === true,
  };
  assertCondition(Array.isArray(pairIndices), 'League pair indices must be an array');
  const seenPairIndices = new Set();
  for (const pairIndex of pairIndices) {
    assertCondition(
      Number.isSafeInteger(pairIndex) && pairIndex >= 0,
      'League pair index must be a non-negative safe integer',
    );
    assertCondition(!seenPairIndices.has(pairIndex), `League pair index ${pairIndex} is duplicated`);
    seenPairIndices.add(pairIndex);
    const pairResults = [];
    for (let leg = 0; leg < 2; leg += 1) {
      runtime.controlEngine.beginExperienceSession?.();
      runtime.controlEngine.freezeExperience?.();
      const result = playGame(pairIndex, leg, runtime, playOptions);
      delete result._state;
      pairResults.push(result);
      results.push(result);
    }
    onPair?.(pairIndex + 1, pairResults);
  }
  return results;
}

function playLeague(runtime, options, onPair = null) {
  return playLeaguePairs(
    runtime,
    options,
    Array.from({ length: options.pairs }, (_, pairIndex) => pairIndex),
    onPair,
  );
}

function controlSnapshotFor(options) {
  if (options.control.kind === 'directory') {
    return {
      ...readRuntimeDirectory(options.control.directory),
      source: { kind: 'directory', directory: options.control.directory },
    };
  }
  return readGitRuntimeSnapshot(ROOT, options.control.ref);
}

function runLeague(options, progress = null) {
  validateDerivedStreamSeeds([options.seed], options.pairs);
  const candidateSnapshot = {
    ...readRuntimeDirectory(options.candidateRuntimeDirectory),
    source: { kind: 'directory', directory: options.candidateRuntimeDirectory },
  };
  const controlSnapshot = controlSnapshotFor(options);
  const runtime = buildRuntimeLeague(
    candidateSnapshot,
    controlSnapshot,
    options.expectedControlVersion,
    options.expectedCandidateVersion,
  );
  const results = playLeague(runtime, options, progress);
  const summary = summarizeResults(results, options);
  return {
    schemaVersion: 1,
    methodology: {
      independentUnit: 'paired-color-swapped-match',
      legsPerPair: 2,
      externalExperience: 'disabled-for-both',
      policyDispatch: 'frozen strong-bot.js production dispatch on both sides; identical finite stable weights; no fallbacks',
      sidecarAnalysis: options.sidecarAnalysis === true,
      analysisLedger: options.sidecarAnalysis === true
        ? 'candidate decisions held in sidecar during play; complete ledger restored after terminal before export'
        : 'candidate decisions retained on working state during play (legacy default)',
      confidenceInterval: 'Hoeffding 95% bound for independent bounded pair scores; Wilson is diagnostic only',
      passRule: 'observed win rate and paired Hoeffding lower bound must meet target',
    },
    candidate: {
      engineVersion: runtime.candidate.engine.version,
      runtimeFingerprint: candidateSnapshot.fingerprint,
      source: candidateSnapshot.source,
    },
    control: {
      engineVersion: runtime.control.engine.version,
      runtimeFingerprint: controlSnapshot.fingerprint,
      source: controlSnapshot.source,
    },
    sameRuntimeFingerprint: candidateSnapshot.fingerprint === controlSnapshot.fingerprint,
    resources: { ...options.resources },
    harnessSourceFingerprint: leagueHarnessFingerprint(),
    seed: options.seed,
    summary,
    results,
  };
}

function writeJsonAtomic(filename, payload) {
  const destination = path.resolve(filename);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${process.hrtime.bigint()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const payload = runLeague(options, (completed, pairResults) => {
    if (completed % 10 === 0 || completed === options.pairs) {
      const wins = pairResults.filter(result => result.botWon).length;
      process.stderr.write(`pair ${completed}/${options.pairs} completed (last pair wins ${wins}/2)\n`);
    }
  });
  if (options.output) writeJsonAtomic(options.output, payload);
  process.stdout.write(`${JSON.stringify({
    candidate: payload.candidate,
    control: payload.control,
    resources: payload.resources,
    seed: payload.seed,
    summary: payload.summary,
  })}\n`);
  if (!payload.summary.passed) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  DEFAULT_EXPECTED_CANDIDATE_VERSION,
  DEFAULT_EXPECTED_CONTROL_VERSION,
  DEFAULT_RESOURCES,
  DEFAULT_TARGET_WIN_RATE,
  buildRuntimeLeague,
  leagueHarnessFingerprint,
  boundedPairInterval,
  parseOptions,
  playLeague,
  playLeaguePairs,
  productionWeightsKey,
  readGitRuntimeSnapshot,
  readRuntimeDirectory,
  resolveCommit,
  runLeague,
  snapshotFromEntries,
  summarizeResults,
  validatePairedResults,
  wilsonInterval,
  writeJsonAtomic,
};
