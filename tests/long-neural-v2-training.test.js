'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const legacy = require('../scripts/train-long-bot-neural');
const trainer = require('../scripts/train-long-bot-neural-v2');
const evaluator = require('../scripts/evaluate-long-bot-neural-v2');
const teacher = require('../scripts/build-long-neural-v2-teacher');
const worker = require('../scripts/long-neural-v2-episode-worker');

const POLICY = { maxCandidates: 8, replyTopCandidates: 2, replyCandidates: 2, replyWeight: 0 };
function lateRaceEpisode(options) {
  // Actual captured long-narde rules and actual terminal play, with a late-race
  // start only to bound test CPU. No synthetic wins/censored learning credit.
  const original = options.game;
  const game = { ...original, initialState(variant) {
    const state = original.initialState(variant);
    state.points = { 6: { color: 'white', count: 7 }, 18: { color: 'dark', count: 7 } };
    state.off = { white: 8, dark: 8 };
    state.firstMoveDone = { white: true, dark: true };
    return state;
  } };
  return legacy.playEpisode({ ...options, game });
}
function resign(value) {
  const result = legacy.clone(value); delete result.artifactFingerprint;
  result.artifactFingerprint = legacy.fingerprint(result);
  return result;
}
let protocol; let artifact;
test.before(() => {
  protocol = evaluator.createProtocol({ developmentPairs: 2, opponents: ['pip', 'greedy'],
    policyOptions: trainer.searchApi().options(POLICY), maxElapsedMs: 60000 });
  artifact = trainer.runTraining({ games: 2, seed: 539363608, policyOptions: POLICY,
    maxElapsedMs: 60000, opponents: ['self', 'pip'], replayGames: 4, replaySamples: 8,
    benchmarkProtocol: protocol,
    forbiddenDiceStreams: evaluator.protocolReservations(protocol) }, { playEpisode: lateRaceEpisode });
});

test('V2 pinned warm start keeps historical rule/counter provenance separate', () => {
  const warm = trainer.loadWarmStart();
  assert.equal(warm.origin.historicalGames, 448);
  assert.equal(warm.origin.historicalTrainingSteps, 35147);
  assert.equal(warm.origin.rulesFingerprint, trainer.BASELINE_RULES);
  assert.notEqual(artifact.runtimeFingerprint, warm.origin.rulesFingerprint);
  assert.equal(legacy.modelFingerprint(warm.model), trainer.BASELINE_MODEL);
  const altered = JSON.parse(fs.readFileSync(path.join(legacy.ROOT, 'vendor/long-neural/model.json'), 'utf8'));
  altered.model.outputBias += 0.01;
  assert.throws(() => trainer.loadWarmStart(altered), /weights\/counters differ/);
  altered.model = legacy.clone(warm.model); altered.metadata.trainingGames = 0;
  assert.throws(() => trainer.loadWarmStart(altered), /historical provenance mismatch/);
});

test('actual terminal episodes and balanced past replay update new counters only', () => {
  assert.equal(artifact.schema, trainer.SCHEMA);
  assert.equal(artifact.productionEligible, false);
  assert.equal(artifact.counters.newCompletedGames, 2);
  assert.equal(artifact.origin.historicalGames, 448);
  assert.equal(artifact.counters.newTeacherTrainingSteps, 0);
  assert.equal(artifact.results[0].replayTrainingSamples, 0);
  assert.equal(artifact.results[1].replayTrainingSamples, 8);
  assert.equal(artifact.model.trainingSteps, 35147 + artifact.counters.newTrainingSteps);
  assert.equal(trainer.validateArtifact(artifact).games, 2);
  assert(artifact.results.every(result => result.completed && result.traceFingerprint));
  assert(artifact.results.every(result => result.searchCoverage.evaluatedPositions === result.searchCoverage.uniqueLegalPositions));
  assert.notEqual(artifact.modelFingerprint, trainer.BASELINE_MODEL);
});

