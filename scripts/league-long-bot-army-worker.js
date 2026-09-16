#!/usr/bin/env node

/*
 * Internal worker for league-long-bot-army.js.
 *
 * The coordinator materializes immutable candidate/control runtime snapshots
 * before any worker starts. A worker receives only a deterministic list of
 * global pair indices and plays both color-swapped legs for every pair.
 */

const fs = require('node:fs');

const {
  buildRuntimeLeague,
  leagueHarnessFingerprint,
  playLeaguePairs,
  readRuntimeDirectory,
  writeJsonAtomic,
} = require('./league-long-bot-frozen-runtime');

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function validateWorkerConfig(config) {
  assertCondition(config && typeof config === 'object', 'Worker config must be an object');
  assertCondition(Number.isSafeInteger(config.shardId) && config.shardId >= 0,
    'Worker shardId must be a non-negative safe integer');
  assertCondition(Array.isArray(config.pairIndices) && config.pairIndices.length > 0,
    'Worker pairIndices must be a non-empty array');
  assertCondition(new Set(config.pairIndices).size === config.pairIndices.length,
    'Worker pairIndices contain duplicates');
  assertCondition(config.pairIndices.every(index => Number.isSafeInteger(index) && index >= 0),
    'Worker pairIndices must contain non-negative safe integers');
  assertCondition(config.options && typeof config.options === 'object',
    'Worker options must be an object');
  assertCondition(typeof config.sidecarAnalysis === 'boolean'
    && config.options.sidecarAnalysis === config.sidecarAnalysis,
  'Worker sidecar analysis flags must be identical native booleans');
  assertCondition(typeof config.harnessSourceFingerprint === 'string'
    && /^sha256:[0-9a-f]{64}$/.test(config.harnessSourceFingerprint),
    'Worker harness source fingerprint is required');
  assertCondition(config.resources && typeof config.resources === 'object',
    'Worker resources must be an object');
  assertCondition(typeof config.candidateRuntimeDirectory === 'string',
    'Worker candidate runtime directory is required');
  assertCondition(typeof config.controlRuntimeDirectory === 'string',
    'Worker control runtime directory is required');
  assertCondition(typeof config.expectedControlVersion === 'string',
    'Worker expected control version is required');
  assertCondition(typeof config.expectedCandidateVersion === 'string',
    'Worker expected candidate version is required');
}

function runWorker(config) {
  validateWorkerConfig(config);
  assertCondition(config.harnessSourceFingerprint === leagueHarnessFingerprint(),
    'Worker harness source fingerprint differs from the coordinator');
  const candidateSnapshot = {
    ...readRuntimeDirectory(config.candidateRuntimeDirectory),
    source: { kind: 'materialized-snapshot', role: 'candidate' },
  };
  const controlSnapshot = {
    ...readRuntimeDirectory(config.controlRuntimeDirectory),
    source: { kind: 'materialized-snapshot', role: 'control' },
  };
  const runtime = buildRuntimeLeague(
    candidateSnapshot,
    controlSnapshot,
    config.expectedControlVersion,
    config.expectedCandidateVersion,
  );
  const leagueOptions = {
    pairs: config.options.pairs,
    seed: config.options.seed,
    targetWinRate: config.options.targetWinRate,
    resources: { ...config.resources },
    trace: Boolean(config.options.trace),
    sidecarAnalysis: config.sidecarAnalysis,
  };
  const results = playLeaguePairs(runtime, leagueOptions, config.pairIndices);
  return {
    schemaVersion: 1,
    shardId: config.shardId,
    pairIndices: [...config.pairIndices],
    completed: true,
    seed: leagueOptions.seed,
    resources: { ...leagueOptions.resources },
    sidecarAnalysis: config.sidecarAnalysis,
    harnessSourceFingerprint: leagueHarnessFingerprint(),
    candidate: {
      engineVersion: runtime.candidate.engine.version,
      runtimeFingerprint: candidateSnapshot.fingerprint,
    },
    control: {
      engineVersion: runtime.control.engine.version,
      runtimeFingerprint: controlSnapshot.fingerprint,
    },
    results,
  };
}

function main() {
  const [, , configPath, outputPath] = process.argv;
  if (!configPath || !outputPath || process.argv.length !== 4) {
    throw new Error('Usage: league-long-bot-army-worker.js <config.json> <output.json>');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  writeJsonAtomic(outputPath, runWorker(config));
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
  runWorker,
  validateWorkerConfig,
};
