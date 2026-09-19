#!/usr/bin/env node
'use strict';

// Independent offline color-paired control. No online learning/deployment.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const legacy = require('./train-long-bot-neural');
const trainer = require('./train-long-bot-neural-v2');
const hard = require('./evaluate-long-bot-neural');
const { parseCliTokens, fingerprintNamedBuffers } = require('./simulate-long-bot-regression');
const SCHEMA = 'long-neural-search-evaluation-v2';
const PROTOCOL_SCHEMA = 'long-neural-search-benchmark-protocol-v2';
const DEVELOPMENT_DOMAIN = 'nardu/long-neural/v2/development-validation-dice/v1';
const CONFIRMATION_DOMAIN = 'nardu/long-neural/v2/held-out-confirmation-dice/v1';
const POLICY_DOMAIN = 'nardu/long-neural/v2/evaluation-policy/v1';
const OPPONENTS = Object.freeze(['random', 'pip', 'greedy', 'legacy-neuro', 'current-hard']);
const { clone, canonical, fingerprint, integer, ratio, streamSeeds, seededRandom } = legacy;
function check(condition, message) { if (!condition) throw new Error(message); }
function evaluationSources() {
  return Object.fromEntries(['scripts/evaluate-long-bot-neural-v2.js', 'scripts/evaluate-long-bot-neural.js',
    'lib/long-neural-artifact.js'].map(name => [name, fingerprint(fs.readFileSync(path.join(legacy.ROOT, name)))]));
}
function createProtocol(input = {}) {
  const protocol = { schema: PROTOCOL_SCHEMA, declaredBeforeV2Training: true,
    baselineModelFingerprint: trainer.BASELINE_MODEL, baselineRulesFingerprint: trainer.BASELINE_RULES,
    trainingSourceFingerprints: trainer.sourceFingerprints(), evaluationSourceFingerprints: evaluationSources(),
    developmentSeed: 0x26091851, confirmationSeed: 0x26091897, developmentPairs: 4, confirmationPairs: 32,
    minimumPairsPerOpponent: 30, opponents: [...OPPONENTS], targetWinRate: 0.5,
    policyOptions: trainer.searchApi().options({}), maxPlies: 640, maxGameMs: 30000,
    maxElapsedMs: 600000, compareLegacyBaseline: false, ...input };
  validateProtocol(protocol);
  return protocol;
}
function validateProtocol(protocol) {
  check(protocol && protocol.schema === PROTOCOL_SCHEMA && protocol.declaredBeforeV2Training === true
    && protocol.baselineModelFingerprint === trainer.BASELINE_MODEL && protocol.baselineRulesFingerprint === trainer.BASELINE_RULES,
  'A predeclared V2 benchmark protocol is required');
  for (const [name, min, max] of [['developmentSeed', 1, 0xffffffff], ['confirmationSeed', 1, 0xffffffff],
    ['developmentPairs', 1, 10000], ['confirmationPairs', 30, 10000], ['minimumPairsPerOpponent', 30, 10000],
    ['maxPlies', 1, 4096], ['maxGameMs', 1, 3600000], ['maxElapsedMs', 1, 86400000]]) {
    integer(name, protocol[name], min, max);
  }
  ratio('targetWinRate', protocol.targetWinRate, 0.5, 0.65);
  check(protocol.developmentSeed !== protocol.confirmationSeed
    && protocol.confirmationPairs >= protocol.minimumPairsPerOpponent, 'Protocol seeds/pair requirements overlap');
  check(Array.isArray(protocol.opponents) && protocol.opponents.length > 0
    && new Set(protocol.opponents).size === protocol.opponents.length
    && protocol.opponents.every(name => OPPONENTS.includes(name)), 'Protocol opponent pool invalid');
  check(typeof protocol.compareLegacyBaseline === 'boolean', 'Protocol baseline-control option invalid');
  check(canonical(protocol.policyOptions) === canonical(trainer.searchApi().options(protocol.policyOptions)),
    'Protocol policy options are not canonical');
  check(canonical(protocol.trainingSourceFingerprints) === canonical(trainer.sourceFingerprints())
    && canonical(protocol.evaluationSourceFingerprints) === canonical(evaluationSources()),
  'Protocol training/evaluation policy source bytes changed');
  const development = protocolRecords(protocol, 'development-validation');
  legacy.assertDisjointStreams(development);
  legacy.assertDisjointStreams(protocolRecords(protocol, 'held-out-confirmation'),
    development.flatMap(value => [value.streamSeeds.white, value.streamSeeds.dark]));
  return protocol;
}
function protocolRecords(protocol, purpose) {
  check(['development-validation', 'held-out-confirmation'].includes(purpose), 'Unknown evaluation purpose');
  const domain = purpose === 'development-validation' ? DEVELOPMENT_DOMAIN : CONFIRMATION_DOMAIN;
  const seed = purpose === 'development-validation' ? protocol.developmentSeed : protocol.confirmationSeed;
  const pairs = purpose === 'development-validation' ? protocol.developmentPairs : protocol.confirmationPairs;
  return protocol.opponents.flatMap(opponent => Array.from({ length: pairs }, (_, index) => ({
    opponent, pair: index + 1, streamSeeds: streamSeeds(domain, seed, index, opponent),
  })));
}
function protocolReservations(protocol) {
  validateProtocol(protocol);
  return [...protocolRecords(protocol, 'development-validation'), ...protocolRecords(protocol, 'held-out-confirmation')]
    .flatMap(record => [record.streamSeeds.white, record.streamSeeds.dark]);
}
function summarize(results, pending, protocol, purpose) {
  const candidateRows = results.filter(row => row.policy === 'candidate-v2');
  const requestedPairs = purpose === 'development-validation' ? protocol.developmentPairs : protocol.confirmationPairs;
  const groups = protocol.opponents.map(opponent => {
    const rows = candidateRows.filter(row => row.opponent === opponent);
    const pairedScores = [];
    for (let pair = 1; pair <= requestedPairs; pair += 1) {
      const legs = rows.filter(row => row.pair === pair);
      if (legs.length === 2) pairedScores.push(legs.filter(row => row.candidateWon).length / 2);
    }
    const wins = rows.filter(row => row.candidateWon).length;
    const confidence = pairedScores.length ? hard.pairedConfidence(pairedScores, 0.05 / protocol.opponents.length) : null;
    const severe = { mars: 0, koks: 0, other: 0 };
    for (const row of rows.filter(row => !row.candidateWon)) {
      if (['mars', 'gammon'].includes(row.resultType)) severe.mars += 1;
      else if (['koks', 'backgammon'].includes(row.resultType)) severe.koks += 1;
      else if (row.resultType !== 'normal') severe.other += 1;
    }
    return { opponent, requestedGames: requestedPairs * 2, completedGames: rows.length, wins,
      descriptiveWinRateOnCompletedGamesOnly: rows.length ? wins / rows.length : null,
      completeIndependentPairs: pairedScores.length, requestedIndependentPairs: requestedPairs,
      coverage: rows.length / (requestedPairs * 2), pairedConfidence: confidence, severeLosses: severe,
      censoredOrNotRunGames: pending.filter(row => row.policy === 'candidate-v2' && row.opponent === opponent).length };
  });
  const wins = candidateRows.filter(row => row.candidateWon).length;
  const complete = groups.every(group => group.coverage === 1);
  const currentHardIncluded = protocol.opponents.includes('current-hard');
  const strongPoolMilestonePassed = purpose === 'held-out-confirmation' && complete && currentHardIncluded
    && groups.every(group => group.completeIndependentPairs >= protocol.minimumPairsPerOpponent
      && group.pairedConfidence.lower >= protocol.targetWinRate);
  const baselineRows = results.filter(row => row.policy === 'legacy-448-control');
  return { completedGames: candidateRows.length, requestedGames: requestedPairs * 2 * protocol.opponents.length,
    wins, descriptiveWinRateOnCompletedGamesOnly: candidateRows.length ? wins / candidateRows.length : null,
    complete, censoredOrNotRunGames: pending.filter(row => row.policy === 'candidate-v2').length,
    opponents: groups, currentHardIncluded, strongPoolMilestonePassed,
    statisticalGate: 'one-sided paired Hoeffding lower bound per declared opponent, Bonferroni alpha; full coverage required',
    multipleComparisonCorrection: 'Bonferroni',
    ...(protocol.compareLegacyBaseline ? { baselineControl: {
      completedGames: baselineRows.length, wins: baselineRows.filter(row => row.candidateWon).length,
      descriptiveWinRateOnCompletedGamesOnly: baselineRows.length ? baselineRows.filter(row => row.candidateWon).length / baselineRows.length : null,
      exactSameSeatBoundDicePerLeg: true,
    } } : {}),
    scope: 'predeclared-offline-opponent-pool-not-human-or-production-win-rate', productionEligible: false,
    noAutomaticDeployment: true };
}

