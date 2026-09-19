#!/usr/bin/env node
'use strict';

// Trusted repository child only. Inputs are bounded model/rule data, never code.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const legacy = require('./train-long-bot-neural');
const JOB_SCHEMA = 'long-neural-v2-episode-job-v1';
const RESULT_SCHEMA = 'long-neural-v2-episode-result-v1';
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const { clone, canonical, fingerprint, integer } = legacy;
function check(condition, message) { if (!condition) throw new Error(message); }
function createJob(input) {
  const trainer = require('./train-long-bot-neural-v2');
  const job = { schema: JOB_SCHEMA, sourceFingerprints: trainer.sourceFingerprints(),
    modelFingerprint: legacy.modelFingerprint(input.model), ...input };
  validateJob(job);
  return job;
}
function validateJob(job) {
  const trainer = require('./train-long-bot-neural-v2');
  check(job && job.schema === JOB_SCHEMA && ['candidate-v2', 'legacy-448-control'].includes(job.candidatePolicy)
    && ['self', 'random', 'pip', 'greedy', 'current-hard', 'legacy-neuro'].includes(job.opponent)
    && ['white', 'dark'].includes(job.candidateColor), 'Unsupported trusted episode job');
  check(Object.keys(job).every(key => ['schema', 'sourceFingerprints', 'modelFingerprint', 'model',
    'candidatePolicy', 'opponent', 'candidateColor', 'seeds', 'policySeed', 'policyOptions',
    'maxPlies', 'maxGameMs', 'initialState'].includes(key)), 'Unexpected trusted episode job fields');
  legacy.neuralApi().validateModel(job.model);
  check(legacy.modelFingerprint(job.model) === job.modelFingerprint
    && canonical(job.sourceFingerprints) === canonical(trainer.sourceFingerprints()), 'Episode source/model provenance mismatch');
  integer('worker maxPlies', job.maxPlies, 1, 4096); integer('worker maxGameMs', job.maxGameMs, 1, 3600000);
  integer('worker policy seed', job.policySeed, 1, 0xffffffff);
  check(job.seeds && job.seeds.white !== job.seeds.dark, 'Episode seat-bound streams collide');
  for (const color of ['white', 'dark']) integer('worker dice seed', job.seeds[color], 1, 0xffffffff);
  check(canonical(job.policyOptions) === canonical(trainer.searchApi().options(job.policyOptions)), 'Episode search policy options mismatch');
  if (job.initialState) {
    legacy.neuralApi().validateState(job.initialState);
    check(job.initialState.phase === 'opening' && job.initialState.turn === null && !job.initialState.winner,
      'Fixture position must start a complete opening, never a fabricated terminal result');
  }
  return job;
}
function executeTrustedJob(job) {
  validateJob(job);
  const trainer = require('./train-long-bot-neural-v2'); const evaluator = require('./evaluate-long-bot-neural');
  const runtime = legacy.loadLongGame(); const api = legacy.neuralApi(); const policy = trainer.searchApi();
  const frozen = clone(job.model); const before = legacy.modelFingerprint(frozen);
  const baseline = trainer.loadWarmStart().model;
  const candidate = job.candidatePolicy === 'candidate-v2'
    ? trainer.monitoredPolicy(policy.createNeuralBot(runtime.game, frozen, job.policyOptions), job.policyOptions)
    : api.createNeuralBot(runtime.game, baseline, { maxCandidates: 16, epsilon: 0 });
  const opponent = job.opponent === 'self'
    ? trainer.monitoredPolicy(policy.createNeuralBot(runtime.game, frozen, job.policyOptions), job.policyOptions)
    : job.opponent === 'current-hard' ? evaluator.createCurrentHard(evaluator.readCurrentHardSnapshot())
      : job.opponent === 'legacy-neuro' ? api.createNeuralBot(runtime.game, baseline, { maxCandidates: 16, epsilon: 0 })
        : legacy.createBaseline(runtime.game, job.opponent, legacy.seededRandom(job.policySeed), job.policyOptions.maxCandidates);
  // The data-only fixture entry is for deterministic bounded rule tests. Normal
  // CLI jobs omit it and always start all fifteen checkers on their heads.
  const game = job.initialState ? { ...runtime.game, initialState: () => clone(job.initialState) } : runtime.game;
  const episode = legacy.playEpisode({ game, candidate, opponent, candidateColor: job.candidateColor,
    seeds: job.seeds, maxPlies: job.maxPlies, maxGameMs: job.maxGameMs, collectTraining: true });
  check(legacy.modelFingerprint(frozen) === before && legacy.modelFingerprint(baseline) === trainer.BASELINE_MODEL,
    'Frozen episode weights changed in child');
  trainer.terminalStateForEpisode(episode, runtime.game);
  return { episode,
    ...(candidate.coverage ? { searchCoverage: clone(candidate.coverage) } : {}),
    ...(job.opponent === 'self' ? { selfOpponentSearchCoverage: clone(opponent.coverage) } : {}),
    ...(job.opponent === 'current-hard' ? { hardMetadata: clone(opponent.metadata) } : {}) };
}
function runEpisodeInWorker(job, { spawn = spawnSync } = {}) {
  validateJob(job);
  const input = JSON.stringify(job);
  check(Buffer.byteLength(input) <= MAX_INPUT_BYTES, 'Episode worker input exceeds byte limit');
  const requestFingerprint = fingerprint(job);
  const output = spawn(process.execPath, [path.join(__dirname, 'long-neural-v2-episode-worker.js')], {
    input, encoding: 'utf8', timeout: job.maxGameMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES,
    cwd: legacy.ROOT, env: { PATH: process.env.PATH || '', LANG: 'C', TZ: 'UTC' },
  });
  if (output.error?.code === 'ETIMEDOUT' || output.signal === 'SIGKILL') {
    throw new Error('Censored game exceeded parent process watchdog; own child terminated, no result or learning credit');
  }
  check(!output.error && output.status === 0 && typeof output.stdout === 'string'
    && Buffer.byteLength(output.stdout) <= MAX_OUTPUT_BYTES, 'Trusted episode child failed or exceeded output limit');
  let response;
  try { response = JSON.parse(output.stdout); } catch { throw new Error('Trusted episode child returned invalid JSON'); }
  const { resultFingerprint, ...body } = response;
  check(response.schema === RESULT_SCHEMA && response.requestFingerprint === requestFingerprint
    && canonical(response.sourceFingerprints) === canonical(job.sourceFingerprints)
    && resultFingerprint === fingerprint(body), 'Trusted episode child response provenance mismatch');
  if (!response.ok) {
    check(response.censored === true && /^Censored game (?:exceeded|has no terminal)/.test(response.reason),
      'Trusted episode child returned an unverified failure');
    throw new Error(response.reason);
  }
  check(response.result && response.result.episode.completed === true, 'Trusted episode child omitted terminal result');
  const trainer = require('./train-long-bot-neural-v2');
  trainer.terminalStateForEpisode(response.result.episode, legacy.loadLongGame().game);
  return response.result;
}
function main() {
  const bytes = fs.readFileSync(0);
  check(bytes.length <= MAX_INPUT_BYTES, 'Episode worker input exceeds byte limit');
  const job = JSON.parse(bytes.toString('utf8')); validateJob(job);
  let body;
  try { body = { schema: RESULT_SCHEMA, requestFingerprint: fingerprint(job),
    sourceFingerprints: job.sourceFingerprints, ok: true, result: executeTrustedJob(job) }; }
  catch (error) {
    if (!/^Censored game (?:exceeded|has no terminal)/.test(error.message)) throw error;
    body = { schema: RESULT_SCHEMA, requestFingerprint: fingerprint(job), sourceFingerprints: job.sourceFingerprints,
      ok: false, censored: true, reason: error.message };
  }
  const text = JSON.stringify({ ...body, resultFingerprint: fingerprint(body) });
  check(Buffer.byteLength(text) <= MAX_OUTPUT_BYTES, 'Episode worker output exceeds byte limit');
  process.stdout.write(text);
}
module.exports = { JOB_SCHEMA, RESULT_SCHEMA, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES,
  createJob, validateJob, executeTrustedJob, runEpisodeInWorker, main };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