test('V2 seed/gradient lineage reproducible; exact-source resume retains experience', () => {
  const options = { ...artifact.segments[0].options, benchmarkProtocol: protocol };
  const repeated = trainer.runTraining(options, { playEpisode: lateRaceEpisode });
  assert.equal(repeated.modelFingerprint, artifact.modelFingerprint);
  assert.deepEqual(repeated.results, artifact.results);
  assert.deepEqual(repeated.counters, artifact.counters);
  const resumed = trainer.runTraining({ ...options, games: 1, resumeArtifact: artifact }, { playEpisode: lateRaceEpisode });
  assert.equal(resumed.origin.historicalGames, 448);
  assert.equal(resumed.counters.newCompletedGames, 3);
  assert.equal(resumed.segments[1].streamIndexStart, 2);
  assert.equal(resumed.results[2].replayTrainingSamples, 8);
  assert.equal(trainer.validateArtifact(resumed).games, 3);
  assert.throws(() => trainer.runTraining({ ...options, resumeArtifact: artifact, replayGames: 0 }), /cannot be silently discarded/);
});

test('censored games receive no win, native sample, replay or completed-game credit', () => {
  const censored = trainer.runTraining({ games: 2, seed: 19, maxPlies: 1, policyOptions: POLICY,
    opponents: ['self'], maxElapsedMs: 60000 }, { playEpisode: lateRaceEpisode });
  assert.equal(censored.counters.newCompletedGames, 0);
  assert.equal(censored.counters.newTrainingSteps, 0);
  assert.equal(censored.modelFingerprint, trainer.BASELINE_MODEL);
  assert.equal(censored.trainingStatus.complete, false);
  assert.equal(censored.trainingStatus.censoredGames, 1);
  assert.equal(censored.results.length, 0);
  assert.equal(trainer.validateArtifact(censored).games, 0);
  const resumed = trainer.runTraining({ games: 1, seed: 19, policyOptions: POLICY, resumeArtifact: censored,
    opponents: ['self'], maxElapsedMs: 60000 }, { playEpisode: lateRaceEpisode });
  assert.equal(resumed.segments[1].streamIndexStart, 2, 'censored requested streams remain consumed on resume');
  assert.equal(resumed.counters.newCompletedGames, 1);
  assert.throws(() => trainer.runTraining({ games: 1, policyOptions: POLICY, resumeArtifact: censored,
    benchmarkProtocol: protocol }), /retroactively/);
});

test('illegal/fallback failures remain errors, with only prior completed checkpoints', () => {
  assert.throws(() => trainer.runTraining({ games: 1, policyOptions: POLICY }, {
    playEpisode() { throw new Error('current-hard produced a fallback/unverified decision'); },
  }), error => {
    assert.match(error.message, /fallback/);
    assert.equal(error.completedArtifact.counters.newCompletedGames, 0);
    assert.equal(error.completedArtifact.modelFingerprint, trainer.BASELINE_MODEL);
    return true;
  });
});

test('verified teacher preferences have separate surrogate provenance, never match/win credit', () => {
  const runtime = legacy.loadLongGame();
  const modelArtifact = JSON.parse(fs.readFileSync(path.join(legacy.ROOT, 'vendor/long-neural/model.json'), 'utf8'));
  const before = runtime.game.initialState('long');
  Object.assign(before, { points: { 8: { color: 'white', count: 1 }, 7: { color: 'white', count: 1 },
    6: { color: 'white', count: 1 }, 5: { color: 'white', count: 1 }, 12: { color: 'dark', count: 15 } },
  off: { white: 11, dark: 0 }, turn: 'white', phase: 'move', dice: [2, 4], rolled: [2, 4],
  firstMoveDone: { white: true, dark: true } });
  const selected = [{ from: 8, die: 4 }, { from: 4, die: 2 }];
  const after = legacy.clone(before); legacy.applyPlan(runtime.game, after, selected); runtime.game.endTurn(after);
  const input = { schema: teacher.INPUT_SCHEMA, rooms: [{ variant: 'long', roomCode: 'TEST-A123',
    botColor: 'white', playerColor: 'dark', winner: 'dark', resultType: 'koks',
    final: { points: { 24: { color: 'white', count: 15 } }, off: { white: 0, dark: 15 }, phase: 'over', winner: 'dark' },
    neuralModel: modelArtifact.metadata, decisions: [{ schema: 'nardu-neural-decision-v1', before, selected,
      diagnostics: { policy: 'hard-neuro', modelFingerprint: trainer.BASELINE_MODEL },
      execution: { complete: true, executedMoves: selected, after } }] }] };
  const corpus = teacher.buildTeacherCorpus(input);
  const samples = teacher.createTrainingSamples(corpus);
  assert(samples.length > 0);
  const trained = trainer.runTraining({ games: 1, seed: 37, maxPlies: 1, policyOptions: POLICY,
    teacherCorpus: corpus, teacherEpochs: 2, opponents: ['self'] }, { playEpisode: lateRaceEpisode });
  assert.equal(trained.counters.newCompletedGames, 0);
  assert.equal(trained.counters.newNativeTrainingSteps, 0);
  assert.equal(trained.counters.newReplayTrainingSteps, 0);
  assert.equal(trained.counters.newTeacherTrainingSteps, samples.length * 2);
  assert.equal(trained.model.trainingSteps, 35147 + samples.length * 2);
  assert.equal(trained.segments[0].teacher.targetKind, teacher.TARGET_KIND);
  assert.equal(trained.segments[0].teacher.evidence, 'current-rules-replayed-heuristic-preference-not-causal-outcome');
  assert.equal(trainer.validateArtifact(trained).games, 0);
  const forged = legacy.clone(corpus); forged.summary.authenticatedMatches = 1;
  assert.throws(() => trainer.runTraining({ games: 1, policyOptions: POLICY, teacherCorpus: forged }), /fingerprint/);
});

