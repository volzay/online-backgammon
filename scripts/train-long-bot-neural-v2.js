#!/usr/bin/env node
'use strict';

// A separate, offline-only policy/training lineage. Never rewrites the v1
// artifact, production weights, accounts, dice service, or historical counters.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const legacy = require('./train-long-bot-neural');
const { parseCliTokens } = require('./simulate-long-bot-regression');
const SCHEMA = 'long-neural-search-training-v2';
const TRAIN_DOMAIN = 'nardu/long-neural/v2/training-dice/v1';
const POLICY_DOMAIN = 'nardu/long-neural/v2/training-policy/v1';
const ORDER_DOMAIN = 'nardu/long-neural/v2/sample-order/v1';
const REPLAY_DOMAIN = 'nardu/long-neural/v2/terminal-replay-selection/v1';
const BASELINE_MODEL = 'sha256:4254bfa9f4afccbeb73657f11e37ff39a7fcd9162e7887f1aae28eaa7fbe0155';
const BASELINE_RULES = 'sha256:769c571ad10cefa75a8c128aba5123df47684780fad1136a0ae98f3342f33e4b';
const BASELINE_INFERENCE = 'sha256:a46b184302d4b9bb2f8477d6f454b0cd2ceff0f06ff933d4ea59f28ae8976e3e';
const OPPONENTS = Object.freeze(['self', 'random', 'pip', 'greedy', 'current-hard']);
const HASH = /^sha256:[a-f0-9]{64}$/;
const { clone, canonical, fingerprint, integer, ratio, seededRandom, streamSeeds } = legacy;
function check(condition, message) { if (!condition) throw new Error(message); }
function signedBody(value) { const { artifactFingerprint, ...body } = value; return body; }
let capturedPolicy;
function searchApi() {
  const bytes = fs.readFileSync(path.join(legacy.ROOT, 'lib/long-bot-neural-v2.js'));
  const sourceFingerprint = fingerprint(bytes);
  if (!capturedPolicy || capturedPolicy.sourceFingerprint !== sourceFingerprint) {
    const module = { exports: {} };
    const requireCore = name => {
      check(name === './long-bot-neural', 'Unexpected dependency in captured V2 policy');
      return legacy.neuralApi();
    };
    // Compile only trusted repository policy bytes, not artifact/uploaded code.
    // The explicit dependency binds the historical exact inference core; no
    // shared require-cache or browser-global source can drift underneath us.
    vm.compileFunction(bytes.toString('utf8'), ['module', 'require'],
      { filename: 'lib/long-bot-neural-v2.js' })(module, requireCore);
    capturedPolicy = { sourceFingerprint, api: module.exports };
  }
  return capturedPolicy.api;
}
function sourceFingerprints() {
  const names = ['game.js', 'lib/long-bot-neural.js', 'lib/long-bot-neural-v2.js',
    'scripts/train-long-bot-neural.js', 'scripts/train-long-bot-neural-v2.js',
    'scripts/simulate-long-bot-regression.js', 'scripts/build-long-neural-v2-teacher.js',
    'scripts/long-neural-v2-episode-worker.js',
    'scripts/evaluate-long-bot-neural.js', 'lib/long-neural-artifact.js',
    'long-bot-engine.js', 'strong-bot.js'];
  return Object.fromEntries(names.map(name =>
    [name, fingerprint(fs.readFileSync(path.join(legacy.ROOT, name)))]));
}
function teacherHelper(schema) {
  if (schema === 'long-neural-v2-teacher-corpus-v1') return {
    helper: require('./build-long-neural-v2-teacher'), source: 'scripts/build-long-neural-v2-teacher.js' };
  if (schema === 'long-neural-v2-hard-teacher-corpus-v1') return {
    helper: require('./build-long-neural-v2-hard-teacher'), source: 'scripts/build-long-neural-v2-hard-teacher.js' };
  throw new Error('Unsupported V2 teacher corpus schema; no implicit hard-ledger import');
}
function loadWarmStart(input = JSON.parse(fs.readFileSync(path.join(legacy.ROOT, 'vendor/long-neural/model.json'), 'utf8'))) {
  const api = legacy.neuralApi();
  check(input && typeof input === 'object' && input.model, 'Warm start needs the pinned 448 model envelope');
  api.validateModel(input.model);
  check(legacy.modelFingerprint(input.model) === BASELINE_MODEL && input.model.trainingSteps === 35147,
    'Warm start weights/counters differ from the audited 448 model');
  check(legacy.NEURAL_CODE_FINGERPRINT === BASELINE_INFERENCE, 'Historical inference source changed');
  let metadata;
  let historicalDiceStreams = [];
  if (input.schema === 'nardu-public-long-neural-v1') {
    metadata = input.metadata;
    check(metadata && metadata.id === 'hard-neuro-448-v1' && metadata.trainingGames === 448
      && metadata.trainingSteps === 35147 && metadata.modelFingerprint === BASELINE_MODEL
      && metadata.rulesFingerprint === BASELINE_RULES && metadata.inferenceCodeFingerprint === BASELINE_INFERENCE,
    'Public warm start historical provenance mismatch');
  } else {
    const manifest = legacy.validateTrainingProvenance(input, api, { fingerprint: BASELINE_RULES });
    check(manifest.games === 448 && manifest.samples === 35147, 'Historical artifact is not the audited 448 baseline');
    historicalDiceStreams = manifest.diceStreams.slice();
    metadata = { modelFingerprint: BASELINE_MODEL, rulesFingerprint: BASELINE_RULES,
      inferenceCodeFingerprint: BASELINE_INFERENCE, trainingGames: 448, trainingSteps: 35147 };
  }
  return { model: clone(input.model), origin: {
    kind: 'audited-historical-448-weight-warm-start-not-current-rules-resume',
    envelopeFingerprint: fingerprint(input), modelFingerprint: BASELINE_MODEL,
    rulesFingerprint: BASELINE_RULES, inferenceCodeFingerprint: BASELINE_INFERENCE,
    historicalGames: 448, historicalTrainingSteps: 35147,
    historicalMetadata: clone(metadata), historicalDiceStreams,
    historicalStatisticsNotReclassifiedAsV2: true,
  } };
}