function validateReport(report, artifact = null) {
  check(report && report.schema === SCHEMA && report.mode === 'experimental-offline-v2-evaluation'
    && report.productionEligible === false && report.learningDuringEvaluation === false
    && report.modelFingerprint === report.modelFingerprintAfterEvaluation,
  'A frozen offline V2 evaluation report is required');
  const { reportFingerprint, ...body } = report;
  check(fingerprint(body) === reportFingerprint, 'V2 evaluation report body fingerprint mismatch');
  const protocol = validateProtocol(report.protocol);
  check(report.protocolFingerprint === fingerprint(protocol)
    && canonical(report.trainingSourceFingerprints) === canonical(trainer.sourceFingerprints())
    && canonical(report.evaluationSourceFingerprints) === canonical(evaluationSources())
    && report.runtimeFingerprint === protocol.trainingSourceFingerprints['game.js'], 'V2 report source/protocol mismatch');
  const expected = protocolRecords(protocol, report.purpose);
  const expectedKeys = new Set();
  for (const record of expected) for (const name of protocol.compareLegacyBaseline
    ? ['candidate-v2', 'legacy-448-control'] : ['candidate-v2']) for (let leg = 1; leg <= 2; leg += 1) {
    expectedKeys.add(`${record.opponent}:${record.pair}:${name}:${leg}`);
  }
  const runtime = legacy.loadLongGame(); const seen = new Set();
  const records = new Map(expected.map(record => [`${record.opponent}:${record.pair}`, record]));
  check(Array.isArray(report.results) && Array.isArray(report.pending), 'V2 report coverage records missing');
  for (const row of [...report.results, ...report.pending]) {
    const key = `${row.opponent}:${row.pair}:${row.policy}:${row.leg}`;
    const record = records.get(`${row.opponent}:${row.pair}`);
    check(expectedKeys.has(key) && !seen.has(key) && record
      && canonical(row.streamSeeds) === canonical(record.streamSeeds), 'V2 report duplicate/mismatched dice coverage');
    seen.add(key);
  }
  check(seen.size === expectedKeys.size, 'V2 report omitted requested/censored coverage');
  for (const row of report.results) {
    check(/^sha256:[a-f0-9]{64}$/.test(row.traceFingerprint), 'V2 report trace fingerprint missing');
    integer('recorded evaluation plies', row.plies, 1, protocol.maxPlies);
    if (row.policy === 'candidate-v2') trainer.validateSearchCoverage(row.searchCoverage, protocol.policyOptions, row.plies);
    legacy.neuralApi().validateState(row.terminalState);
    check(row.completed === true && row.candidateColor === (row.leg === 1 ? 'white' : 'dark')
      && row.winner === row.terminalState.winner && row.terminalState.phase === 'over'
      && row.candidateWon === (row.winner === row.candidateColor)
      && canonical(row.off) === canonical(row.terminalState.off)
      && row.resultType === (runtime.game.resultTypeFor(row.terminalState, row.winner) || 'normal'),
    'V2 report terminal result differs from actual recorded rule state');
  }
  if (report.results.some(row => row.opponent === 'current-hard')) {
    const captured = hard.readCurrentHardSnapshot(); const metadata = report.currentHard;
    check(metadata && metadata.runtimeFingerprint === captured.fingerprint
      && canonical(metadata.sourceFingerprints) === canonical(captured.sourceFingerprints)
      && metadata.engineVersion === 'long-analytic-v35' && metadata.experiencePatterns === 0
      && metadata.experienceFingerprint === fingerprintNamedBuffers([['experience.json', Buffer.from('[]')]])
      && metadata.learningDuringEvaluation === false && metadata.fallbackAllowed === false
      && metadata.policyWeightsFingerprint === 'sha256:f9f0c7b0c51f92362c965793c28114c98dd5a7cfb81c7ccf9bbff25711800cc0'
      && canonical(metadata.resources) === canonical({ strategyProfile: 'v25', maxCandidates: 64, analysisNodeBudget: 480 })
      && hard.APPROVED_V35_RUNTIME_TUPLES.some(tuple => metadata.policyImplementationId === tuple.policyImplementationId
        && captured.sourceFingerprints['game.js'] === `sha256:${tuple.gameBytesDigest}`
        && captured.sourceFingerprints['long-bot-engine.js'] === `sha256:${tuple.runtimeBytesDigest}`),
    'V2 report current-hard opponent provenance changed or was unfrozen');
  } else check(report.currentHard === undefined, 'V2 report claims a hard policy without completed hard-game evidence');
  check(report.pending.every(row => row.noResultOrWinCredit === true && typeof row.reason === 'string'
    && row.completed === undefined && row.winner === undefined && row.candidateWon === undefined),
  'V2 report credited a censored result');
  check(canonical(report.summary) === canonical(summarize(report.results, report.pending, protocol, report.purpose)),
    'V2 report summary/gate differs from recomputed complete paired coverage');
  if (report.purpose === 'held-out-confirmation') {
    check(report.confirmationConsumption && report.confirmationConsumption.singleUseAttempt === true
      && report.confirmationConsumption.censoredAttemptStillConsumesReservation === true
      && fingerprint(report.confirmationConsumption.reservation) === report.confirmationConsumption.reservationFingerprint
      && report.confirmationConsumption.reservation?.schema === 'long-neural-v2-single-confirmation-use-v1'
      && report.confirmationConsumption.reservation.status === 'reserved'
      && report.confirmationConsumption.reservation.protocolFingerprint === report.protocolFingerprint
      && report.confirmationConsumption.reservation.modelFingerprint === report.modelFingerprint
      && report.confirmationConsumption.reservation.artifactFingerprint === report.trainingArtifactFingerprint,
    'V2 confirmation report has no single-use reservation provenance');
  }
  if (artifact) {
    const manifest = trainer.validateArtifact(artifact);
    check(report.trainingArtifactFingerprint === artifact.artifactFingerprint && report.modelFingerprint === artifact.modelFingerprint,
      'V2 report does not evaluate this frozen candidate');
    check(report.protocolFingerprint === artifact.benchmarkProtocolFingerprint
      && canonical(report.protocol) === canonical(artifact.benchmarkProtocol),
    'V2 report protocol was not predeclared for this candidate lineage');
    legacy.assertDisjointStreams(expected, [...manifest.diceStreams, ...artifact.origin.historicalDiceStreams]);
  }
  return report.summary;
}

