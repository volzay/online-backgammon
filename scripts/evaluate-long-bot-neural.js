#!/usr/bin/env node
'use strict';

// Held-out offline evaluation. A passed simple-pool gate is NOT permission to
// replace the production hard bot, nor a claim about human/tournament win rate.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { parseCliTokens, readRuntimeSnapshot, loadRuntime, fingerprintNamedBuffers } = require('./simulate-long-bot-regression');
const trainer = require('./train-long-bot-neural');
const { AUDITED_NATIVE_CACHE_POLICIES } = require('./long-bot-paired-rollout');
const SCHEMA = 'long-neural-evaluation-v1';
const OPPONENTS = Object.freeze(['random', 'pip', 'greedy', 'current-hard']);
const DEFAULT_OPPONENTS = Object.freeze(['random', 'pip', 'greedy']);
const HARNESS_FINGERPRINT = trainer.fingerprint(fs.readFileSync(__filename));
const ARTIFACT_VALIDATOR_CODE_FINGERPRINT = trainer.fingerprint(fs.readFileSync(require.resolve('../lib/long-neural-artifact')));
// These exact source tuples include the historical dispatcher and the
// history-free scratch-clone optimization. Candidate artifact validation below
// still requires its original training rules bytes; this does NOT migrate an
// old candidate or its confirmation statistics to the optimized runtime.
const APPROVED_V35_RUNTIME_TUPLES = AUDITED_NATIVE_CACHE_POLICIES;
const APPROVED_V35_STRONG_BOT_FINGERPRINT = 'sha256:49d17327ad4bc93393e1cf76619279341b520984be9af023c5b550091fd96573';
const APPROVED_V35_RESOURCES = Object.freeze({ strategyProfile: 'v25', maxCandidates: 64, analysisNodeBudget: 480 });
const APPROVED_V35_DISPATCH_WEIGHTS_FINGERPRINT = 'sha256:f9f0c7b0c51f92362c965793c28114c98dd5a7cfb81c7ccf9bbff25711800cc0';
const PURPOSES = Object.freeze(['development-validation', 'held-out-confirmation']);
const DEVELOPMENT_DOMAIN = 'nardu/long-neural/development-validation-dice/v1';