function trainingOptions(input = {}) {
  const options = { games: 16, seed: 0x20260918, maxPlies: 640, maxGameMs: 30000,
    maxElapsedMs: 120000, learningRate: 0.01, replayGames: 16, replaySamples: 32,
    checkpointEvery: 4, teacherEpochs: 1, opponents: ['self', 'random', 'pip', 'greedy'],
    policyOptions: {}, forbiddenDiceStreams: [], ...input };
  for (const [name, min, max] of [['games', 1, 100000], ['seed', 1, 0xffffffff],
    ['maxPlies', 1, 4096], ['maxGameMs', 1, 3600000], ['maxElapsedMs', 1, 86400000],
    ['replayGames', 0, 64], ['replaySamples', 1, 256], ['checkpointEvery', 1, 100000], ['teacherEpochs', 0, 32]]) {
    integer(name, options[name], min, max);
  }
  ratio('learningRate', options.learningRate, Number.MIN_VALUE, 1);
  check(Array.isArray(options.opponents) && options.opponents.length > 0
    && new Set(options.opponents).size === options.opponents.length
    && options.opponents.every(name => OPPONENTS.includes(name)), 'Invalid V2 training opponent pool');
  check(Array.isArray(options.forbiddenDiceStreams) && options.forbiddenDiceStreams.length <= 1000000
    && new Set(options.forbiddenDiceStreams).size === options.forbiddenDiceStreams.length, 'Invalid reserved dice streams');
  options.forbiddenDiceStreams.forEach(seed => integer('reserved dice seed', seed, 1, 0xffffffff));
  options.policyOptions = searchApi().options(options.policyOptions);
  return options;
}

function validateOrigin(origin) {
  check(origin && origin.kind === 'audited-historical-448-weight-warm-start-not-current-rules-resume'
    && origin.modelFingerprint === BASELINE_MODEL && origin.rulesFingerprint === BASELINE_RULES
    && origin.inferenceCodeFingerprint === BASELINE_INFERENCE && origin.historicalGames === 448
    && origin.historicalTrainingSteps === 35147 && origin.historicalStatisticsNotReclassifiedAsV2 === true
    && HASH.test(origin.envelopeFingerprint) && Array.isArray(origin.historicalDiceStreams),
  'V2 historical origin mismatch');
  const metadata = origin.historicalMetadata;
  check(metadata && metadata.modelFingerprint === BASELINE_MODEL && metadata.rulesFingerprint === BASELINE_RULES
    && metadata.inferenceCodeFingerprint === BASELINE_INFERENCE && metadata.trainingGames === 448
    && metadata.trainingSteps === 35147, 'V2 origin relabeled historical provenance');
  check(new Set(origin.historicalDiceStreams).size === origin.historicalDiceStreams.length,
    'Repeated historical dice stream');
  origin.historicalDiceStreams.forEach(seed => integer('historical dice seed', seed, 1, 0xffffffff));
}

function terminalStateForEpisode(episode, game) {
  check(episode && episode.completed === true && ['white', 'dark'].includes(episode.winner)
    && ['white', 'dark'].includes(episode.candidateColor)
    && episode.candidateWon === (episode.candidateColor === episode.winner) && HASH.test(episode.traceFingerprint),
  'Completed episode lacks canonical terminal provenance');
  const states = episode.afterstates?.[episode.winner];
  const terminal = states?.[states.length - 1];
  check(terminal && terminal.phase === 'over' && terminal.winner === episode.winner,
    'Completed episode lacks an actual final rule state');
  const compact = legacy.compactReplayState(terminal);
  legacy.neuralApi().validateState(compact);
  check(compact.off[episode.winner] === 15 && canonical(compact.off) === canonical(episode.off)
    && (game.resultTypeFor(compact, episode.winner) || 'normal') === episode.resultType,
  'Terminal episode off-count/result classification differs from actual rules');
  integer('terminal episode plies', episode.plies, 1, 4096);
  return compact;
}

function validateSearchCoverage(coverage, policyOptions, maxPlies) {
  check(coverage && coverage.scope === 'all-unique-own-position-values-and-bounded-full-21-roll-reply-forecast'
    && canonical(coverage.policyOptions) === canonical(policyOptions), 'V2 search coverage policy/scope mismatch');
  for (const key of ['decisions', 'legalSequences', 'uniqueLegalPositions', 'evaluatedPositions', 'forecastPositions',
    'replyCandidatesEvaluated', 'replyLegalSequences', 'replyUniquePositions', 'truncatedDecisions', 'completeReplyRollDecisions']) {
    integer(`recorded search ${key}`, coverage[key], 0, 1000000000);
  }
  check(coverage.decisions <= maxPlies && coverage.evaluatedPositions === coverage.uniqueLegalPositions
    && coverage.forecastPositions <= coverage.uniqueLegalPositions && coverage.truncatedDecisions <= coverage.decisions
    && coverage.completeReplyRollDecisions <= coverage.decisions
    && coverage.replyCandidatesEvaluated <= coverage.forecastPositions * 21 * policyOptions.replyCandidates,
  'V2 search coverage counts are impossible/incomplete');
  if (policyOptions.replyWeight === 0) check(coverage.replyCandidatesEvaluated === 0
    && coverage.completeReplyRollDecisions === 0 && coverage.replyLegalSequences === 0 && coverage.replyUniquePositions === 0,
  'V2 disabled reply policy claims reply search');
}