function runEvaluation(artifact, input = {}, dependencies = {}) {
  const protocol = validateProtocol(input.protocol);
  const purpose = input.purpose || 'development-validation';
  const records = protocolRecords(protocol, purpose);
  const runtime = legacy.loadLongGame();
  const manifest = trainer.validateArtifact(artifact, { runtime });
  check(artifact.benchmarkProtocolFingerprint === fingerprint(protocol)
    && canonical(artifact.benchmarkProtocol) === canonical(protocol),
  'Evaluation protocol was not bound before this V2 training lineage');
  // Resume may vary budgets/pool, but every evaluated episode uses the exact
  // predeclared search policy. Training/evaluation results stay separate.
  check(artifact.reservedDiceStreams && protocolReservations(protocol).every(seed => artifact.reservedDiceStreams.includes(seed)),
    'Training did not reserve the predeclared evaluation streams');
  legacy.assertDisjointStreams(records, [...manifest.diceStreams, ...artifact.origin.historicalDiceStreams]);
  const policy = trainer.searchApi(); const api = legacy.neuralApi();
  const frozen = clone(artifact.model); const before = legacy.modelFingerprint(frozen);
  const baseline = trainer.loadWarmStart().model;
  const hardSnapshot = protocol.opponents.includes('current-hard') ? hard.readCurrentHardSnapshot() : null;
  if (hardSnapshot) check(hardSnapshot.sourceFingerprints['game.js'] === runtime.fingerprint, 'Evaluation current-hard rules differ');
  const seed = purpose === 'development-validation' ? protocol.developmentSeed : protocol.confirmationSeed;
  let consumption = null;
  if (purpose === 'held-out-confirmation') {
    check(typeof input.confirmationJournal === 'string' && path.isAbsolute(input.confirmationJournal),
      'Held-out confirmation requires a fresh exclusive single-use journal');
    consumption = trainer.readJson(input.confirmationJournal, 1024 * 1024);
    check(consumption.schema === 'long-neural-v2-single-confirmation-use-v1' && consumption.status === 'reserved'
      && consumption.protocolFingerprint === fingerprint(protocol)
      && consumption.modelFingerprint === artifact.modelFingerprint
      && consumption.artifactFingerprint === artifact.artifactFingerprint, 'Confirmation reservation reused or mismatched');
    // Atomic claim also protects the library entry point: two processes that
    // read the same reserved journal cannot reveal two independent attempts.
    writeExclusive(`${input.confirmationJournal}.claim.json`, { schema: 'long-neural-v2-confirmation-claim-v1',
      reservationFingerprint: fingerprint(consumption) });
    legacy.writeJsonAtomic(input.confirmationJournal, { ...consumption, status: 'running' });
  }
  const started = performance.now(); const results = []; const pending = [];
  let hardMetadata = null;
  for (const record of records) {
    for (const name of protocol.compareLegacyBaseline ? ['candidate-v2', 'legacy-448-control'] : ['candidate-v2']) {
      for (let leg = 1; leg <= 2; leg += 1) {
        const remaining = Math.floor(protocol.maxElapsedMs - (performance.now() - started));
        const identity = { ...record, policy: name, leg };
        if (remaining <= 0) {
          pending.push({ ...identity, reason: 'not-started-total-budget', noResultOrWinCredit: true });
          continue;
        }
        const policySeeds = streamSeeds(POLICY_DOMAIN, seed, record.pair - 1, record.opponent);
        const candidate = name === 'candidate-v2' ? trainer.monitoredPolicy(policy.createNeuralBot(runtime.game, frozen, protocol.policyOptions), protocol.policyOptions)
          : api.createNeuralBot(runtime.game, baseline, { maxCandidates: 16, epsilon: 0 });
        const opponent = record.opponent === 'current-hard' ? hard.createCurrentHard(hardSnapshot)
          : record.opponent === 'legacy-neuro' ? api.createNeuralBot(runtime.game, baseline, { maxCandidates: 16, epsilon: 0 })
            : legacy.createBaseline(runtime.game, record.opponent, seededRandom(policySeeds.dark), protocol.policyOptions.maxCandidates);
        let episode;
        const episodeStarted = performance.now(); const episodeBudget = Math.min(remaining, protocol.maxGameMs);
        try {
          if (dependencies.workerEpisodes) {
            const worker = require('./long-neural-v2-episode-worker');
            const result = worker.runEpisodeInWorker(worker.createJob({ model: frozen, candidatePolicy: name,
              opponent: record.opponent, candidateColor: leg === 1 ? 'white' : 'dark', seeds: record.streamSeeds,
              policySeed: policySeeds.dark, policyOptions: protocol.policyOptions, maxPlies: protocol.maxPlies, maxGameMs: episodeBudget }));
            episode = result.episode;
            if (name === 'candidate-v2') Object.assign(candidate.coverage, result.searchCoverage);
            if (record.opponent === 'current-hard') opponent.metadata = result.hardMetadata;
          } else episode = (dependencies.playEpisode || legacy.playEpisode)({ game: runtime.game, candidate, opponent,
            candidateColor: leg === 1 ? 'white' : 'dark', seeds: record.streamSeeds,
            maxPlies: protocol.maxPlies, maxGameMs: episodeBudget, collectTraining: true });
          check(episode.completed === true, 'Censored game has no terminal completion');
          check(performance.now() - episodeStarted <= episodeBudget, 'Censored game exceeded per-game budget in its final winning plan');
          check(performance.now() - started <= protocol.maxElapsedMs, 'Censored game exceeded total budget before result credit');
        } catch (error) {
          if (!/^Censored game (?:exceeded|has no terminal)/.test(error.message)) throw error;
          pending.push({ ...identity, reason: error.message, noResultOrWinCredit: true });
          continue;
        }
        check(legacy.modelFingerprint(frozen) === before && legacy.modelFingerprint(baseline) === trainer.BASELINE_MODEL,
          'Frozen evaluation model changed; no gate issued');
        const terminalState = trainer.terminalStateForEpisode(episode, runtime.game);
        if (record.opponent === 'current-hard') {
          if (hardMetadata) check(canonical(hardMetadata) === canonical(opponent.metadata), 'Frozen current-hard policy changed');
          hardMetadata = clone(opponent.metadata);
        }
        const { afterstates, ...terminal } = episode;
        results.push({ ...identity, ...terminal, terminalState,
          ...(name === 'candidate-v2' ? { searchCoverage: clone(candidate.coverage) } : {}) });
        dependencies.onProgress?.({ opponent: record.opponent, pair: record.pair, leg, policy: name,
          completedGames: results.length, candidateWon: terminal.candidateWon, resultType: terminal.resultType,
          elapsedMs: performance.now() - started });
      }
    }
  }
  check(legacy.modelFingerprint(frozen) === before, 'Frozen model changed after evaluation');
  const body = { schema: SCHEMA, mode: 'experimental-offline-v2-evaluation', productionEligible: false,
    modelFingerprint: before, modelFingerprintAfterEvaluation: before, learningDuringEvaluation: false,
    trainingArtifactFingerprint: artifact.artifactFingerprint, protocolFingerprint: fingerprint(protocol), protocol: clone(protocol),
    runtimeFingerprint: runtime.fingerprint, trainingSourceFingerprints: trainer.sourceFingerprints(),
    evaluationSourceFingerprints: evaluationSources(), purpose,
    diceDomain: purpose === 'development-validation' ? DEVELOPMENT_DOMAIN : CONFIRMATION_DOMAIN,
    reservedTrainingStreamsDisjointVerified: true,
    confirmationIsSingleUseRequired: purpose === 'held-out-confirmation',
    ...(consumption ? { confirmationConsumption: { singleUseAttempt: true,
      reservation: clone(consumption), reservationFingerprint: fingerprint(consumption), censoredAttemptStillConsumesReservation: true } } : {}),
    ...(hardMetadata ? { currentHard: hardMetadata } : {}),
    results, pending, summary: summarize(results, pending, protocol, purpose) };
  const report = { ...body, reportFingerprint: fingerprint(body) };
  validateReport(report, artifact);
  if (consumption) legacy.writeJsonAtomic(input.confirmationJournal, { ...consumption, status: 'consumed',
    complete: report.summary.complete, reportFingerprint: report.reportFingerprint });
  return report;
}