function readCurrentHardSnapshot() {
  const snapshot = readRuntimeSnapshot();
  return { entries: snapshot.entries.map(([name, bytes]) => [name, Buffer.from(bytes)]),
    fingerprint: snapshot.fingerprint,
    sourceFingerprints: Object.fromEntries(snapshot.entries.map(([name, bytes]) => [name, trainer.fingerprint(bytes)])) };
}
function loadNativeCurrentHard(snapshot) {
  const expectedNames = ['game.js', 'long-bot-engine.js', 'strong-bot.js'];
  if (!snapshot || !Array.isArray(snapshot.entries)
    || trainer.canonical(snapshot.entries.map(([name]) => name)) !== trainer.canonical(expectedNames)
    || fingerprintNamedBuffers(snapshot.entries) !== snapshot.fingerprint
    || snapshot.entries.some(([name, bytes]) => !Buffer.isBuffer(bytes)
      || trainer.fingerprint(bytes) !== snapshot.sourceFingerprints[name])) {
    throw new Error('Current-hard captured source fingerprint mismatch');
  }
  const storage = new Map(); const removed = new Set();
  const privateWindow = { localStorage: {
    getItem(key) {
      if (storage.has(key)) return storage.get(key);
      return /^narduh-long-bot-experience-v\d+$/.test(key) && !removed.has(key) ? '[]' : null;
    },
    setItem(key, value) { removed.delete(key); storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); removed.add(key); },
  } };
  privateWindow.window = privateWindow;
  const math = Object.create(Math);
  math.random = () => { throw new Error('Unseeded randomness is forbidden in current-hard evaluation'); };
  // Only the three captured trusted repository programs are compiled. This
  // private factory is not an uploaded model/code evaluator and has no access
  // to the real browser window, player storage or production network.
  for (const [name, bytes] of snapshot.entries) {
    const factory = vm.compileFunction(bytes.toString('utf8'),
      ['window', 'globalThis', 'Math', 'Date', 'console', 'setTimeout', 'clearTimeout', 'NarduGame', 'NarduLongBotEngine'],
      { filename: name });
    factory(privateWindow, privateWindow, math, Date, console, setTimeout, clearTimeout,
      privateWindow.NarduGame, privateWindow.NarduLongBotEngine);
  }
  privateWindow.NarduLongBotEngine.setExperience([], 'simulator');
  return { game: privateWindow.NarduGame, engine: privateWindow.NarduLongBotEngine,
    hardBot: privateWindow.NarduStrongBot, experienceCount: 0,
    experienceFingerprint: fingerprintNamedBuffers([['experience.json', Buffer.from('[]')]]) };
}
function createCurrentHard(snapshot, { loader = 'native' } = {}) {
  // The simulator loader evaluates captured bytes only. It does not invoke a
  // builder, modify policy files, access production, or load shared experience.
  if (!['native', 'vm'].includes(loader)) throw new Error('Unsupported current-hard loader');
  const frozen = loader === 'native' ? loadNativeCurrentHard(snapshot) : loadRuntime(undefined, snapshot);
  const approvedRuntime = APPROVED_V35_RUNTIME_TUPLES.find(tuple => frozen.engine.policyImplementationId === tuple.policyImplementationId
    && snapshot.sourceFingerprints['game.js'] === `sha256:${tuple.gameBytesDigest}`
    && snapshot.sourceFingerprints['long-bot-engine.js'] === `sha256:${tuple.runtimeBytesDigest}`);
  if (frozen.engine.version !== 'long-analytic-v35' || frozen.experienceCount !== 0
    || !approvedRuntime || snapshot.sourceFingerprints['strong-bot.js'] !== APPROVED_V35_STRONG_BOT_FINGERPRINT
    || trainer.canonical(frozen.engine.productionOptions) !== trainer.canonical(APPROVED_V35_RESOURCES)) {
    throw new Error('current-hard requires the exact frozen v35 dispatcher with empty experience');
  }
  frozen.engine.beginExperienceSession?.();
  frozen.engine.freezeExperience?.();
  const frozenExperience = frozen.engine.experienceReplaySnapshot?.();
  if (!frozenExperience || frozenExperience.engineVersion !== 'long-analytic-v35'
    || frozenExperience.frozen !== true || frozenExperience.size !== 0
    || !Array.isArray(frozenExperience.patterns) || frozenExperience.patterns.length !== 0) {
    throw new Error('current-hard requires a canonical frozen empty experience snapshot');
  }
  let policyFingerprint = null;
  const metadata = {
    runtimeFingerprint: snapshot.fingerprint, sourceFingerprints: snapshot.sourceFingerprints,
    engineVersion: frozen.engine.version, policyImplementationId: frozen.engine.policyImplementationId,
    resources: { ...frozen.engine.productionOptions }, experiencePatterns: 0,
    experienceFingerprint: frozen.experienceFingerprint, learningDuringEvaluation: false,
    fallbackAllowed: false,
  };
  return {
    metadata,
    plan(state) {
      const sequence = frozen.hardBot.plan(state, { ...frozen.engine.productionOptions });
      const decision = frozen.engine.consumeLastDecision?.();
      const fallback = frozen.hardBot.consumeLastFallbackDecision?.();
      if (!decision || decision.source !== 'engine' || decision.engineVersion !== 'long-analytic-v35' || fallback) {
        throw new Error('current-hard produced a fallback/unverified decision');
      }
      const weights = decision.weights;
      if (!weights || !Object.keys(weights).length
        || Object.values(weights).some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('current-hard omitted its finite production policy weights');
      }
      const key = trainer.fingerprint(weights);
      if (key !== APPROVED_V35_DISPATCH_WEIGHTS_FINGERPRINT) {
        throw new Error('current-hard dispatch weights do not match the approved v35 production policy');
      }
      if (policyFingerprint && policyFingerprint !== key) throw new Error('current-hard policy weights changed within evaluation');
      policyFingerprint = key;
      metadata.policyWeightsFingerprint = key;
      return sequence;
    },
  };
}