function validateArtifact(artifact, { runtime = legacy.loadLongGame(), sources = sourceFingerprints() } = {}) {
  const api = legacy.neuralApi();
  check(artifact && artifact.schema === SCHEMA && artifact.mode === 'experimental-offline-v2-candidate'
    && artifact.productionEligible === false && artifact.policySchema === searchApi().POLICY_SCHEMA,
  'An offline V2 candidate is required');
  check(fingerprint(signedBody(artifact)) === artifact.artifactFingerprint, 'V2 artifact body fingerprint mismatch');
  api.validateModel(artifact.model);
  check(legacy.modelFingerprint(artifact.model) === artifact.modelFingerprint, 'V2 model fingerprint mismatch');
  check(artifact.runtimeFingerprint === runtime.fingerprint
    && canonical(artifact.sourceFingerprints) === canonical(sources), 'V2 policy/rules/training source bytes changed');
  validateOrigin(artifact.origin);
  if (artifact.benchmarkProtocol) {
    const evaluator = require('./evaluate-long-bot-neural-v2');
    evaluator.validateProtocol(artifact.benchmarkProtocol);
    check(artifact.benchmarkProtocolFingerprint === fingerprint(artifact.benchmarkProtocol),
      'V2 predeclared benchmark protocol fingerprint mismatch');
  } else check(artifact.benchmarkProtocol === null && artifact.benchmarkProtocolFingerprint === null,
    'V2 unbound training artifact claims a benchmark reservation');
  const reserved = artifact.reservedDiceStreams;
  check(Array.isArray(reserved) && new Set(reserved).size === reserved.length, 'Invalid V2 reserved streams');
  reserved.forEach(seed => integer('reserved dice seed', seed, 1, 0xffffffff));
  if (artifact.benchmarkProtocol) {
    const evaluator = require('./evaluate-long-bot-neural-v2');
    check(evaluator.protocolReservations(artifact.benchmarkProtocol).every(seed => reserved.includes(seed)),
      'V2 artifact discarded predeclared benchmark streams');
  }
  check(Array.isArray(artifact.results) && Array.isArray(artifact.segments)
    && artifact.segments.length > 0 && artifact.segments.length <= 1000, 'V2 segment/results missing');
  let games = 0; let nativeSteps = 0; let replaySteps = 0; let teacherSteps = 0;
  let chain = BASELINE_MODEL;
  const streams = [];
  const declaredRecords = [];
  const appearances = Object.fromEntries(OPPONENTS.map(name => [name, 0]));
  const nextStreamBySeed = new Map();
  const replayLeaves = new Map();
  let eligibleReplay = [];
  for (let segmentIndex = 0; segmentIndex < artifact.segments.length; segmentIndex += 1) {
    const segment = artifact.segments[segmentIndex];
    check(segment.id === segmentIndex && segment.modelFingerprintBefore === chain
      && HASH.test(segment.modelFingerprintAfter), 'V2 model chain mismatch');
    const options = trainingOptions(segment.options);
    check(canonical(options) === canonical(segment.options), 'V2 recorded options mismatch');
    integer('segment start', segment.streamIndexStart, 0, 1000000);
    check(segment.streamIndexStart === (nextStreamBySeed.get(options.seed) || 0)
      && segment.streamIndexStart + options.games <= 1000001, 'V2 declared stream window was reused or reordered');
    nextStreamBySeed.set(options.seed, segment.streamIndexStart + options.games);
    check(declaredRecords.length + options.games <= 1000000, 'V2 declared episode provenance exceeds one million attempts');
    for (let index = 0; index < options.games; index += 1) {
      declaredRecords.push({ streamSeeds: streamSeeds(TRAIN_DOMAIN, options.seed, segment.streamIndexStart + index) });
    }
    integer('segment completed games', segment.completedGames, 0, options.games);
    check(segment.status === (segment.completedGames === options.games ? 'complete' : 'partial-no-gate')
      && Array.isArray(segment.censoredAttempts) && segment.censoredAttempts.length <= 1,
    'V2 segment completion/censor status differs from actual committed games');
    for (const attempt of segment.censoredAttempts) {
      check(segment.completedGames < options.games && attempt.game === games + segment.completedGames + 1
        && attempt.streamIndex === segment.streamIndexStart + segment.completedGames
        && attempt.noResultOrTrainingCredit === true
        && typeof attempt.reason === 'string' && (attempt.reason === 'total-budget-before-start'
          || /^Censored game (?:exceeded|has no terminal)/.test(attempt.reason))
        && attempt.winner === undefined && attempt.completed === undefined && attempt.candidateWon === undefined,
      'V2 censored attempt has result credit or mismatched declared ordinal');
    }
    integer('teacher steps', segment.teacherSteps, 0, 10000000);
    if (segment.teacherSteps) {
      integer('teacher samples', segment.teacher?.samples, 2, 1000000);
      const importer = teacherHelper(segment.teacher?.corpusSchema);
      check(segment.teacher && HASH.test(segment.teacher.corpusFingerprint)
        && HASH.test(segment.teacher.importerFingerprint)
        && segment.teacher.importerFingerprint === fingerprint(fs.readFileSync(path.join(legacy.ROOT, importer.source)))
        && segment.teacher.targetKind === 'synthetic-pairwise-ranking-surrogate-not-win-probability'
        && segment.teacher.samples % 2 === 0 && segment.teacher.samples * options.teacherEpochs === segment.teacherSteps
        && segment.teacher.evidence === 'current-rules-replayed-heuristic-preference-not-causal-outcome'
        && segment.teacher.provenance?.rulesFingerprint === runtime.fingerprint
        && segment.teacher.provenance.modelFingerprint === BASELINE_MODEL
        && segment.teacher.provenance.modelSourceFingerprint === sources['lib/long-bot-neural.js']
        && segment.teacher.provenance.plannerFingerprint === sources['lib/long-bot-neural-v2.js']
        && HASH.test(segment.teacher.provenance.sourceLedgerFingerprint)
        && segment.teacher.provenance.verification === 'canonical-rule-local-replay-not-signed-room-evidence',
      'V2 teacher updates lack separate surrogate-label provenance');
    } else check(segment.teacher === null, 'Uncounted teacher source in V2 segment');
    teacherSteps += segment.teacherSteps;
    for (let index = 0; index < segment.completedGames; index += 1) {
      const result = artifact.results[games];
      const expected = streamSeeds(TRAIN_DOMAIN, options.seed, segment.streamIndexStart + index);
      const expectedOpponent = options.opponents[index % options.opponents.length];
      const expectedColor = appearances[expectedOpponent]++ % 2 ? 'dark' : 'white';
      check(result && result.game === games + 1 && result.segmentId === segment.id && result.completed === true
        && ['white', 'dark'].includes(result.winner) && ['white', 'dark'].includes(result.candidateColor)
        && result.opponent === expectedOpponent && result.candidateColor === expectedColor
        && result.candidateWon === (result.winner === result.candidateColor)
        && options.opponents.includes(result.opponent) && result.streamIndex === segment.streamIndexStart + index
        && canonical(result.streamSeeds) === canonical(expected) && HASH.test(result.traceFingerprint)
        && HASH.test(result.modelFingerprintBefore) && HASH.test(result.modelFingerprintAfter),
      'V2 completed episode provenance mismatch');
      integer('recorded episode plies', result.plies, 1, options.maxPlies);
      validateSearchCoverage(result.searchCoverage, options.policyOptions, result.plies);
      if (result.opponent === 'self') validateSearchCoverage(result.selfOpponentSearchCoverage, options.policyOptions, result.plies);
      else check(result.selfOpponentSearchCoverage === undefined, 'V2 non-self game claims self-policy coverage');
      api.validateState(result.terminalState);
      check(result.terminalState.winner === result.winner && result.terminalState.phase === 'over'
        && canonical(result.terminalState.off) === canonical(result.off)
        && (runtime.game.resultTypeFor(result.terminalState, result.winner) || 'normal') === result.resultType,
      'V2 terminal result differs from recorded rule state');
      integer('native samples', result.nativeTrainingSamples, 1, 8192);
      integer('replay samples', result.replayTrainingSamples, 0, options.replaySamples);
      check(result.trainingSamples === result.nativeTrainingSamples + result.replayTrainingSamples,
        'V2 native/replay counters mismatch');
      if (index === 0) check(result.modelFingerprintBefore === segment.modelFingerprintAfterTeacher,
        'V2 teacher/episode model chain mismatch');
      else check(result.modelFingerprintBefore === artifact.results[games - 1].modelFingerprintAfter,
        'V2 episode model chain mismatch');
      const leaves = result.experienceLeaves || [];
      check(Array.isArray(leaves) && leaves.length <= 64 && Array.isArray(result.replaySources)
        && result.replaySources.length === result.replayTrainingSamples, 'V2 replay origin missing');
      eligibleReplay = options.replayGames ? eligibleReplay.slice(-options.replayGames) : [];
      const availableTargets = new Set(eligibleReplay.flatMap(game => [...replayLeaves.get(game).values()].map(leaf => leaf.target)));
      check(result.replayTrainingSamples === (options.replayGames && availableTargets.size === 2 ? options.replaySamples : 0),
        'V2 replay count differs from configured past terminal-only sample pool');
      let zero = 0; let one = 0;
      for (const source of result.replaySources) {
        const leaf = replayLeaves.get(source.game)?.get(source.sampleFingerprint);
        check(leaf && eligibleReplay.includes(source.game)
          && artifact.results[source.game - 1].experienceGameFingerprint === source.experienceFingerprint,
        'V2 replay is not committed by an eligible past completed episode');
        if (leaf.target === 0) zero += 1; else one += 1;
      }
      check(zero === Math.ceil(result.replayTrainingSamples / 2) && one === Math.floor(result.replayTrainingSamples / 2),
        'V2 replay terminal labels are unbalanced');
      const leafMap = new Map();
      for (const leaf of leaves) {
        integer('experience afterstate index', leaf.afterstateIndex, 0, 4095);
        check(['white', 'dark'].includes(leaf.color) && leaf.target === (result.winner === leaf.color ? 1 : 0)
          && HASH.test(leaf.stateFingerprint) && HASH.test(leaf.sampleFingerprint)
          && !leafMap.has(leaf.sampleFingerprint), 'V2 experience leaf origin mismatch');
        const body = { sourceGame: result.game, sourceTraceFingerprint: result.traceFingerprint,
          sourceModelFingerprint: result.modelFingerprintBefore, color: leaf.color, target: leaf.target,
          afterstateIndex: leaf.afterstateIndex, stateFingerprint: leaf.stateFingerprint };
        check(fingerprint(body) === leaf.sampleFingerprint, 'V2 experience leaf semantic commitment mismatch');
        leafMap.set(leaf.sampleFingerprint, leaf);
      }
      check(Boolean(options.replayGames) === Boolean(leaves.length), 'V2 replay enabled/cache mismatch');
      replayLeaves.set(result.game, leafMap);
      if (options.replayGames) eligibleReplay = [...eligibleReplay, result.game].slice(-options.replayGames);
      nativeSteps += result.nativeTrainingSamples; replaySteps += result.replayTrainingSamples;
      streams.push(expected.white, expected.dark); games += 1;
    }
    const expectedLast = segment.completedGames ? artifact.results[games - 1].modelFingerprintAfter : segment.modelFingerprintAfterTeacher;
    check(expectedLast === segment.modelFingerprintAfter, 'V2 segment final model chain mismatch');
    if (!segment.teacherSteps) check(segment.modelFingerprintAfterTeacher === segment.modelFingerprintBefore,
      'V2 uncounted pre-episode weight mutation');
    chain = segment.modelFingerprintAfter;
  }
  check(games === artifact.results.length && chain === artifact.modelFingerprint,
    'V2 final model/results mismatch');
  check(canonical(artifact.counters) === canonical({ newCompletedGames: games, newNativeTrainingSteps: nativeSteps,
    newReplayTrainingSteps: replaySteps, newTeacherTrainingSteps: teacherSteps,
    newTrainingSteps: nativeSteps + replaySteps + teacherSteps })
    && artifact.model.trainingSteps === 35147 + nativeSteps + replaySteps + teacherSteps,
  'V2 historical/new training counters were conflated');
  check(canonical(streams) === canonical(artifact.trainingDiceStreams), 'V2 training dice manifest mismatch');
  legacy.assertDisjointStreams(declaredRecords, [...artifact.origin.historicalDiceStreams, ...reserved]);
  const latest = artifact.segments[artifact.segments.length - 1];
  check(canonical(artifact.trainingStatus) === canonical({ requestedGames: latest.options.games,
    completedGames: latest.completedGames, complete: latest.completedGames === latest.options.games,
    censoredGames: latest.censoredAttempts.length,
    notRunGames: latest.options.games - latest.completedGames - latest.censoredAttempts.length,
    noProductionOrHumanWinRateClaim: true }), 'V2 training status differs from committed/censored/not-run provenance');
  const cache = artifact.experienceReplay;
  check(cache && Array.isArray(cache.games)
    && canonical(cache.games.map(game => game.game)) === canonical(eligibleReplay), 'V2 terminal cache window mismatch');
  for (const cached of cache.games) {
    const { fingerprint: cacheHash, ...body } = cached;
    const result = artifact.results[cached.game - 1];
    check(fingerprint(body) === cacheHash && result.experienceGameFingerprint === cacheHash
      && cached.winner === result.winner && cached.traceFingerprint === result.traceFingerprint
      && cached.sourceModelFingerprint === result.modelFingerprintBefore
      && cached.samples.length === result.experienceLeaves.length, 'V2 terminal cache source mismatch');
    for (const sample of cached.samples) {
      const leaf = replayLeaves.get(cached.game).get(sample.fingerprint);
      api.validateState(sample.state);
      check(leaf && sample.color === leaf.color && sample.target === leaf.target
        && fingerprint(sample.state) === leaf.stateFingerprint && sample.state.winner === null
        && sample.state.phase === 'roll' && sample.state.turn === (sample.color === 'white' ? 'dark' : 'white')
        && !sample.state.dice.length && !sample.state.rolled.length && !sample.state.turnMoves.length,
      'V2 cached state is terminal, future-dependent or altered');
    }
  }
  return { games, samples: nativeSteps + replaySteps + teacherSteps, diceStreams: streams };
}

