#!/usr/bin/env node

/*
 * Parallel, deterministic, equal-resource league for the long hard bot.
 *
 * This is an orchestration layer over league-long-bot-frozen-runtime.js. It
 * freezes both runtimes once, partitions global pair indices between worker
 * processes, then validates and aggregates only complete color-swapped pairs.
 * A zero exit status is deliberately strict: the requested run must be
 * complete, the minimum game count must be met, and both the observed rate
 * and the lower bound of the paired 95% Hoeffding interval must meet the target.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  DEFAULT_EXPECTED_CANDIDATE_VERSION,
  DEFAULT_EXPECTED_CONTROL_VERSION,
  DEFAULT_RESOURCES,
  DEFAULT_TARGET_WIN_RATE,
  buildRuntimeLeague,
  leagueHarnessFingerprint,
  boundedPairInterval,
  readGitRuntimeSnapshot,
  readRuntimeDirectory,
  productionWeightsKey,
  wilsonInterval,
  writeJsonAtomic,
} = require('./league-long-bot-frozen-runtime');
const {
  diceStreamSeeds,
  parseCliTokens,
  validateDerivedStreamSeeds,
} = require('./simulate-long-bot-regression');

const ROOT = path.join(__dirname, '..');
const WORKER = path.join(__dirname, 'league-long-bot-army-worker.js');
const UINT32_MAX = 0xffffffff;
const DEFAULT_PAIRS = 200;
const MAX_WORKERS = 64;
const VALUE_OPTIONS = new Set([
  'pairs',
  'workers',
  'min-games',
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

function defaultWorkerCount(pairs) {
  const available = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.min(pairs, 4, Math.max(1, available - 1));
}

function parseOptions(argv) {
  const parsed = parseCliTokens(argv, VALUE_OPTIONS, FLAG_OPTIONS);
  const pairs = positiveIntegerOption(parsed, 'pairs', DEFAULT_PAIRS);
  const workers = positiveIntegerOption(
    parsed,
    'workers',
    defaultWorkerCount(pairs),
    MAX_WORKERS,
  );
  const minimumGames = positiveIntegerOption(parsed, 'min-games', pairs * 2);
  if (minimumGames < 2 || minimumGames % 2 !== 0) {
    throw new Error('--min-games must be an even integer of at least 2');
  }
  if (minimumGames > pairs * 2) {
    throw new Error('--min-games cannot exceed the requested number of games');
  }
  const controlRuntimeDirectory = stringOption(parsed, 'control-runtime-dir');
  const controlGitRef = stringOption(parsed, 'control-git-ref');
  if (controlRuntimeDirectory && controlGitRef) {
    throw new Error('Use either --control-runtime-dir or --control-git-ref, not both');
  }
  const profile = stringOption(parsed, 'profile', DEFAULT_RESOURCES.profile).toLowerCase();
  if (!SUPPORTED_PROFILES.has(profile)) {
    throw new Error(`--profile must be one of: ${[...SUPPORTED_PROFILES].join(', ')}`);
  }
  return {
    pairs,
    workers: Math.min(workers, pairs),
    minimumGames,
    seed: positiveIntegerOption(parsed, 'seed', 0x4c424c31, UINT32_MAX),
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
      : { kind: 'git', ref: controlGitRef || 'HEAD' },
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

function partitionPairIndices(pairs, workers) {
  assertCondition(Number.isSafeInteger(pairs) && pairs > 0,
    'Pair count must be a positive safe integer');
  assertCondition(Number.isSafeInteger(workers) && workers > 0,
    'Worker count must be a positive safe integer');
  const shardCount = Math.min(pairs, workers);
  const shards = Array.from({ length: shardCount }, (_, shardId) => ({
    shardId,
    pairIndices: [],
  }));
  for (let pairIndex = 0; pairIndex < pairs; pairIndex += 1) {
    shards[pairIndex % shardCount].pairIndices.push(pairIndex);
  }
  return shards;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatePairResults(results, pairIndex, seed, sidecarAnalysis = undefined) {
  assertCondition(Array.isArray(results) && results.length === 2,
    `Pair ${pairIndex + 1} must contain exactly two legs`);
  assertCondition(new Set(results.map(result => productionWeightsKey(result))).size === 1,
    `Pair ${pairIndex + 1} has different production weights`);
  const expectedStreams = diceStreamSeeds(seed, pairIndex);
  const expectedPair = pairIndex + 1;
  const legs = new Set();
  const colors = new Set();
  for (const result of results) {
    assertCondition(result && typeof result === 'object',
      `Pair ${expectedPair} contains an invalid result`);
    if (sidecarAnalysis !== undefined) {
      assertCondition(result.sidecarAnalysis === sidecarAnalysis,
        `Pair ${expectedPair} has a different sidecar analysis flag`);
    }
    assertCondition(result.pair === expectedPair, `Pair ${expectedPair} has a wrong pair number`);
    assertCondition(result.leg === 1 || result.leg === 2,
      `Pair ${expectedPair} has an invalid leg`);
    assertCondition(!legs.has(result.leg), `Pair ${expectedPair} repeats a leg`);
    legs.add(result.leg);
    assertCondition(result.game === pairIndex * 2 + result.leg,
      `Pair ${expectedPair} has a wrong global game number`);
    assertCondition(result.botColor === 'white' || result.botColor === 'dark',
      `Pair ${expectedPair} has an invalid candidate color`);
    assertCondition(!colors.has(result.botColor),
      `Pair ${expectedPair} does not swap candidate color`);
    colors.add(result.botColor);
    assertCondition(
      result.controlColor === (result.botColor === 'white' ? 'dark' : 'white'),
      `Pair ${expectedPair} has inconsistent control colors`,
    );
    assertCondition(sameJson(result.streamSeeds, expectedStreams),
      `Pair ${expectedPair} does not use its deterministic color-bound dice streams`);
    assertCondition(typeof result.botWon === 'boolean',
      `Pair ${expectedPair} has an invalid winner flag`);
    assertCondition(result.winner === 'white' || result.winner === 'dark',
      `Pair ${expectedPair} has an invalid winner color`);
    assertCondition(result.botWon === (result.winner === result.botColor),
      `Pair ${expectedPair} has an inconsistent winner flag`);
  }
}

function summarizeArmyResults(pairResults, options, completion) {
  const flattened = pairResults.flatMap(pair => pair.legs);
  const candidateWins = flattened.filter(result => result.botWon).length;
  const completedPairs = pairResults.length;
  const completedGames = flattened.length;
  const pairScores = pairResults.map(pair => pair.candidateWins / 2);
  const pairedSuccesses = pairScores.reduce((sum, score) => sum + score, 0);
  const observedWinRate = completedGames > 0 ? candidateWins / completedGames : 0;
  const gameWilson95 = wilsonInterval(candidateWins, completedGames);
  const pairedWilson95 = wilsonInterval(pairedSuccesses, completedPairs);
  const pairedHoeffding95 = boundedPairInterval(pairedSuccesses, completedPairs);
  const checks = {
    runComplete: Boolean(completion.complete),
    minimumGamesMet: completedGames >= options.minimumGames,
    observedThresholdMet: observedWinRate >= options.targetWinRate,
    pairedHoeffdingLowerThresholdMet: pairedHoeffding95.lower >= options.targetWinRate,
  };
  const passed = Object.values(checks).every(Boolean);
  let verdict = 'failed';
  let reason = 'observed-below-target';
  if (!checks.runComplete) reason = 'run-incomplete';
  else if (!checks.minimumGamesMet) reason = 'minimum-games-not-met';
  else if (!checks.observedThresholdMet) reason = 'observed-below-target';
  else if (!checks.pairedHoeffdingLowerThresholdMet) {
    verdict = 'not-certified';
    reason = 'confidence-below-target';
  } else {
    verdict = 'certified';
    reason = 'target-certified';
  }
  return {
    requestedPairs: options.pairs,
    completedPairs,
    requestedGames: options.pairs * 2,
    completedGames,
    minimumGames: options.minimumGames,
    candidateWins,
    controlWins: completedGames - candidateWins,
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
    checks,
    verdict,
    reason,
    passed,
  };
}

function aggregateArmyReports({ options, identity, assignments, shardReports, workerFailures = [] }) {
  assertCondition(options.sidecarAnalysis === undefined || typeof options.sidecarAnalysis === 'boolean',
    'Army sidecar analysis flag must be a native boolean');
  const integrityErrors = [];
  const reportByShard = new Map();
  for (const report of shardReports) {
    if (!report || !Number.isSafeInteger(report.shardId) || reportByShard.has(report.shardId)) {
      integrityErrors.push('A shard report is missing a unique shardId');
      continue;
    }
    reportByShard.set(report.shardId, report);
  }
  const expectedShardIds = new Set(assignments.map(assignment => assignment.shardId));
  for (const shardId of reportByShard.keys()) {
    if (!expectedShardIds.has(shardId)) {
      integrityErrors.push(`Unexpected shard report ${shardId}`);
    }
  }

  const resultByPair = new Map();
  for (const assignment of assignments) {
    const report = reportByShard.get(assignment.shardId);
    if (!report) {
      integrityErrors.push(`Shard ${assignment.shardId} did not produce a report`);
      continue;
    }
    if (report.completed !== true) {
      integrityErrors.push(`Shard ${assignment.shardId} is not marked complete`);
    }
    if (!sameJson(report.pairIndices, assignment.pairIndices)) {
      integrityErrors.push(`Shard ${assignment.shardId} returned different pair indices`);
    }
    if (report.seed !== options.seed) {
      integrityErrors.push(`Shard ${assignment.shardId} returned a different base seed`);
    }
    if (!sameJson(report.resources, options.resources)) {
      integrityErrors.push(`Shard ${assignment.shardId} used a different resource budget`);
    }
    // These fields describe methodology, not the playing policy. Do not count
    // outcomes from another ledger mode or another harness implementation.
    if (report.sidecarAnalysis !== (options.sidecarAnalysis === true)) {
      integrityErrors.push(`Shard ${assignment.shardId} used a different sidecar analysis flag`);
      continue;
    }
    if (typeof identity.harnessSourceFingerprint !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(identity.harnessSourceFingerprint)
      || report.harnessSourceFingerprint !== identity.harnessSourceFingerprint) {
      integrityErrors.push(`Shard ${assignment.shardId} used a different harness source fingerprint`);
      continue;
    }
    if (report.candidate?.runtimeFingerprint !== identity.candidate.runtimeFingerprint
      || report.candidate?.engineVersion !== identity.candidate.engineVersion) {
      integrityErrors.push(`Shard ${assignment.shardId} used a different candidate runtime`);
    }
    if (report.control?.runtimeFingerprint !== identity.control.runtimeFingerprint
      || report.control?.engineVersion !== identity.control.engineVersion) {
      integrityErrors.push(`Shard ${assignment.shardId} used a different control runtime`);
    }
    if (!Array.isArray(report.results)) {
      integrityErrors.push(`Shard ${assignment.shardId} has no result array`);
      continue;
    }
    const expectedPairs = new Set(assignment.pairIndices);
    for (const pairIndex of assignment.pairIndices) {
      const pair = report.results.filter(result => result?.pair === pairIndex + 1);
      try {
        validatePairResults(pair, pairIndex, options.seed, options.sidecarAnalysis === true);
      } catch (error) {
        integrityErrors.push(`Shard ${assignment.shardId}: ${error.message}`);
        continue;
      }
      if (resultByPair.has(pairIndex)) {
        integrityErrors.push(`Pair ${pairIndex + 1} was returned by more than one shard`);
        continue;
      }
      resultByPair.set(pairIndex, pair.sort((left, right) => left.leg - right.leg));
    }
    for (const result of report.results) {
      const pairIndex = Number(result?.pair) - 1;
      if (!expectedPairs.has(pairIndex)) {
        integrityErrors.push(`Shard ${assignment.shardId} returned unassigned pair ${result?.pair}`);
      }
    }
  }

  const expectedPairIndices = assignments.flatMap(assignment => assignment.pairIndices);
  if (expectedPairIndices.length !== options.pairs
    || new Set(expectedPairIndices).size !== options.pairs
    || expectedPairIndices.some(index => index < 0 || index >= options.pairs)) {
    integrityErrors.push('Coordinator shard assignments do not cover each requested pair exactly once');
  }
  const pairResults = [...resultByPair.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pairIndex, legs]) => {
      const candidateWins = legs.filter(result => result.botWon).length;
      return {
        pairIndex,
        pair: pairIndex + 1,
        streamSeeds: diceStreamSeeds(options.seed, pairIndex),
        candidateWins,
        outcome: candidateWins === 2 ? 'candidate-sweep' : candidateWins === 1 ? 'split' : 'control-sweep',
        legs,
      };
    });
  if (new Set(pairResults.flatMap(pair => pair.legs.map(result => productionWeightsKey(result)))).size > 1) {
    integrityErrors.push('League production weights differ between completed pairs');
  }
  const complete = workerFailures.length === 0
    && integrityErrors.length === 0
    && pairResults.length === options.pairs;
  const stopReason = workerFailures.length > 0
    ? 'worker-failure'
    : integrityErrors.length > 0
      ? 'integrity-failure'
      : complete
        ? 'requested-pairs-completed'
        : 'incomplete-results';
  const completion = {
    complete,
    stopReason,
    requestedPairs: options.pairs,
    completedPairs: pairResults.length,
    requestedGames: options.pairs * 2,
    completedGames: pairResults.length * 2,
    workerFailures,
    integrityErrors,
  };
  const summary = summarizeArmyResults(pairResults, options, completion);
  return {
    schemaVersion: 1,
    methodology: {
      independentUnit: 'paired-color-swapped-match',
      legsPerPair: 2,
      dice: 'deterministic global pair index; identical color-bound streams in both legs',
      resources: 'identical profile, node budget and candidate cap for candidate and control',
      policyDispatch: 'frozen strong-bot.js production dispatch on both sides; identical finite stable weights; no fallbacks',
      sidecarAnalysis: options.sidecarAnalysis === true,
      analysisLedger: options.sidecarAnalysis === true
        ? 'candidate decisions held in sidecar during play; complete ledger restored after terminal before export'
        : 'candidate decisions retained on working state during play (legacy default)',
      externalExperience: 'disabled-for-both',
      confidenceInterval: 'Hoeffding 95% bound for independent bounded pair scores; Wilson is diagnostic only',
      passRule: 'complete run, minimum games, observed rate and paired Hoeffding lower bound must all meet target',
    },
    candidate: identity.candidate,
    control: identity.control,
    sameRuntimeFingerprint: identity.candidate.runtimeFingerprint
      === identity.control.runtimeFingerprint,
    resources: { ...options.resources },
    harnessSourceFingerprint: identity.harnessSourceFingerprint,
    seed: options.seed,
    army: {
      requestedWorkers: options.workers,
      activeWorkers: assignments.length,
      shards: assignments.map(assignment => ({
        shardId: assignment.shardId,
        pairIndices: [...assignment.pairIndices],
        sidecarAnalysis: options.sidecarAnalysis === true,
        harnessSourceFingerprint: identity.harnessSourceFingerprint,
      })),
    },
    completion,
    summary,
    pairs: pairResults,
  };
}

function materializeSnapshot(snapshot, directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [filename, bytes] of snapshot.entries) {
    assertCondition(!filename.includes('/') && !filename.includes('\\'),
      `Unsafe runtime snapshot filename: ${filename}`);
    fs.writeFileSync(path.join(directory, filename), bytes, { flag: 'wx' });
  }
}

function spawnShard(configPath, outputPath) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [WORKER, configPath, outputPath], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('error', error => resolve({
      ok: false,
      exitCode: null,
      signal: null,
      error: error.message,
      stderr,
    }));
    child.on('close', (exitCode, signal) => resolve({
      ok: exitCode === 0 && !signal,
      exitCode,
      signal,
      stderr: stderr.trim(),
    }));
  });
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

async function runArmy(options) {
  assertCondition(options.sidecarAnalysis === undefined || typeof options.sidecarAnalysis === 'boolean',
    'Army sidecar analysis flag must be a native boolean');
  validateDerivedStreamSeeds([options.seed], options.pairs);
  const assignments = partitionPairIndices(options.pairs, options.workers);
  const candidateSnapshot = {
    ...readRuntimeDirectory(options.candidateRuntimeDirectory),
    source: { kind: 'directory', directory: options.candidateRuntimeDirectory },
  };
  const controlSnapshot = controlSnapshotFor(options);
  // Validate engine identity and rules equality before spending any worker time.
  const validatedRuntime = buildRuntimeLeague(
    candidateSnapshot,
    controlSnapshot,
    options.expectedControlVersion,
    options.expectedCandidateVersion,
  );
  const identity = {
    harnessSourceFingerprint: leagueHarnessFingerprint(),
    candidate: {
      engineVersion: validatedRuntime.candidate.engine.version,
      runtimeFingerprint: candidateSnapshot.fingerprint,
      source: candidateSnapshot.source,
    },
    control: {
      engineVersion: validatedRuntime.control.engine.version,
      runtimeFingerprint: controlSnapshot.fingerprint,
      source: controlSnapshot.source,
    },
  };

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-army-'));
  const candidateDirectory = path.join(temporaryRoot, 'candidate');
  const controlDirectory = path.join(temporaryRoot, 'control');
  const shardReports = [];
  const workerFailures = [];
  try {
    materializeSnapshot(candidateSnapshot, candidateDirectory);
    materializeSnapshot(controlSnapshot, controlDirectory);
    const jobs = assignments.map(assignment => {
      const configPath = path.join(temporaryRoot, `shard-${assignment.shardId}.config.json`);
      const outputPath = path.join(temporaryRoot, `shard-${assignment.shardId}.result.json`);
      const config = {
        shardId: assignment.shardId,
        pairIndices: assignment.pairIndices,
        candidateRuntimeDirectory: candidateDirectory,
        controlRuntimeDirectory: controlDirectory,
        expectedControlVersion: options.expectedControlVersion,
        expectedCandidateVersion: options.expectedCandidateVersion,
        resources: options.resources,
        sidecarAnalysis: options.sidecarAnalysis === true,
        harnessSourceFingerprint: identity.harnessSourceFingerprint,
        options: {
          pairs: options.pairs,
          seed: options.seed,
          targetWinRate: options.targetWinRate,
          trace: options.trace,
          sidecarAnalysis: options.sidecarAnalysis === true,
        },
      };
      writeJsonAtomic(configPath, config);
      return { assignment, configPath, outputPath };
    });
    const statuses = await Promise.all(jobs.map(job => spawnShard(job.configPath, job.outputPath)));
    for (let index = 0; index < jobs.length; index += 1) {
      const { assignment, outputPath } = jobs[index];
      const status = statuses[index];
      if (!status.ok) {
        workerFailures.push({
          shardId: assignment.shardId,
          exitCode: status.exitCode,
          signal: status.signal,
          error: status.error || '',
          stderr: status.stderr,
        });
        continue;
      }
      try {
        shardReports.push(JSON.parse(fs.readFileSync(outputPath, 'utf8')));
      } catch (error) {
        workerFailures.push({
          shardId: assignment.shardId,
          exitCode: status.exitCode,
          signal: status.signal,
          error: `Could not read worker report: ${error.message}`,
          stderr: status.stderr,
        });
      }
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return aggregateArmyReports({
    options,
    identity,
    assignments,
    shardReports,
    workerFailures,
  });
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const payload = await runArmy(options);
  if (options.output) writeJsonAtomic(options.output, payload);
  process.stdout.write(`${JSON.stringify({
    candidate: payload.candidate,
    control: payload.control,
    resources: payload.resources,
    seed: payload.seed,
    army: payload.army,
    completion: payload.completion,
    summary: payload.summary,
  })}\n`);
  if (!payload.summary.passed) process.exitCode = payload.completion.complete ? 1 : 2;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  aggregateArmyReports,
  parseOptions,
  partitionPairIndices,
  runArmy,
  summarizeArmyResults,
  validatePairResults,
};