function evaluationOptions(input = {}) {
  const options = { pairs: 32, seed: 0x39e11, maxPlies: 640, maxCandidates: 16,
    maxGameMs: 30000, maxElapsedMs: 600000, targetWinRate: 0.65, minimumPairs: 30,
    purpose: 'held-out-confirmation', reservedSeed: null, protocolFingerprint: null,
    opponents: [...DEFAULT_OPPONENTS], ...input };
  trainer.integer('pairs', options.pairs, 1, 10000);
  trainer.integer('seed', options.seed, 1, 0xffffffff);
  trainer.integer('maxPlies', options.maxPlies, 1, 4096);
  trainer.integer('maxCandidates', options.maxCandidates, 1, 256);
  trainer.integer('maxGameMs', options.maxGameMs, 1, 3600000);
  trainer.integer('maxElapsedMs', options.maxElapsedMs, 1, 86400000);
  trainer.integer('minimumPairs', options.minimumPairs, 30, 10000);
  trainer.ratio('targetWinRate', options.targetWinRate, 0.5, 1);
  if (!PURPOSES.includes(options.purpose)) throw new Error('Invalid evaluation purpose');
  if (options.reservedSeed !== null) {
    trainer.integer('reservedSeed', options.reservedSeed, 1, 0xffffffff);
    if (options.purpose === 'development-validation' && options.seed === options.reservedSeed) {
      throw new Error('Development validation cannot consume the reserved held-out confirmation seed');
    }
    if (options.purpose === 'held-out-confirmation' && options.seed !== options.reservedSeed) {
      throw new Error('Confirmation must use the predeclared reserved seed');
    }
  }
  if (options.protocolFingerprint !== null && !/^sha256:[a-f0-9]{64}$/.test(options.protocolFingerprint)) {
    throw new Error('Invalid protocol fingerprint');
  }
  if (!Array.isArray(options.opponents) || !options.opponents.length
    || new Set(options.opponents).size !== options.opponents.length
    || options.opponents.some(name => !OPPONENTS.includes(name))) {
    throw new Error('Evaluation opponents must be unique random/pip/greedy/current-hard names');
  }
  return options;
}

function validateTrainingArtifact(artifact, api, runtime) {
  if (typeof trainer.validateTrainingProvenance === 'function') {
    return trainer.validateTrainingProvenance(artifact, api, runtime);
  }
  if (!artifact || artifact.schema !== trainer.SCHEMA || artifact.mode !== 'experimental-offline-candidate'
    || artifact.productionEligible !== false) throw new Error('A complete offline training artifact is required');
  api.validateModel(artifact.model);
  if (artifact.modelFingerprint !== trainer.modelFingerprint(artifact.model)) throw new Error('Training model fingerprint mismatch');
  if (artifact.runtimeFingerprint !== runtime.fingerprint) throw new Error('Training/evaluation rules bytes differ; retrain this candidate');
  const inferenceHash = trainer.NEURAL_CODE_FINGERPRINT;
  if (artifact.inferenceCodeFingerprint !== inferenceHash) throw new Error('Training/evaluation inference bytes differ; retrain this candidate');
  if (artifact.seedStreamHelperFingerprint !== trainer.SEED_HELPER_FINGERPRINT) {
    throw new Error('Training/evaluation dice stream helper bytes differ; retrain this candidate');
  }
  const manifest = artifact.trainingManifest;
  if (!manifest || manifest.algorithm !== 'episodic-terminal-only-TD(0)' || manifest.target !== 'win-probability'
    || manifest.diceDomain !== trainer.TRAIN_DOMAIN) throw new Error('Invalid training provenance');
  trainer.integer('training games', manifest.games, 1, 100000);
  trainer.integer('training seed', manifest.seed, 1, 0xffffffff);
  if (!Array.isArray(manifest.diceStreams) || manifest.diceStreams.length !== manifest.games * 2
    || new Set(manifest.diceStreams).size !== manifest.diceStreams.length
    || !Array.isArray(artifact.results) || artifact.results.length !== manifest.games) {
    throw new Error('Incomplete or repeated training dice provenance');
  }
  const expected = [];
  let samples = 0;
  for (let index = 0; index < manifest.games; index += 1) {
    const result = artifact.results[index];
    const seeds = trainer.streamSeeds(trainer.TRAIN_DOMAIN, manifest.seed, index);
    expected.push(seeds.white, seeds.dark);
    if (result.game !== index + 1 || result.completed !== true
      || !['white', 'dark'].includes(result.winner)
      || trainer.canonical(result.streamSeeds) !== trainer.canonical(seeds)) {
      throw new Error('Censored/mismatched game in training manifest');
    }
    samples += trainer.integer('training samples per game', result.trainingSamples, 1, 8192);
  }
  if (trainer.canonical(expected) !== trainer.canonical(manifest.diceStreams)
    || manifest.samples !== samples || artifact.model.trainingSteps !== samples) {
    throw new Error('Training seed/sample manifest does not match the model');
  }
  return manifest;
}