function monitoredPolicy(bot, policyOptions) {
  const coverage = { decisions: 0, legalSequences: 0, uniqueLegalPositions: 0,
    evaluatedPositions: 0, forecastPositions: 0, replyCandidatesEvaluated: 0,
    replyLegalSequences: 0, replyUniquePositions: 0, truncatedDecisions: 0,
    completeReplyRollDecisions: 0, policyOptions: clone(policyOptions),
    scope: 'all-unique-own-position-values-and-bounded-full-21-roll-reply-forecast' };
  return { coverage, plan(state) {
    const moves = bot.plan(state); const decision = bot.getLastDecision();
    check(decision && decision.policySchema === searchApi().POLICY_SCHEMA
      && canonical(decision.policyOptions) === canonical(policyOptions) && decision.replySearchComplete === true,
    'V2 policy emitted incomplete/changed/unverified search metadata');
    check(decision.evaluatedPositions === decision.uniqueLegalPositions
      && [0, 21].includes(decision.replyRolls), 'V2 policy skipped unique own positions or partial reply-roll coverage');
    coverage.decisions += 1;
    for (const key of ['legalSequences', 'uniqueLegalPositions', 'evaluatedPositions', 'forecastPositions',
      'replyCandidatesEvaluated', 'replyLegalSequences', 'replyUniquePositions']) {
      integer(`search ${key}`, decision[key], 0, 1000000000);
      coverage[key] += decision[key];
    }
    if (decision.truncated) coverage.truncatedDecisions += 1;
    if (decision.replyRolls === 21) coverage.completeReplyRollDecisions += 1;
    return moves;
  } };
}