function cliOptions(argv) {
  const parsed = parseCliTokens(argv, new Set(['model', 'output', 'protocol', 'purpose', 'development-seed',
    'confirmation-seed', 'development-pairs', 'confirmation-pairs', 'opponents', 'max-plies',
    'max-game-ms', 'max-elapsed-ms', 'max-candidates', 'reply-top-candidates', 'reply-candidates', 'reply-weight']),
  new Set(['help', 'declare-protocol', 'compare-legacy-baseline', 'require-gate']));
  return { parsed, output: parsed.values.get('output') || '' };
}
function writeExclusive(file, value) {
  trainer.validateOfflineOutput(file);
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}
function main(argv = process.argv.slice(2)) {
  const { parsed, output } = cliOptions(argv);
  if (parsed.flags.has('help')) {
    console.log('Offline V2 control: --declare-protocol --output /absolute/protocol.json OR --model /absolute/v2.json --protocol /absolute/protocol.json --purpose development-validation|held-out-confirmation --output /absolute/report.json');
    return;
  }
  trainer.validateOfflineOutput(output);
  if (parsed.flags.has('declare-protocol')) {
    const input = { policyOptions: {} };
    for (const [flag, key] of Object.entries({ 'development-seed': 'developmentSeed', 'confirmation-seed': 'confirmationSeed',
      'development-pairs': 'developmentPairs', 'confirmation-pairs': 'confirmationPairs', 'max-plies': 'maxPlies',
      'max-game-ms': 'maxGameMs', 'max-elapsed-ms': 'maxElapsedMs' })) {
      if (parsed.values.has(flag)) input[key] = Number(parsed.values.get(flag));
    }
    for (const [flag, key] of Object.entries({ 'max-candidates': 'maxCandidates', 'reply-top-candidates': 'replyTopCandidates',
      'reply-candidates': 'replyCandidates', 'reply-weight': 'replyWeight' })) {
      if (parsed.values.has(flag)) input.policyOptions[key] = Number(parsed.values.get(flag));
    }
    if (parsed.values.has('opponents')) input.opponents = parsed.values.get('opponents').split(',');
    input.compareLegacyBaseline = parsed.flags.has('compare-legacy-baseline');
    input.policyOptions = trainer.searchApi().options(input.policyOptions);
    const protocol = createProtocol(input);
    writeExclusive(output, protocol);
    console.log(JSON.stringify({ schema: protocol.schema, protocolFingerprint: fingerprint(protocol), output }));
    return;
  }
  const modelPath = parsed.values.get('model') || ''; const protocolPath = parsed.values.get('protocol') || '';
  check(path.isAbsolute(modelPath) && path.isAbsolute(protocolPath), '--model and --protocol require explicit absolute paths');
  const journalPath = `${protocolPath}.confirmation-use.json`;
  check(new Set([path.resolve(output), path.resolve(modelPath), path.resolve(protocolPath), path.resolve(journalPath)]).size === 4,
    'Model/protocol/report/confirmation journal paths must not overwrite each other');
  const artifact = trainer.readJson(modelPath); const protocol = trainer.readJson(protocolPath, 1024 * 1024);
  const purpose = parsed.values.get('purpose') || 'development-validation';
  validateProtocol(protocol); trainer.validateArtifact(artifact);
  let consumption = null;
  if (purpose === 'held-out-confirmation') {
    consumption = { schema: 'long-neural-v2-single-confirmation-use-v1', status: 'reserved',
      protocolFingerprint: fingerprint(protocol), modelFingerprint: artifact.modelFingerprint,
      artifactFingerprint: artifact.artifactFingerprint, createdAt: new Date().toISOString(),
      policy: 'one attempt including aborted/censored attempts; do not select another model on revealed outcomes' };
    writeExclusive(journalPath, consumption);
  }
  try {
    const report = runEvaluation(artifact, { protocol, purpose,
      ...(consumption ? { confirmationJournal: journalPath } : {}) }, {
      workerEpisodes: true,
      onProgress(value) { console.error(JSON.stringify({ event: 'v2-evaluation-completed-terminal', ...value })); },
    });
    legacy.writeJsonAtomic(output, report);
    if (consumption) legacy.writeJsonAtomic(journalPath, { ...consumption, status: 'consumed',
      complete: report.summary.complete, reportFingerprint: report.reportFingerprint });
    console.log(JSON.stringify({ schema: report.schema, modelFingerprint: report.modelFingerprint,
      ...report.summary, output }));
    if (parsed.flags.has('require-gate') && !report.summary.strongPoolMilestonePassed) process.exitCode = 1;
  } catch (error) {
    if (consumption) legacy.writeJsonAtomic(journalPath, { ...consumption, status: 'aborted', reason: error.message,
      noGateIssued: true });
    throw error;
  }
}
module.exports = { SCHEMA, PROTOCOL_SCHEMA, DEVELOPMENT_DOMAIN, CONFIRMATION_DOMAIN, POLICY_DOMAIN, OPPONENTS,
  evaluationSources, createProtocol, validateProtocol, protocolRecords, protocolReservations, summarize, validateReport,
  runEvaluation, cliOptions, writeExclusive, main };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || String(error)); process.exitCode = 2; }
}