function wilson(wins, games, z = 1.959963984540054) {
  trainer.integer('games', games, 1, 1000000);
  trainer.integer('wins', wins, 0, games);
  const p = wins / games;
  const denominator = 1 + z * z / games;
  const center = (p + z * z / (2 * games)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / games + z * z / (4 * games * games)) / denominator;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half),
    descriptiveOnly: true, assumption: 'individual games independent; paired legs are correlated, so this does not decide the gate' };
}

function pairedConfidence(scores, alpha) {
  if (!Array.isArray(scores) || !scores.length || scores.some(value => ![0, 0.5, 1].includes(value))) {
    throw new Error('At least one complete independent pair is required');
  }
  trainer.ratio('alpha', alpha, Number.MIN_VALUE, 1);
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const radius = Math.sqrt(Math.log(1 / alpha) / (2 * scores.length));
  return { method: 'one-sided-Hoeffding-bound-on-independent-pair-scores',
    independentUnit: 'two color-swapped games on the same seat-bound dice streams',
    pairs: scores.length, mean, alpha, lower: Math.max(0, mean - radius) };
}

function validateBenchmarkProtocol(protocol) {
  if (!protocol || protocol.schema !== 'long-neural-benchmark-protocol-v1'
    || protocol.createdBeforeTraining !== true
    || trainer.canonical(protocol.opponents) !== trainer.canonical(DEFAULT_OPPONENTS)) {
    throw new Error('Research protocol requires the fixed random/pip/greedy pool and a predeclared reservation');
  }
  trainer.ratio('protocol targetWinRate', protocol.targetWinRate, 0.5, 0.5);
  trainer.integer('protocol minimumPairsPerOpponent', protocol.minimumPairsPerOpponent, 30, 10000);
  trainer.integer('protocol validationSeed', protocol.validationSeed, 1, 0xffffffff);
  trainer.integer('protocol confirmationSeed', protocol.confirmationSeed, 1, 0xffffffff);
  trainer.integer('protocol validationPairs', protocol.validationPairs, 1, 10000);
  trainer.integer('protocol confirmationPairs', protocol.confirmationPairs, protocol.minimumPairsPerOpponent, 10000);
  trainer.integer('protocol maxCandidates', protocol.maxCandidates, 1, 256);
  trainer.integer('protocol maxPlies', protocol.maxPlies, 1, 4096);
  if (protocol.validationSeed === protocol.confirmationSeed
    || !/^sha256:[a-f0-9]{64}$/.test(protocol.baselineModelFingerprint || '')) {
    throw new Error('Research protocol needs distinct validation/confirmation seeds and a pinned baseline');
  }
  return protocol;
}

function protocolOptions(protocol, purpose, supplied = {}) {
  validateBenchmarkProtocol(protocol);
  if (!PURPOSES.includes(purpose)) throw new Error('Invalid evaluation purpose');
  const expected = {
    seed: purpose === 'development-validation' ? protocol.validationSeed : protocol.confirmationSeed,
    pairs: purpose === 'development-validation' ? protocol.validationPairs : protocol.confirmationPairs,
    maxCandidates: protocol.maxCandidates, maxPlies: protocol.maxPlies,
    targetWinRate: protocol.targetWinRate, minimumPairs: protocol.minimumPairsPerOpponent,
    opponents: [...protocol.opponents], purpose, reservedSeed: protocol.confirmationSeed,
    protocolFingerprint: trainer.fingerprint(protocol),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (Object.hasOwn(supplied, key) && trainer.canonical(supplied[key]) !== trainer.canonical(value)) {
      throw new Error(`Evaluation ${key} differs from the predeclared protocol`);
    }
  }
  return evaluationOptions({ ...supplied, ...expected });
}