test('V2 validator rejects modified counters, source provenance, replay states and labels', () => {
  let bad = legacy.clone(artifact); bad.counters.newCompletedGames += 448;
  assert.throws(() => trainer.validateArtifact(resign(bad)), /counters were conflated/);
  bad = legacy.clone(artifact); bad.sourceFingerprints['lib/long-bot-neural-v2.js'] = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => trainer.validateArtifact(resign(bad)), /source bytes changed/);
  bad = legacy.clone(artifact); bad.origin.rulesFingerprint = artifact.runtimeFingerprint;
  assert.throws(() => trainer.validateArtifact(resign(bad)), /historical origin mismatch/);
  bad = legacy.clone(artifact); bad.results[0].experienceLeaves[0].target = 1 - bad.results[0].experienceLeaves[0].target;
  assert.throws(() => trainer.validateArtifact(resign(bad)), /leaf origin mismatch/);
  bad = legacy.clone(artifact); bad.experienceReplay.games[0].samples[0].state.off.white = 0;
  assert.throws(() => trainer.validateArtifact(resign(bad)), /terminal cache source mismatch/);
  bad = legacy.clone(artifact); bad.results[1].replaySources[0].game = 2;
  assert.throws(() => trainer.validateArtifact(resign(bad)), /eligible past completed/);
  bad = legacy.clone(artifact); bad.results[0].resultType = 'koks';
  assert.throws(() => trainer.validateArtifact(resign(bad)), /terminal result differs/);
  bad = legacy.clone(artifact); bad.trainingStatus.complete = false;
  assert.throws(() => trainer.validateArtifact(resign(bad)), /training status differs/);
  bad = legacy.clone(artifact); bad.segments[0].status = 'partial-no-gate';
  assert.throws(() => trainer.validateArtifact(resign(bad)), /completion\/censor status/);
  bad = legacy.clone(artifact); bad.results[0].candidateColor = 'dark';
  assert.throws(() => trainer.validateArtifact(resign(bad)), /completed episode provenance/);
  bad = legacy.clone(artifact); bad.results[0].searchCoverage.evaluatedPositions -= 1;
  assert.throws(() => trainer.validateArtifact(resign(bad)), /counts are impossible/);
});

test('a final winning plan that overruns its game deadline receives no credit', () => {
  function overrun(options) {
    const episode = lateRaceEpisode({ ...options, maxGameMs: 30000 });
    const deadline = Date.now() + 8;
    while (Date.now() < deadline) { /* bounded fixture cost after a real completed game */ }
    return episode;
  }
  const training = trainer.runTraining({ games: 1, seed: 53, maxGameMs: 1, maxElapsedMs: 60000,
    policyOptions: POLICY, opponents: ['self'] }, { playEpisode: overrun });
  assert.equal(training.counters.newCompletedGames, 0);
  assert.equal(training.counters.newTrainingSteps, 0);
  assert.equal(training.trainingStatus.censoredGames, 1);
  assert.match(training.segments[0].censoredAttempts[0].reason, /final winning plan/);
  const declared = evaluator.createProtocol({ ...protocol, maxGameMs: 1 });
  const bound = trainer.runTraining({ games: 1, seed: 59, policyOptions: POLICY,
    benchmarkProtocol: declared, opponents: ['self'] }, { playEpisode: lateRaceEpisode });
  const report = evaluator.runEvaluation(bound, { protocol: declared }, { playEpisode: overrun });
  assert.equal(report.summary.completedGames, 0);
  assert.equal(report.summary.censoredOrNotRunGames, 8);
});