function runTraining(input = {}, dependencies = {}) {
  check(!(input.resumeArtifact && input.warmStart), 'V2 resume and historical warm start are mutually exclusive');
  const options = trainingOptions(input);
  const api = legacy.neuralApi(); const policy = searchApi();
  const runtime = legacy.loadLongGame(); const sources = sourceFingerprints();
  check(runtime.fingerprint === sources['game.js'] && legacy.NEURAL_CODE_FINGERPRINT === sources['lib/long-bot-neural.js']
    && legacy.HARNESS_FINGERPRINT === sources['scripts/train-long-bot-neural.js']
    && legacy.SEED_HELPER_FINGERPRINT === sources['scripts/simulate-long-bot-regression.js']
    && capturedPolicy.sourceFingerprint === sources['lib/long-bot-neural-v2.js'],
  'Captured V2 policy/inference/rules source provenance drifted');
  const previous = input.resumeArtifact ? clone(input.resumeArtifact) : null;
  if (previous) validateArtifact(previous, { runtime, sources });
  const benchmarkProtocol = input.benchmarkProtocol || previous?.benchmarkProtocol || null;
  check(!(previous && !previous.benchmarkProtocol && input.benchmarkProtocol),
    'V2 cannot attach a predeclared benchmark retroactively to an existing unbound training lineage');
  if (benchmarkProtocol) {
    const evaluator = require('./evaluate-long-bot-neural-v2');
    evaluator.validateProtocol(benchmarkProtocol);
    check(canonical(options.policyOptions) === canonical(benchmarkProtocol.policyOptions),
      'V2 training policy differs from its predeclared benchmark');
    if (previous?.benchmarkProtocol) check(fingerprint(benchmarkProtocol) === previous.benchmarkProtocolFingerprint,
      'V2 resume cannot replace its previously declared benchmark');
  }
  const warm = previous ? null : loadWarmStart(input.warmStart);
  const origin = previous ? clone(previous.origin) : warm.origin;
  let model = previous ? clone(previous.model) : warm.model;
  let results = previous ? clone(previous.results) : [];
  let experienceGames = previous ? clone(previous.experienceReplay.games) : [];
  const priorSegments = previous ? clone(previous.segments) : [];
  if (experienceGames.length && options.replayGames === 0) throw new Error('V2 existing terminal experience cannot be silently discarded');
  const protocolStreams = benchmarkProtocol ? require('./evaluate-long-bot-neural-v2').protocolReservations(benchmarkProtocol) : [];
  const reserved = [...new Set([...(previous?.reservedDiceStreams || []), ...options.forbiddenDiceStreams, ...protocolStreams])];
  const oldStreams = [...origin.historicalDiceStreams, ...(previous?.trainingDiceStreams || [])];
  check(!oldStreams.some(seed => reserved.includes(seed)), 'V2 historical/training streams overlap reserved evaluation');
  let streamIndexStart = 0;
  for (const segment of priorSegments) if (segment.options.seed === options.seed) {
    // Reserve the entire declared run, including censored/not-run attempts.
    streamIndexStart = Math.max(streamIndexStart, segment.streamIndexStart + segment.options.games);
  }
  integer('final training stream index', streamIndexStart + options.games - 1, 0, 1000000);
  const appearances = Object.fromEntries(options.opponents.map(name => [name, results.filter(result => result.opponent === name).length]));
  const records = Array.from({ length: options.games }, (_, index) => {
    const opponent = options.opponents[index % options.opponents.length];
    return { game: results.length + index + 1, segmentId: priorSegments.length,
      opponent, candidateColor: appearances[opponent]++ % 2 ? 'dark' : 'white',
      streamIndex: streamIndexStart + index, streamSeeds: streamSeeds(TRAIN_DOMAIN, options.seed, streamIndexStart + index) };
  });
  legacy.assertDisjointStreams(records, [...oldStreams, ...reserved]);
  const started = performance.now();
  const segmentBefore = legacy.modelFingerprint(model);
  let teacher = null; let teacherSteps = 0;
  const publicOptions = Object.fromEntries(Object.entries(options).filter(([key]) =>
    !['resumeArtifact', 'warmStart', 'teacherCorpus', 'benchmarkProtocol'].includes(key)));
  if (input.teacherCorpus && options.teacherEpochs) {
    const importer = teacherHelper(input.teacherCorpus.schema); const helper = importer.helper;
    helper.validateTeacherCorpus(input.teacherCorpus, { game: runtime.game,
      rulesFingerprint: runtime.fingerprint, modelFingerprint: BASELINE_MODEL });
    const batch = helper.createTrainingSamples(input.teacherCorpus);
    check(batch.length > 0, 'Verified teacher corpus contains no usable preference samples');
    const staged = clone(model);
    for (let epoch = 0; epoch < options.teacherEpochs; epoch += 1) {
      const orderSeed = streamSeeds(ORDER_DOMAIN, options.seed, epoch, 'teacher').white;
      for (const sample of legacy.orderSamples(batch, 'seeded-shuffle', seededRandom(orderSeed))) {
        check(performance.now() - started <= options.maxElapsedMs, 'Teacher phase exceeded total budget; staged gradients discarded');
        check(sample.targetKind === 'synthetic-pairwise-ranking-surrogate-not-win-probability'
          && [0.3, 0.7].includes(sample.target), 'Unsupported teacher probability/surrogate label');
        api.trainSample(staged, sample.state, sample.color, sample.target, { learningRate: options.learningRate });
      }
    }
    api.validateModel(staged);
    check(performance.now() - started <= options.maxElapsedMs, 'Teacher phase exceeded total budget; staged gradients discarded');
    teacherSteps = batch.length * options.teacherEpochs;
    teacher = { corpusFingerprint: fingerprint(input.teacherCorpus), samples: batch.length,
      corpusSchema: input.teacherCorpus.schema,
      importerFingerprint: fingerprint(fs.readFileSync(path.join(legacy.ROOT, importer.source))),
      targetKind: 'synthetic-pairwise-ranking-surrogate-not-win-probability',
      evidence: 'current-rules-replayed-heuristic-preference-not-causal-outcome', provenance: clone(input.teacherCorpus.provenance) };
    model = staged;
  }
  const afterTeacher = legacy.modelFingerprint(model);
  let newResults = []; const censored = [];
  const hardEvaluator = options.opponents.includes('current-hard') ? require('./evaluate-long-bot-neural') : null;
  const hardSnapshot = hardEvaluator ? hardEvaluator.readCurrentHardSnapshot() : null;
  if (hardSnapshot) check(hardSnapshot.sourceFingerprints['game.js'] === runtime.fingerprint, 'Training hard opponent rules differ');
  function artifact(complete) {
    complete = newResults.length === options.games;
    const finalFingerprint = legacy.modelFingerprint(model);
    const segment = { id: priorSegments.length, streamIndexStart, options: publicOptions,
      modelFingerprintBefore: segmentBefore, modelFingerprintAfterTeacher: afterTeacher,
      modelFingerprintAfter: finalFingerprint, teacher, teacherSteps, completedGames: newResults.length,
      status: complete ? 'complete' : 'partial-no-gate', censoredAttempts: clone(censored) };
    const all = [...results, ...newResults];
    const counters = { newCompletedGames: all.length,
      newNativeTrainingSteps: all.reduce((sum, result) => sum + result.nativeTrainingSamples, 0),
      newReplayTrainingSteps: all.reduce((sum, result) => sum + result.replayTrainingSamples, 0),
      newTeacherTrainingSteps: priorSegments.reduce((sum, value) => sum + value.teacherSteps, 0) + teacherSteps };
    counters.newTrainingSteps = counters.newNativeTrainingSteps + counters.newReplayTrainingSteps + counters.newTeacherTrainingSteps;
    const body = { schema: SCHEMA, mode: 'experimental-offline-v2-candidate', productionEligible: false,
      policySchema: policy.POLICY_SCHEMA, model: clone(model), modelFingerprint: finalFingerprint,
      origin: clone(origin), runtimeFingerprint: runtime.fingerprint, sourceFingerprints: sources,
      benchmarkProtocol: benchmarkProtocol ? clone(benchmarkProtocol) : null,
      benchmarkProtocolFingerprint: benchmarkProtocol ? fingerprint(benchmarkProtocol) : null,
      objective: 'episodic-terminal-win-Monte-Carlo-plus-explicit-heuristic-preference-surrogate-not-calibrated-probability',
      counters, segments: [...priorSegments, segment], results: clone(all),
      trainingDiceStreams: all.flatMap(result => [result.streamSeeds.white, result.streamSeeds.dark]),
      reservedDiceStreams: reserved, experienceReplay: { games: clone(experienceGames) },
      trainingStatus: { requestedGames: options.games, completedGames: newResults.length,
        complete, censoredGames: censored.length, notRunGames: options.games - newResults.length - censored.length,
        noProductionOrHumanWinRateClaim: true } };
    return { ...body, artifactFingerprint: fingerprint(body) };
  }
  function checkpoint(complete) {
    const value = artifact(complete);
    validateArtifact(value, { runtime, sources });
    dependencies.onCheckpoint?.(value);
    return value;
  }
  try {
    for (const record of records) {
      const remaining = Math.floor(options.maxElapsedMs - (performance.now() - started));
      if (remaining <= 0) {
        censored.push({ game: record.game, streamIndex: record.streamIndex,
          reason: 'total-budget-before-start', noResultOrTrainingCredit: true });
        break;
      }
      const frozen = clone(model); const before = legacy.modelFingerprint(frozen);
      const policySeeds = streamSeeds(POLICY_DOMAIN, options.seed, record.streamIndex);
      const candidate = monitoredPolicy(policy.createNeuralBot(runtime.game, frozen, options.policyOptions), options.policyOptions);
      const opponent = record.opponent === 'self' ? monitoredPolicy(policy.createNeuralBot(runtime.game, frozen, options.policyOptions), options.policyOptions)
        : record.opponent === 'current-hard' ? hardEvaluator.createCurrentHard(hardSnapshot)
          : legacy.createBaseline(runtime.game, record.opponent, seededRandom(policySeeds.dark), options.policyOptions.maxCandidates);
      let episode;
      const episodeStarted = performance.now();
      const episodeBudget = Math.min(options.maxGameMs, remaining);
      try {
        if (dependencies.workerEpisodes) {
          const worker = require('./long-neural-v2-episode-worker');
          const result = worker.runEpisodeInWorker(worker.createJob({ model: frozen, candidatePolicy: 'candidate-v2',
            opponent: record.opponent, candidateColor: record.candidateColor, seeds: record.streamSeeds,
            policySeed: policySeeds.dark, policyOptions: options.policyOptions, maxPlies: options.maxPlies, maxGameMs: episodeBudget }));
          episode = result.episode; Object.assign(candidate.coverage, result.searchCoverage);
          if (record.opponent === 'self') Object.assign(opponent.coverage, result.selfOpponentSearchCoverage);
        } else episode = (dependencies.playEpisode || legacy.playEpisode)({ game: runtime.game, candidate, opponent,
          candidateColor: record.candidateColor, seeds: record.streamSeeds, maxPlies: options.maxPlies,
          maxGameMs: episodeBudget, collectTraining: true });
        check(episode.completed === true, 'Censored game has no terminal completion; no training credit');
        check(performance.now() - episodeStarted <= episodeBudget,
          'Censored game exceeded per-game budget in its final winning plan; no training credit');
        check(performance.now() - started <= options.maxElapsedMs,
          'Censored game exceeded total budget before episode credit; no training credit');
      } catch (error) {
        if (!/^Censored game (?:exceeded|has no terminal)/.test(error.message)) throw error;
        censored.push({ game: record.game, streamIndex: record.streamIndex,
          reason: error.message, noResultOrTrainingCredit: true });
        break;
      }
      check(legacy.modelFingerprint(frozen) === before, 'Training policy mutated frozen episode weights');
      const terminalState = terminalStateForEpisode(episode, runtime.game);
      const batch = legacy.tdTargets(api, frozen, episode, ['white', 'dark'], 1);
      check(batch.length > 0, 'Terminal V2 episode contains no nonterminal training states');
      const replaySeed = streamSeeds(REPLAY_DOMAIN, options.seed, record.streamIndex).white;
      const pastGames = options.replayGames ? experienceGames.slice(-options.replayGames) : [];
      const replay = options.replayGames ? legacy.selectReplaySamples(pastGames, options.replaySamples, seededRandom(replaySeed)) : [];
      const experience = options.replayGames ? legacy.createExperienceGame(record.game, episode, before, batch.length, api) : null;
      const next = clone(model);
      const orderSeed = streamSeeds(ORDER_DOMAIN, options.seed, record.streamIndex).white;
      let gradientBudgetExceeded = false;
      for (const sample of legacy.orderSamples([...batch, ...replay], 'seeded-shuffle', seededRandom(orderSeed))) {
        if (performance.now() - started > options.maxElapsedMs) { gradientBudgetExceeded = true; break; }
        api.trainSample(next, sample.state, sample.color, sample.target, { learningRate: options.learningRate });
      }
      api.validateModel(next);
      if (gradientBudgetExceeded || performance.now() - started > options.maxElapsedMs) {
        censored.push({ game: record.game, streamIndex: record.streamIndex,
          reason: 'Censored game exceeded total budget during staged gradients; no training credit', noResultOrTrainingCredit: true });
        break;
      }
      const { afterstates, ...terminal } = episode;
      const row = { ...record, ...terminal, terminalState, nativeTrainingSamples: batch.length, replayTrainingSamples: replay.length,
        trainingSamples: batch.length + replay.length, modelFingerprintBefore: before,
        modelFingerprintAfter: legacy.modelFingerprint(next),
        searchCoverage: clone(candidate.coverage),
        ...(record.opponent === 'self' ? { selfOpponentSearchCoverage: clone(opponent.coverage) } : {}),
        experienceGameFingerprint: experience?.fingerprint || null,
        experienceLeaves: experience ? experience.samples.map(sample => ({ color: sample.color, target: sample.target,
          afterstateIndex: sample.afterstateIndex, stateFingerprint: sample.stateFingerprint, sampleFingerprint: sample.fingerprint })) : [],
        replaySources: replay.map(sample => sample.replaySource) };
      const nextExperience = experience ? [...pastGames, experience].slice(-options.replayGames) : [];
      // Commit the entire completed episode only after all replay, gradients,
      // counters, model validation and fingerprints have succeeded.
      model = next; experienceGames = nextExperience; newResults = [...newResults, row];
      dependencies.onProgress?.({ completedGames: newResults.length, requestedGames: options.games,
        modelFingerprint: row.modelFingerprintAfter, elapsedMs: performance.now() - started });
      if (newResults.length % options.checkpointEvery === 0) checkpoint(newResults.length === options.games);
    }
    return checkpoint(newResults.length === options.games);
  } catch (error) {
    error.completedArtifact = checkpoint(false);
    throw error;
  }
}