function summarizeResults(results, options) {
  if (!Array.isArray(results) || results.length !== options.opponents.length * options.pairs * 2) {
    throw new Error('Incomplete paired evaluation; no win-rate gate can be issued');
  }
  const groups = {};
  const allPairScores = [];
  const seenStreams = new Set();
  for (const name of options.opponents) {
    const games = results.filter(result => result.opponent === name);
    const scores = [];
    for (let pair = 0; pair < options.pairs; pair += 1) {
      const legs = games.filter(result => result.pair === pair + 1);
      if (legs.length !== 2 || legs.some(result => result.completed !== true)
        || new Set(legs.map(result => result.leg)).size !== 2
        || new Set(legs.map(result => result.candidateColor)).size !== 2
        || trainer.canonical(legs[0].streamSeeds) !== trainer.canonical(legs[1].streamSeeds)) {
        throw new Error('Missing, censored, or unpaired evaluation legs');
      }
      if (legs.some(result => !['white', 'dark'].includes(result.winner)
        || ![1, 2].includes(result.leg)
        || !['normal', 'mars', 'koks'].includes(result.resultType)
        || result.candidateWon !== (result.winner === result.candidateColor)
        || result.candidateColor !== (result.leg === 1 ? 'white' : 'dark'))) {
        throw new Error('Evaluation outcome/color assignment is inconsistent');
      }
      for (const color of ['white', 'dark']) {
        const seed = legs[0].streamSeeds[color];
        trainer.integer('paired dice stream seed', seed, 1, 0xffffffff);
        if (seenStreams.has(seed)) throw new Error('Repeated dice streams do not form independent evaluation pairs');
        seenStreams.add(seed);
      }
      scores.push(legs.filter(result => result.candidateWon).length / 2);
    }
    const wins = games.filter(result => result.candidateWon).length;
    allPairScores.push(...scores);
    const confidence = pairedConfidence(scores, 0.05 / options.opponents.length);
    groups[name] = { games: games.length, wins, winRate: wins / games.length,
      severeLosses: games.filter(result => !result.candidateWon && result.resultType !== 'normal').length,
      descriptiveWilson95: wilson(wins, games.length), pairedConfidence: confidence,
      gatePassed: options.pairs >= options.minimumPairs && confidence.lower >= options.targetWinRate };
  }
  const poolGatePassed = Object.values(groups).every(group => group.gatePassed);
  const currentHardIncluded = options.opponents.includes('current-hard');
  const wins = results.filter(result => result.candidateWon).length;
  const aggregateConfidence = pairedConfidence(allPairScores, 0.05);
  aggregateConfidence.independentUnit = 'color-swapped seat-bound pair; fixed equal opponent strata, independent non-identical pair variables';
  const fixedResearchPool = trainer.canonical(options.opponents) === trainer.canonical(DEFAULT_OPPONENTS);
  const researchMilestonePassed = options.targetWinRate === 0.5 && fixedResearchPool
    && options.purpose === 'held-out-confirmation' && options.pairs >= options.minimumPairs
    && options.reservedSeed === options.seed && !!options.protocolFingerprint
    && aggregateConfidence.lower >= 0.5;
  return { completedGames: results.length, targetWinRate: options.targetWinRate,
    minimumPairsPerOpponent: options.minimumPairs,
    scope: options.purpose === 'development-validation'
      ? (currentHardIncluded ? 'development-validation-defined-opponent-pool-including-frozen-current-hard' : 'development-validation-defined-simple-opponent-pool-only')
      : (currentHardIncluded ? 'held-out-defined-opponent-pool-including-frozen-current-hard' : 'held-out-defined-simple-opponent-pool-only'),
    multipleComparisonCorrection: 'Bonferroni across opponent-specific paired bounds',
    opponents: groups, poolGatePassed, currentHardIncluded,
    aggregate: { games: results.length, wins, winRate: wins / results.length,
      observedAtLeast50Percent: wins / results.length >= 0.5,
      pairedConfidence: aggregateConfidence,
      scope: fixedResearchPool ? 'fixed-balanced-random-pip-greedy-research-pool' : 'declared-equal-strata-opponent-pool',
      doesNotEstimateHumanOrProductionWinRate: true },
    researchMilestonePassed,
    researchMilestoneRequirement: 'predeclared 50% protocol, reserved single frozen-model confirmation, at least 30 independent pairs per fixed random/pip/greedy opponent, one-sided aggregate paired Hoeffding lower bound >= 0.5',
    purpose: options.purpose,
    gatePassed: currentHardIncluded && poolGatePassed && options.targetWinRate >= 0.65
      && options.purpose === 'held-out-confirmation',
    productionEligible: false,
    deploymentRequirement: 'separate frozen production-hard-bot and human-calibrated benchmark; no automatic activation' };
}