test('predeclared development/confirmation streams are disjoint and policy-pinned', () => {
  const records = [...evaluator.protocolRecords(protocol, 'development-validation'),
    ...evaluator.protocolRecords(protocol, 'held-out-confirmation')];
  assert.equal(legacy.assertDisjointStreams(records, artifact.trainingDiceStreams), true);
  assert.equal(evaluator.protocolReservations(protocol).length, 136);
  const bad = legacy.clone(protocol); bad.confirmationSeed = bad.developmentSeed;
  assert.throws(() => evaluator.validateProtocol(bad), /overlap/);
  bad.confirmationSeed += 1; bad.trainingSourceFingerprints['game.js'] = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => evaluator.validateProtocol(bad), /source bytes changed/);
  assert.throws(() => evaluator.runEvaluation(artifact, { protocol, purpose: 'held-out-confirmation' }), /single-use journal/);
  const replacement = evaluator.createProtocol({ ...protocol, developmentPairs: 3 });
  assert.throws(() => evaluator.runEvaluation(artifact, { protocol: replacement }), /not bound before/);
  assert.throws(() => trainer.runTraining({ games: 1, policyOptions: POLICY, resumeArtifact: artifact,
    benchmarkProtocol: replacement }), /cannot replace/);
});

test('development evaluation is color paired, frozen, separate and cannot issue milestone', () => {
  const before = artifact.modelFingerprint;
  const report = evaluator.runEvaluation(artifact, { protocol }, { playEpisode: lateRaceEpisode });
  assert.equal(report.modelFingerprintAfterEvaluation, before);
  assert.equal(report.learningDuringEvaluation, false);
  assert.equal(report.summary.complete, true);
  assert.equal(report.summary.completedGames, 8);
  assert.equal(report.summary.strongPoolMilestonePassed, false);
  assert.equal(report.summary.productionEligible, false);
  assert(report.summary.opponents.every(group => group.completeIndependentPairs === 2));
  for (let index = 0; index < report.results.length; index += 2) {
    assert.deepEqual(report.results[index].streamSeeds, report.results[index + 1].streamSeeds);
    assert.equal(report.results[index].candidateColor, 'white');
    assert.equal(report.results[index + 1].candidateColor, 'dark');
  }
  assert.equal(trainer.validateArtifact(artifact).games, 2, 'evaluation cannot add training-game credit');
  assert.equal(evaluator.validateReport(report, artifact).completedGames, 8);
  const altered = legacy.clone(report); altered.learningDuringEvaluation = true;
  delete altered.reportFingerprint; altered.reportFingerprint = legacy.fingerprint(altered);
  assert.throws(() => evaluator.validateReport(altered, artifact), /frozen offline/);
  const inflated = legacy.clone(report); inflated.summary.strongPoolMilestonePassed = true;
  delete inflated.reportFingerprint; inflated.reportFingerprint = legacy.fingerprint(inflated);
  assert.throws(() => evaluator.validateReport(inflated, artifact), /recomputed complete paired coverage/);
});

test('evaluation reports censored coverage honestly, with no fabricated results/gate', () => {
  const report = evaluator.runEvaluation(artifact, { protocol }, {
    playEpisode() { throw new Error('Censored game exceeded wall-time budget; no result or learning credit'); },
  });
  assert.equal(report.results.length, 0);
  assert.equal(report.pending.length, 8);
  assert.equal(report.summary.completedGames, 0);
  assert.equal(report.summary.descriptiveWinRateOnCompletedGamesOnly, null);
  assert.equal(report.summary.complete, false);
  assert.equal(report.summary.strongPoolMilestonePassed, false);
  assert(report.summary.opponents.every(group => group.coverage === 0 && group.pairedConfidence === null));
});