function readJson(file, maxBytes = 64 * 1024 * 1024) {
  check(path.isAbsolute(file), 'Offline input requires an explicit absolute path');
  const bytes = fs.readFileSync(file); check(bytes.length <= maxBytes, 'Offline input exceeds its byte limit');
  return JSON.parse(bytes.toString('utf8'));
}
function validateOfflineOutput(file) {
  check(typeof file === 'string' && path.isAbsolute(file) && path.extname(file) === '.json',
    'Offline output requires an explicit absolute JSON artifact path');
  const directory = fs.realpathSync(path.dirname(file));
  const resolved = path.join(directory, path.basename(file));
  const root = fs.realpathSync(legacy.ROOT);
  const relative = path.relative(root, resolved);
  check(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || relative.startsWith(`experiments${path.sep}long-neural-v2${path.sep}`)
    || relative.startsWith(`data${path.sep}long-neural${path.sep}v2${path.sep}`),
  'V2 repository output must stay in experiments/long-neural-v2 or private data/long-neural/v2; legacy/public assets are protected');
  return resolved;
}
function cliOptions(argv) {
  const values = new Set(['games', 'seed', 'max-plies', 'max-game-ms', 'max-elapsed-ms', 'learning-rate',
    'replay-games', 'replay-samples', 'teacher-epochs', 'checkpoint-every', 'opponents', 'max-candidates',
    'reply-top-candidates', 'reply-candidates', 'reply-weight', 'output', 'warm-start', 'resume',
    'teacher-corpus', 'forbidden-dice-seeds', 'protocol']);
  const parsed = parseCliTokens(argv, values, new Set(['help']));
  if (parsed.flags.has('help')) return { help: true };
  const options = { policyOptions: {} };
  for (const [flag, key] of Object.entries({ games: 'games', seed: 'seed', 'max-plies': 'maxPlies',
    'max-game-ms': 'maxGameMs', 'max-elapsed-ms': 'maxElapsedMs', 'learning-rate': 'learningRate',
    'replay-games': 'replayGames', 'replay-samples': 'replaySamples', 'teacher-epochs': 'teacherEpochs',
    'checkpoint-every': 'checkpointEvery' })) if (parsed.values.has(flag)) options[key] = Number(parsed.values.get(flag));
  for (const [flag, key] of Object.entries({ 'max-candidates': 'maxCandidates',
    'reply-top-candidates': 'replyTopCandidates', 'reply-candidates': 'replyCandidates', 'reply-weight': 'replyWeight' })) {
    if (parsed.values.has(flag)) options.policyOptions[key] = Number(parsed.values.get(flag));
  }
  if (parsed.values.has('opponents')) options.opponents = parsed.values.get('opponents').split(',');
  for (const [flag, key] of Object.entries({ 'warm-start': 'warmStart', resume: 'resumeArtifact',
    'teacher-corpus': 'teacherCorpus', 'forbidden-dice-seeds': 'forbiddenDiceStreams' })) {
    if (parsed.values.has(flag)) options[key] = readJson(parsed.values.get(flag));
  }
  const protocol = parsed.values.has('protocol') ? readJson(parsed.values.get('protocol'), 1024 * 1024) : null;
  if (protocol) {
    const evaluator = require('./evaluate-long-bot-neural-v2');
    evaluator.validateProtocol(protocol);
    const reservations = evaluator.protocolReservations(protocol);
    options.forbiddenDiceStreams = [...new Set([...(options.forbiddenDiceStreams || []), ...reservations])];
    options.benchmarkProtocol = protocol;
    check(canonical(searchApi().options(options.policyOptions)) === canonical(protocol.policyOptions),
      'Training policy differs from predeclared benchmark policy');
  }
  return { options, output: parsed.values.get('output') || '' };
}
function main(argv = process.argv.slice(2)) {
  const parsed = cliOptions(argv);
  if (parsed.help) {
    console.log('Offline V2 training: --output /absolute/candidate.json [--games 16 --seed 539363608 --protocol /absolute/protocol.json --teacher-corpus /absolute/corpus.json --resume /absolute/v2.json]');
    return;
  }
  validateOfflineOutput(parsed.output);
  const value = runTraining(parsed.options, {
    workerEpisodes: true,
    onCheckpoint(value) { legacy.writeJsonAtomic(parsed.output, value); },
    onProgress(value) { console.error(JSON.stringify({ event: 'v2-completed-terminal-training', ...value })); },
  });
  legacy.writeJsonAtomic(parsed.output, value);
  console.log(JSON.stringify({ schema: value.schema, modelFingerprint: value.modelFingerprint,
    ...value.counters, trainingStatus: value.trainingStatus, productionEligible: false, output: parsed.output }));
}
module.exports = { SCHEMA, TRAIN_DOMAIN, POLICY_DOMAIN, ORDER_DOMAIN, REPLAY_DOMAIN, BASELINE_MODEL, BASELINE_RULES,
  BASELINE_INFERENCE, OPPONENTS, searchApi, sourceFingerprints, loadWarmStart, trainingOptions, validateOrigin,
  teacherHelper, terminalStateForEpisode, validateSearchCoverage, validateArtifact, monitoredPolicy, runTraining,
  readJson, validateOfflineOutput, cliOptions, main };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || String(error)); process.exitCode = 2; }
}