function runEvaluation(artifact, input = {}, dependencies = {}) {
  const { benchmarkProtocol, ...plainInput } = input;
  const options = benchmarkProtocol ? protocolOptions(benchmarkProtocol,
    plainInput.purpose || 'held-out-confirmation', plainInput) : evaluationOptions(plainInput);
  const api = dependencies.api || trainer.neuralApi();
  const runtime = dependencies.runtime || trainer.loadLongGame();
  const manifest = validateTrainingArtifact(artifact, api, runtime);
  const currentHardSnapshot = options.opponents.includes('current-hard') ? readCurrentHardSnapshot() : null;
  if (currentHardSnapshot && currentHardSnapshot.sourceFingerprints['game.js'] !== runtime.fingerprint) {
    throw new Error('Candidate/current-hard rules bytes differ');
  }
  const frozenModel = trainer.clone(artifact.model);
  const initialFingerprint = trainer.modelFingerprint(frozenModel);
  const records = [];
  const diceDomain = options.purpose === 'development-validation' ? DEVELOPMENT_DOMAIN : trainer.EVALUATION_DOMAIN;
  for (const opponent of options.opponents) {
    for (let pair = 0; pair < options.pairs; pair += 1) {
      records.push({ opponent, pair: pair + 1,
        streamSeeds: trainer.streamSeeds(diceDomain, options.seed, pair, opponent) });
    }
  }
  trainer.assertDisjointStreams(records, manifest.diceStreams);
  const started = performance.now();
  const results = [];
  let currentHardMetadata = null;
  for (const record of records) {
    for (let leg = 0; leg < 2; leg += 1) {
      if (performance.now() - started > options.maxElapsedMs) throw new Error('Evaluation exceeded total wall-time budget; no gate issued');
      const policySeeds = trainer.streamSeeds('nardu/long-neural/evaluation-policy/v1', options.seed,
        record.pair - 1, record.opponent);
      const candidate = api.createNeuralBot(runtime.game, frozenModel, {
        epsilon: 0, rng: () => { throw new Error('Evaluation candidate must not explore or draw random values'); },
        maxCandidates: options.maxCandidates,
      });
      const opponent = record.opponent === 'current-hard'
        ? createCurrentHard(currentHardSnapshot)
        : trainer.createBaseline(runtime.game, record.opponent,
          trainer.seededRandom(policySeeds.dark), options.maxCandidates);
      const episode = (dependencies.playEpisode || trainer.playEpisode)({ game: runtime.game, candidate, opponent,
        candidateColor: leg === 0 ? 'white' : 'dark', seeds: record.streamSeeds,
        maxPlies: options.maxPlies, maxGameMs: options.maxGameMs, collectTraining: false });
      if (!episode.completed) throw new Error('Censored evaluation game; no gate issued');
      if (trainer.modelFingerprint(frozenModel) !== initialFingerprint) throw new Error('Evaluation model changed: learning is forbidden');
      if (record.opponent === 'current-hard') {
        if (currentHardMetadata && trainer.canonical(currentHardMetadata) !== trainer.canonical(opponent.metadata)) {
          throw new Error('Frozen current-hard metadata/policy changed between games');
        }
        currentHardMetadata = { ...opponent.metadata };
      }
      const { afterstates, ...result } = episode;
      results.push({ ...record, leg: leg + 1, ...result });
    }
  }
  const finalFingerprint = trainer.modelFingerprint(frozenModel);
  if (initialFingerprint !== finalFingerprint) throw new Error('Evaluation model mutation detected');
  return { schema: SCHEMA, mode: 'experimental-offline-evaluation',
    trainingArtifactFingerprint: trainer.fingerprint(artifact), modelFingerprint: initialFingerprint,
    modelFingerprintAfterEvaluation: finalFingerprint, learningDuringEvaluation: false,
    runtimeFingerprint: runtime.fingerprint,
    inferenceCodeFingerprint: artifact.inferenceCodeFingerprint,
    harnessFingerprint: HARNESS_FINGERPRINT,
    evaluationTrainerFingerprint: trainer.HARNESS_FINGERPRINT,
    artifactValidatorCodeFingerprint: ARTIFACT_VALIDATOR_CODE_FINGERPRINT,
    trainingHarnessFingerprint: artifact.harnessFingerprint,
    seedStreamHelperFingerprint: trainer.SEED_HELPER_FINGERPRINT,
    ...(currentHardMetadata ? { currentHard: currentHardMetadata } : {}),
    diceDomain, trainingDiceStreamsDisjointVerified: true,
    heldOutDiceStreamsVerified: options.purpose === 'held-out-confirmation',
    developmentValidationMayBeReusedForModelSelection: options.purpose === 'development-validation',
    ...(benchmarkProtocol ? { benchmarkProtocol: trainer.clone(benchmarkProtocol),
      benchmarkProtocolFingerprint: options.protocolFingerprint } : {}),
    options, summary: summarizeResults(results, options), results };
}