test('current-hard control is exact frozen v35, and rehashed policy changes are rejected', () => {
  const declared = evaluator.createProtocol({ developmentPairs: 1, opponents: ['current-hard'],
    policyOptions: trainer.searchApi().options(POLICY), maxGameMs: 30000, maxElapsedMs: 60000 });
  const candidate = trainer.runTraining({ games: 1, seed: 47, policyOptions: POLICY,
    benchmarkProtocol: declared, opponents: ['self'], forbiddenDiceStreams: evaluator.protocolReservations(declared) }, { playEpisode: lateRaceEpisode });
  const report = evaluator.runEvaluation(candidate, { protocol: declared }, { playEpisode: lateRaceEpisode });
  assert.equal(report.summary.completedGames, 2);
  assert.equal(report.currentHard.engineVersion, 'long-analytic-v35');
  assert.equal(report.currentHard.experiencePatterns, 0);
  assert.equal(report.currentHard.learningDuringEvaluation, false);
  assert.equal(evaluator.validateReport(report, candidate).currentHardIncluded, true);
  const altered = legacy.clone(report); altered.currentHard.learningDuringEvaluation = true;
  delete altered.reportFingerprint; altered.reportFingerprint = legacy.fingerprint(altered);
  assert.throws(() => evaluator.validateReport(altered, candidate), /provenance changed or was unfrozen/);
});

test('exclusive confirmation journal is single-use even when every game is censored', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-neural-v2-confirmation-test-'));
  const journal = path.join(directory, 'confirmation.json');
  try {
    evaluator.writeExclusive(journal, { schema: 'long-neural-v2-single-confirmation-use-v1', status: 'reserved',
      protocolFingerprint: legacy.fingerprint(protocol), modelFingerprint: artifact.modelFingerprint,
      artifactFingerprint: artifact.artifactFingerprint });
    evaluator.runEvaluation(artifact, { protocol, purpose: 'held-out-confirmation', confirmationJournal: journal }, {
      playEpisode() { throw new Error('Censored game exceeded wall-time budget'); },
    });
    assert.equal(JSON.parse(fs.readFileSync(journal, 'utf8')).status, 'consumed');
    assert(fs.existsSync(`${journal}.claim.json`));
    assert.throws(() => evaluator.writeExclusive(journal, {}), /EEXIST/);
    assert.throws(() => evaluator.runEvaluation(artifact,
      { protocol, purpose: 'held-out-confirmation', confirmationJournal: journal }), /reused or mismatched/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('new harness files do not import network, mutate production, or publish legacy assets', () => {
  for (const file of ['scripts/train-long-bot-neural-v2.js', 'scripts/evaluate-long-bot-neural-v2.js']) {
    const source = fs.readFileSync(path.join(legacy.ROOT, file), 'utf8');
    assert.doesNotMatch(source, /https?:\/\/|\bfetch\(|\bssh\b|\bscp\b|SUPABASE|writeFileSync\([^,]*vendor/);
  }
  assert.throws(() => trainer.validateOfflineOutput(path.join(legacy.ROOT, 'vendor/long-neural/model.json')), /protected/);
  assert.throws(() => trainer.validateOfflineOutput(path.join(legacy.ROOT, 'game.js')), /JSON artifact/);
  assert.throws(() => trainer.validateOfflineOutput(path.join(legacy.ROOT, 'experiments/long-neural/model.json')), /protected/);
  assert.throws(() => trainer.teacherHelper('unverified-hard-memory'), /Unsupported/);
});

test('real CLI declares a source-pinned protocol and trains a zero-credit censored candidate without circular exports', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-neural-v2-cli-smoke-'));
  const declared = path.join(directory, 'protocol.json'); const output = path.join(directory, 'candidate.json');
  try {
    const protocolRun = spawnSync(process.execPath, [path.join(legacy.ROOT, 'scripts/evaluate-long-bot-neural-v2.js'),
      '--declare-protocol', '--output', declared, '--opponents', 'pip', '--development-pairs', '1',
      '--max-candidates', '8', '--reply-top-candidates', '2', '--reply-candidates', '2', '--reply-weight', '0'],
    { encoding: 'utf8', timeout: 15000 });
    assert.equal(protocolRun.status, 0, protocolRun.stderr);
    const trainingRun = spawnSync(process.execPath, [path.join(legacy.ROOT, 'scripts/train-long-bot-neural-v2.js'),
      '--output', output, '--protocol', declared, '--games', '1', '--opponents', 'self', '--max-plies', '1',
      '--max-candidates', '8', '--reply-top-candidates', '2', '--reply-candidates', '2', '--reply-weight', '0'],
    { encoding: 'utf8', timeout: 15000 });
    assert.equal(trainingRun.status, 0, trainingRun.stderr);
    assert.doesNotMatch(trainingRun.stderr, /circular dependency/);
    const saved = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(saved.counters.newCompletedGames, 0);
    assert.equal(saved.counters.newTrainingSteps, 0);
    assert.equal(saved.trainingStatus.censoredGames, 1);
    assert.equal(saved.benchmarkProtocolFingerprint,
      legacy.fingerprint(JSON.parse(fs.readFileSync(declared, 'utf8'))));
    assert.equal(trainer.validateArtifact(saved).games, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function workerFixtureJob(maxGameMs = 5000) {
  const state = legacy.loadLongGame().game.initialState('long');
  state.points = { 6: { color: 'white', count: 7 }, 18: { color: 'dark', count: 7 } };
  state.off = { white: 8, dark: 8 }; state.firstMoveDone = { white: true, dark: true };
  return worker.createJob({ model: trainer.loadWarmStart().model, candidatePolicy: 'candidate-v2',
    opponent: 'greedy', candidateColor: 'white', seeds: { white: 11, dark: 13 }, policySeed: 17,
    policyOptions: trainer.searchApi().options(POLICY), maxPlies: 640, maxGameMs, initialState: state });
}

test('native episode child matches deterministic trusted rules, weights, trace and search coverage', () => {
  const job = workerFixtureJob();
  const direct = worker.executeTrustedJob(job); const child = worker.runEpisodeInWorker(job);
  assert.deepEqual(child, direct);
  assert.equal(child.episode.completed, true);
  assert(child.episode.afterstates.white.length > 0);
  assert.equal(child.searchCoverage.evaluatedPositions, child.searchCoverage.uniqueLegalPositions);
  const changed = legacy.clone(job); changed.modelFingerprint = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => worker.runEpisodeInWorker(changed), /source\/model provenance/);
});

test('native parent watchdog terminates its own synchronous child and returns no result/learning credit', () => {
  const job = workerFixtureJob(1); const started = Date.now();
  assert.throws(() => worker.runEpisodeInWorker(job), /parent process watchdog.*no result or learning credit/);
  assert(Date.now() - started < 5000);
  let called = false;
  assert.throws(() => worker.runEpisodeInWorker(workerFixtureJob(23), { spawn(executable, args, options) {
    called = true; assert.equal(executable, process.execPath);
    assert.deepEqual(args, [path.join(legacy.ROOT, 'scripts/long-neural-v2-episode-worker.js')]);
    assert.equal(options.timeout, 23); assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, worker.MAX_OUTPUT_BYTES);
    return { error: { code: 'ETIMEDOUT' }, signal: 'SIGKILL' };
  } }), /parent process watchdog/);
  assert.equal(called, true);
  const hungStarted = Date.now();
  assert.throws(() => worker.runEpisodeInWorker(workerFixtureJob(100), {
    spawn(executable, args, options) {
      assert.deepEqual(args, [path.join(legacy.ROOT, 'scripts/long-neural-v2-episode-worker.js')]);
      // Only this trusted static regression program is substituted by the
      // test. Job input and CLI have no executable/file/code selection field.
      return spawnSync(executable, [path.join(legacy.ROOT, 'tests/fixtures/long-neural-v2-blocking-worker.js')], options);
    },
  }), /parent process watchdog/);
  assert(Date.now() - hungStarted < 5000, 'OS watchdog must preempt a CPU loop without waiting for JS timers');
});

test('worker response and input are provenance checked, never arbitrary uploaded code', () => {
  const job = workerFixtureJob();
  assert.throws(() => worker.runEpisodeInWorker({ ...job, code: 'arbitrary-program' }), /Unexpected/);
  const forged = { schema: worker.RESULT_SCHEMA, requestFingerprint: `sha256:${'0'.repeat(64)}`,
    sourceFingerprints: job.sourceFingerprints, ok: true, result: worker.executeTrustedJob(job) };
  const stdout = JSON.stringify({ ...forged, resultFingerprint: legacy.fingerprint(forged) });
  assert.throws(() => worker.runEpisodeInWorker(job, { spawn() { return { status: 0, stdout }; } }), /response provenance mismatch/);
});