function cliOptions(argv) {
  const values = new Set(['model', 'output', 'pairs', 'seed', 'max-plies', 'max-candidates',
    'max-game-ms', 'max-elapsed-ms', 'target-win-rate', 'minimum-pairs', 'opponents',
    'purpose', 'reserved-seed', 'protocol']);
  const parsed = parseCliTokens(argv, values, new Set(['help', 'require-gate']));
  if (parsed.flags.has('help')) return { help: true };
  const options = {};
  const mapping = { pairs: 'pairs', seed: 'seed', 'max-plies': 'maxPlies', 'max-candidates': 'maxCandidates',
    'max-game-ms': 'maxGameMs', 'max-elapsed-ms': 'maxElapsedMs', 'target-win-rate': 'targetWinRate',
    'minimum-pairs': 'minimumPairs', 'reserved-seed': 'reservedSeed' };
  for (const [flag, key] of Object.entries(mapping)) if (parsed.values.has(flag)) options[key] = Number(parsed.values.get(flag));
  if (parsed.values.has('opponents')) options.opponents = parsed.values.get('opponents').split(',');
  if (parsed.values.has('purpose')) options.purpose = parsed.values.get('purpose');
  return { options: evaluationOptions(options), model: parsed.values.get('model') || '',
    suppliedOptions: options, protocol: parsed.values.get('protocol') || '',
    output: parsed.values.get('output') || '', requireGate: parsed.flags.has('require-gate') };
}
function main(argv = process.argv.slice(2)) {
  const parsed = cliOptions(argv);
  if (parsed.help) {
    console.log('Offline long neural evaluation: --model /absolute/candidate.json --output /absolute/evaluation.json [--protocol /absolute/protocol.json --purpose development-validation|held-out-confirmation] [--pairs 32 --seed 237073 --target-win-rate 0.65 --opponents random,pip,greedy,current-hard] [--require-gate]');
    return;
  }
  if (!parsed.model || !parsed.output || !path.isAbsolute(parsed.model) || !path.isAbsolute(parsed.output)) {
    throw new Error('--model and --output require explicit absolute artifact paths');
  }
  if (path.resolve(parsed.model) === path.resolve(parsed.output)) throw new Error('Evaluation output must not overwrite the candidate model');
  const bytes = fs.readFileSync(parsed.model);
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Training artifact exceeds the 16 MiB offline input limit');
  const artifact = JSON.parse(bytes.toString('utf8'));
  let evaluationInput = parsed.options;
  let confirmationJournal = null;
  let confirmationRecord = null;
  if (parsed.protocol) {
    if (!path.isAbsolute(parsed.protocol)) throw new Error('--protocol requires an explicit absolute path');
    if ([parsed.model, parsed.output].some(file => path.resolve(file) === path.resolve(parsed.protocol))) {
      throw new Error('Protocol must not be overwritten by a model or evaluation report');
    }
    const protocolBytes = fs.readFileSync(parsed.protocol);
    if (protocolBytes.length > 1024 * 1024) throw new Error('Protocol exceeds the 1 MiB input limit');
    const protocol = JSON.parse(protocolBytes.toString('utf8'));
    evaluationInput = { ...parsed.suppliedOptions, benchmarkProtocol: protocol };
    const purpose = parsed.suppliedOptions.purpose || 'held-out-confirmation';
    const pinnedOptions = protocolOptions(protocol, purpose, parsed.suppliedOptions);
    if (purpose === 'held-out-confirmation') {
      const runtime = trainer.loadLongGame();
      validateTrainingArtifact(artifact, trainer.neuralApi(), runtime);
      confirmationJournal = `${parsed.protocol}.confirmation-use.json`;
      if ([parsed.model, parsed.output].some(file => path.resolve(file) === path.resolve(confirmationJournal))) {
        throw new Error('Confirmation journal must not be overwritten by a model or evaluation report');
      }
      confirmationRecord = { schema: 'long-neural-single-confirmation-use-v1', status: 'reserved',
        createdAt: new Date().toISOString(), modelFingerprint: artifact.modelFingerprint,
        trainingArtifactFingerprint: trainer.fingerprint(artifact),
        benchmarkProtocolFingerprint: trainer.fingerprint(protocol),
        runtimeFingerprint: runtime.fingerprint, inferenceCodeFingerprint: trainer.NEURAL_CODE_FINGERPRINT,
        evaluationHarnessFingerprint: HARNESS_FINGERPRINT,
        evaluationTrainerFingerprint: trainer.HARNESS_FINGERPRINT,
        artifactValidatorCodeFingerprint: ARTIFACT_VALIDATOR_CODE_FINGERPRINT,
        seedStreamHelperFingerprint: trainer.SEED_HELPER_FINGERPRINT,
        options: pinnedOptions,
        reusePolicy: 'one attempt for this reserved protocol, including aborted/censored attempts; declare a fresh protocol and untouched seed before any further model selection',
      };
      // An exclusive create prevents retrying another selected model on a seed
      // whose outcomes have already been revealed. Development reports may be
      // reused; this journal is deliberately irreversible within the protocol.
      let descriptor;
      try { descriptor = fs.openSync(confirmationJournal, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('Reserved confirmation protocol already consumed; reuse is forbidden');
        throw error;
      }
      try { fs.writeFileSync(descriptor, `${JSON.stringify(confirmationRecord, null, 2)}\n`); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
    }
  }
  let report;
  try {
    report = runEvaluation(artifact, evaluationInput);
    if (confirmationJournal) report.confirmationConsumption = { journal: confirmationJournal,
      singleAttemptExclusiveCreate: true, identityFingerprint: trainer.fingerprint(confirmationRecord) };
    trainer.writeJsonAtomic(parsed.output, report);
    if (confirmationJournal) trainer.writeJsonAtomic(confirmationJournal, { ...confirmationRecord,
      status: 'complete', completedAt: new Date().toISOString(),
      evaluationReportFingerprint: trainer.fingerprint(report), summary: report.summary });
  } catch (error) {
    if (confirmationJournal) trainer.writeJsonAtomic(confirmationJournal, { ...confirmationRecord,
      status: 'aborted', abortedAt: new Date().toISOString(), reason: String(error.message),
      noWinRateOrGateIssued: true });
    throw error;
  }
  console.log(JSON.stringify({ schema: report.schema, modelFingerprint: report.modelFingerprint, ...report.summary, output: parsed.output }));
  if (parsed.requireGate && !(report.options.targetWinRate === 0.5
    ? report.summary.researchMilestonePassed : report.summary.gatePassed)) process.exitCode = 1;
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || String(error)); process.exitCode = 2; }
}
module.exports = { SCHEMA, OPPONENTS, PURPOSES, DEVELOPMENT_DOMAIN, readCurrentHardSnapshot,
  APPROVED_V35_RUNTIME_TUPLES,
  loadNativeCurrentHard, createCurrentHard, evaluationOptions, validateTrainingArtifact, wilson, pairedConfidence,
  validateBenchmarkProtocol, protocolOptions, summarizeResults, runEvaluation, cliOptions, main };
