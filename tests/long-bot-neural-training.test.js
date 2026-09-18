'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const trainer = require('../scripts/train-long-bot-neural');
const evaluator = require('../scripts/evaluate-long-bot-neural');
const neural = require('../lib/long-bot-neural');
const runtime = trainer.loadLongGame();
let candidate;

test.before(() => {
  candidate = trainer.runTraining({ games: 2, seed: 236049, hiddenSize: 8,
    maxCandidates: 4, opponents: ['self', 'pip'], maxElapsedMs: 60000 });
});

test('offline captured rules factory loads exactly game.js and prohibits unseeded dice', () => {
  assert.match(runtime.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => runtime.game.rollDice(), /Unseeded randomness/);
  assert.equal(runtime.game.initialState('long').startedAt, 1);
});

test('captured private rules factory preserves two full VM episode traces and trained weights', () => {
  const bytes = fs.readFileSync(path.join(trainer.ROOT, 'game.js'));
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => { throw new Error('Unseeded randomness is forbidden in neural experiments'); };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [1])); }
    static now() { return 1; }
  }
  const context = { window: {}, Math: deterministicMath, Date: FixedDate };
  vm.createContext(context);
  vm.runInContext(bytes.toString('utf8'), context, { filename: 'game.js', timeout: 10000 });
  const legacyVmRuntime = { game: context.window.NarduGame, fingerprint: trainer.fingerprint(bytes) };
  const compiledRuntime = trainer.loadLongGame();
  const options = { games: 2, seed: 236051, hiddenSize: 32, maxCandidates: 16,
    learningRate: 0.05, opponents: ['self', 'pip'], maxElapsedMs: 60000 };
  const legacy = trainer.runTraining(options, { runtime: legacyVmRuntime });
  const compiled = trainer.runTraining(options, { runtime: compiledRuntime });
  assert.equal(compiled.runtimeFingerprint, legacy.runtimeFingerprint);
  assert.equal(compiled.modelFingerprint, legacy.modelFingerprint);
  assert.deepEqual(compiled.model, legacy.model);
  assert.deepEqual(compiled.results, legacy.results);
  assert.deepEqual(compiled.trainingManifest, legacy.trainingManifest);
  assert.equal(trainer.HARNESS_FINGERPRINT, trainer.fingerprint(fs.readFileSync(path.join(trainer.ROOT,
    'scripts/train-long-bot-neural.js'))));
});

test('captured trusted CommonJS core is numerically identical to native gradients', () => {
  const captured = trainer.neuralApi();
  const original = neural.createModel({ seed: 236049, hiddenSize: 32 });
  const compiled = captured.createModel({ seed: 236049, hiddenSize: 32 });
  const board = runtime.game.initialState('long');
  board.turn = 'white'; board.phase = 'roll';
  for (let index = 0; index < 100; index += 1) {
    const color = index % 2 ? 'dark' : 'white';
    const target = index % 2 ? 0.1 : 0.9;
    neural.trainSample(original, board, color, target, { learningRate: 0.05 });
    captured.trainSample(compiled, board, color, target, { learningRate: 0.05 });
  }
  assert.deepEqual(compiled, original);
  assert.equal(trainer.modelFingerprint(compiled), trainer.modelFingerprint(original));
  assert.equal(trainer.NEURAL_CODE_FINGERPRINT,
    trainer.fingerprint(fs.readFileSync(path.join(trainer.ROOT, 'lib/long-bot-neural.js'))));
  assert.equal(candidate.inferenceCodeFingerprint, trainer.NEURAL_CODE_FINGERPRINT);
});

test('training and held-out seat-bound streams are domain separated and collision checked', () => {
  const train = Array.from({ length: 100 }, (_, index) => ({
    streamSeeds: trainer.streamSeeds(trainer.TRAIN_DOMAIN, 1, index),
  }));
  const heldOut = Array.from({ length: 100 }, (_, index) => ({
    streamSeeds: trainer.streamSeeds(trainer.EVALUATION_DOMAIN, 1, index, 'pip'),
  }));
  const forbidden = train.flatMap(record => [record.streamSeeds.white, record.streamSeeds.dark]);
  assert.equal(trainer.assertDisjointStreams(heldOut, forbidden), true);
  assert.throws(() => trainer.assertDisjointStreams([train[0]], forbidden), /collision/);
  assert.throws(() => trainer.assertDisjointStreams([train[0], train[0]]), /collision/);
  assert.throws(() => trainer.streamSeeds(trainer.TRAIN_DOMAIN, 0, 1), /seed/);
});

test('real complete self-play games produce TD updates and immutable fingerprints', () => {
  assert.equal(candidate.schema, trainer.SCHEMA);
  assert.equal(candidate.productionEligible, false);
  assert.equal(candidate.results.length, 2);
  assert(candidate.results.every(result => result.completed && ['white', 'dark'].includes(result.winner)));
  assert(candidate.trainingManifest.samples > 0);
  assert.equal(candidate.trainingManifest.samples, candidate.model.trainingSteps);
  assert.notEqual(candidate.modelFingerprint, candidate.initialModelFingerprint);
  assert.equal(candidate.modelFingerprint, trainer.modelFingerprint(candidate.model));
  assert.equal(evaluator.validateTrainingArtifact(candidate, neural, runtime).games, 2);
});

test('seeded complete-game training is exactly reproducible', () => {
  const second = trainer.runTraining(candidate.trainingManifest.options);
  assert.equal(second.modelFingerprint, candidate.modelFingerprint);
  assert.deepEqual(second.results, candidate.results);
  assert.deepEqual(second.trainingManifest, candidate.trainingManifest);
});

test('TD bootstrap uses same-color nonterminal afterstates and terminal reward', () => {
  const early = { marker: 'early', winner: null };
  const later = { marker: 'later', winner: null };
  const terminal = { marker: 'terminal', winner: 'white' };
  const calls = [];
  const samples = trainer.tdTargets({ predict(model, state, color) { calls.push([state.marker, color]); return 0.7; } }, {}, {
    completed: true, winner: 'white', afterstates: { white: [early, later, terminal], dark: [early] },
  }, ['white', 'dark']);
  assert.deepEqual(calls, [['later', 'white']]);
  assert.deepEqual(samples.map(sample => [sample.state.marker, sample.color, sample.target]),
    [['early', 'white', 0.7], ['later', 'white', 1], ['early', 'dark', 0]]);
  assert.throws(() => trainer.tdTargets({}, {}, { completed: false, winner: null }, ['white']), /terminal complete/);
});

test('terminal-only TD lambda interpolation and Monte Carlo preserve frozen targets', () => {
  const episode = { completed: true, winner: 'white', afterstates: {
    white: [{ marker: 'a' }, { marker: 'b' }, { marker: 'c' }, { winner: 'white' }],
    dark: [{ marker: 'a' }, { marker: 'b' }],
  } };
  const api = { predict(model, state) { return state.marker === 'b' ? 0.2 : 0.4; } };
  const mixed = trainer.tdTargets(api, {}, episode, ['white'], 0.5);
  assert.deepEqual(mixed.map(sample => sample.target), [0.44999999999999996, 0.7, 1]);
  const mc = trainer.tdTargets({ predict() { throw new Error('MC must not bootstrap'); } }, {}, episode, ['white', 'dark'], 1);
  assert.deepEqual(mc.map(sample => [sample.color, sample.target]), [['white', 1], ['white', 1], ['white', 1], ['dark', 0], ['dark', 0]]);
  assert.throws(() => trainer.tdTargets(api, {}, episode, ['white'], -0.1), /lambda/);
});

test('seeded sample shuffle preserves targets/counts and avoids contiguous self-play labels', () => {
  const batch = [
    ...Array.from({ length: 49 }, (_, index) => ({ color: 'white', target: 0, state: { id: index } })),
    ...Array.from({ length: 49 }, (_, index) => ({ color: 'dark', target: 1, state: { id: 49 + index } })),
  ];
  const seed = trainer.streamSeeds(trainer.SAMPLE_ORDER_DOMAIN, 236051, 192).white;
  const first = trainer.orderSamples(batch, 'seeded-shuffle', trainer.seededRandom(seed));
  const second = trainer.orderSamples(batch, 'seeded-shuffle', trainer.seededRandom(seed));
  assert.deepEqual(first, second);
  assert.equal(first.length, 98);
  assert.equal(first.filter(sample => sample.target === 0).length, 49);
  assert.equal(first.filter(sample => sample.target === 1).length, 49);
  assert.deepEqual(first.map(sample => sample.state.id).sort((a, b) => a - b), Array.from({ length: 98 }, (_, index) => index));
  assert.equal(new Set(first.slice(0, 10).map(sample => sample.target)).size, 2);
  assert.equal(new Set(first.slice(-10).map(sample => sample.target)).size, 2);
  assert.deepEqual(trainer.orderSamples(batch, 'chronological'), batch);
  assert.equal(batch[0].target, 0); assert.equal(batch[97].target, 1);
  assert.throws(() => trainer.orderSamples(batch, 'seeded-shuffle', () => 1), /RNG/);
  assert.throws(() => trainer.trainingOptions({ sampleOrder: 'unseeded' }), /sampleOrder/);
});

test('resumed shuffled MC training records isolated order domain and is reproducible', () => {
  const options = { resumeArtifact: candidate, games: 1, seed: candidate.trainingManifest.seed,
    maxCandidates: 4, lambda: 1, sampleOrder: 'seeded-shuffle', opponents: ['self'], maxElapsedMs: 60000 };
  const first = trainer.runTraining(options);
  const second = trainer.runTraining(options);
  assert.equal(first.modelFingerprint, second.modelFingerprint);
  assert.deepEqual(first.results, second.results);
  const segment = first.trainingManifest.segments[1];
  assert.equal(segment.options.sampleOrder, 'seeded-shuffle');
  assert.equal(segment.orderingAlgorithm, 'seeded-fisher-yates-v1');
  assert.equal(segment.sampleOrderDomain, trainer.SAMPLE_ORDER_DOMAIN);
  assert.equal(trainer.validateTrainingProvenance(first).games, 3);
});

test('both-color learning includes terminal opponent examples while self-play defaults stay unchanged', () => {
  function train(opponent, learnColors) {
    const labels = [];
    const api = { ...neural, trainSample(model, board, color, target, config) {
      labels.push([color, target]); return neural.trainSample(model, board, color, target, config);
    } };
    const artifact = trainer.runTraining({ games: 1, seed: 5, hiddenSize: 8, opponents: [opponent],
      lambda: 1, learnColors, sampleOrder: 'seeded-shuffle' }, { runtime, api,
      playEpisode({ candidateColor }) { return fakeTerminalEpisode(candidateColor); } });
    assert.equal(trainer.validateTrainingProvenance(artifact).samples, labels.length);
    assert.equal(artifact.trainingManifest.segments[0].options.learnColors, learnColors);
    return { labels, fingerprint: artifact.modelFingerprint };
  }
  for (const opponent of ['random', 'pip', 'greedy']) {
    assert.deepEqual(train(opponent, 'candidate').labels, [['white', 1]]);
    const both = train(opponent, 'both');
    assert.equal(both.labels.length, 2);
    assert.deepEqual(both.labels.slice().sort(), [['dark', 0], ['white', 1]]);
  }
  const selfDefault = train('self', 'candidate');
  const selfBoth = train('self', 'both');
  assert.deepEqual(selfDefault.labels, selfBoth.labels);
  assert.equal(selfDefault.fingerprint, selfBoth.fingerprint);
  assert.throws(() => trainer.trainingOptions({ learnColors: 'opponent-only' }), /learnColors/);
});

test('real resume retains existing model and all legacy seeds without reinitialization', () => {
  const originalFingerprint = candidate.modelFingerprint;
  let initializations = 0;
  const api = { ...neural, createModel() { initializations += 1; throw new Error('Resume must not initialize'); } };
  const resumed = trainer.runTraining({ resumeArtifact: candidate, games: 2,
    seed: candidate.trainingManifest.seed, maxCandidates: 4, lambda: 1, learningRate: 0.03,
    opponents: ['self', 'pip'], maxElapsedMs: 60000 }, { api });
  assert.equal(initializations, 0);
  assert.equal(resumed.schema, trainer.CUMULATIVE_SCHEMA);
  assert.equal(resumed.initialModelFingerprint, candidate.initialModelFingerprint);
  assert.equal(resumed.parentModelFingerprint, originalFingerprint);
  assert.equal(resumed.parentArtifactFingerprint, trainer.fingerprint(candidate));
  assert.equal(resumed.trainingManifest.games, 4);
  assert.deepEqual(resumed.results.slice(0, 2), candidate.results);
  assert.deepEqual(resumed.trainingManifest.diceStreams.slice(0, 4), candidate.trainingManifest.diceStreams);
  assert.equal(resumed.trainingManifest.segments[1].streamIndexStart, 2);
  assert.deepEqual(resumed.results.slice(2).map(result => result.streamIndex), [2, 3]);
  assert.deepEqual(resumed.results.slice(2).map(result => result.candidateColor), ['dark', 'dark']);
  assert.equal(resumed.model.trainingSteps, resumed.trainingManifest.samples);
  assert.equal(trainer.validateTrainingProvenance(resumed).games, 4);
  assert.equal(candidate.modelFingerprint, originalFingerprint);
  assert.equal(trainer.modelFingerprint(candidate.model), originalFingerprint);
  for (const mutate of [
    artifact => { artifact.trainingManifest.segments[1].modelFingerprintBefore = artifact.modelFingerprint; },
    artifact => { artifact.trainingManifest.segments[1].samples += 1; },
    artifact => { artifact.results[2].streamIndex = 0; },
    artifact => { artifact.parentModelFingerprint = artifact.modelFingerprint; },
  ]) {
    const forged = trainer.clone(resumed); mutate(forged);
    assert.throws(() => trainer.validateTrainingProvenance(forged));
  }
});

function fakeTerminalEpisode(candidateColor, states = 1) {
  return { completed: true, candidateColor, winner: 'white', candidateWon: candidateColor === 'white',
    resultType: 'normal', off: { white: 15, dark: 1 }, plies: states * 2,
    afterstates: { white: Array.from({ length: states }, () => runtime.game.initialState('long')),
      dark: Array.from({ length: states }, () => runtime.game.initialState('long')) } };
}

test('only complete terminal episodes enter checkpoints; censored failures preserve valid prefix', () => {
  let played = 0; const checkpoints = []; const progress = [];
  let error;
  try {
    trainer.runTraining({ games: 3, seed: 3, hiddenSize: 8, maxCandidates: 4, opponents: ['self'], checkpointEvery: 16 }, {
      runtime,
      playEpisode({ candidateColor }) {
        played += 1;
        if (played === 2) throw new Error('Censored game exceeded budget');
        return fakeTerminalEpisode(candidateColor);
      },
      onCheckpoint(artifact) { checkpoints.push(artifact); },
      onProgress(item) { progress.push(item); },
    });
  } catch (caught) { error = caught; }
  assert.match(error.message, /Censored/);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].trainingManifest.games, 1);
  assert.equal(checkpoints[0].trainingStatus.complete, false);
  assert.equal(checkpoints[0].trainingStatus.requestedGames, 3);
  assert.equal(progress.length, 1);
  assert.equal(trainer.validateTrainingProvenance(error.completedArtifact).games, 1);
  const resumed = trainer.runTraining({ resumeArtifact: error.completedArtifact, games: 1, seed: 3, lambda: 1,
    maxCandidates: 4, opponents: ['self'] }, {
    runtime, playEpisode({ candidateColor }) { return fakeTerminalEpisode(candidateColor); },
  });
  assert.equal(resumed.trainingManifest.games, 2);
  assert.equal(resumed.trainingManifest.segments[1].streamIndexStart, 1);
  assert.equal(resumed.trainingStatus.complete, true);
  assert.equal(trainer.validateTrainingProvenance(resumed).games, 2);
});

test('failed gradient never checkpoints a partly updated terminal episode', () => {
  let updates = 0; let played = 0; const checkpoints = [];
  const api = { ...neural, trainSample(...args) {
    updates += 1;
    if (updates === 4) throw new Error('Gradient failure');
    return neural.trainSample(...args);
  } };
  assert.throws(() => trainer.runTraining({ games: 2, seed: 4, hiddenSize: 8, maxCandidates: 4,
    opponents: ['self'], checkpointEvery: 1 }, {
    api, runtime, playEpisode({ candidateColor }) { played += 1; return fakeTerminalEpisode(candidateColor, played); },
    onCheckpoint(artifact) { checkpoints.push(artifact); },
  }), /Gradient failure/);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[1].trainingManifest.games, 1);
  assert.equal(checkpoints[1].model.trainingSteps, 2);
  assert.equal(checkpoints[0].modelFingerprint, checkpoints[1].modelFingerprint);
  assert.equal(trainer.validateTrainingProvenance(checkpoints[1]).games, 1);
});

test('reserved validation/confirmation streams are excluded before learning and inherited on resume', () => {
  let updates = 0;
  const api = { ...neural, trainSample() { updates += 1; } };
  const forbidden = trainer.streamSeeds(trainer.TRAIN_DOMAIN, 7, 0).white;
  assert.throws(() => trainer.runTraining({ games: 1, seed: 7, hiddenSize: 8,
    forbiddenDiceStreams: [forbidden] }, { api, runtime }), /collision/);
  assert.equal(updates, 0);
  assert.throws(() => trainer.runTraining({ resumeArtifact: candidate, games: 1,
    forbiddenDiceStreams: [candidate.trainingManifest.diceStreams[0]] }), /overlaps reserved/);
  const reserved = trainer.streamSeeds('reserved-test', 5, 0).white;
  const first = trainer.runTraining({ games: 1, seed: 6, hiddenSize: 8, opponents: ['self'],
    forbiddenDiceStreams: [reserved] }, { runtime,
    playEpisode({ candidateColor }) { return fakeTerminalEpisode(candidateColor); } });
  const resumed = trainer.runTraining({ resumeArtifact: first, games: 1, seed: 6, lambda: 1, opponents: ['self'] }, {
    runtime, playEpisode({ candidateColor }) { return fakeTerminalEpisode(candidateColor); } });
  assert.deepEqual(resumed.trainingManifest.segments[1].options.forbiddenDiceStreams, [reserved]);
  assert.equal(trainer.validateTrainingProvenance(resumed).games, 2);
});

test('censored episodes never train and receive neither wins nor losses', () => {
  let updates = 0;
  let created;
  const api = { ...neural,
    createModel(options) { created = neural.createModel(options); return created; },
    trainSample() { updates += 1; },
  };
  assert.throws(() => trainer.runTraining({ games: 1, hiddenSize: 8, maxCandidates: 4 }, {
    api, runtime, playEpisode() { throw new Error('Censored game exceeded max plies'); },
  }), /Censored/);
  assert.equal(updates, 0);
  assert.equal(created.trainingSteps, 0);
  assert.throws(() => trainer.runTraining({ games: 1, hiddenSize: 8, maxCandidates: 4 }, {
    api, runtime, playEpisode() { return { completed: false, winner: null }; },
  }), /terminal complete/);
  assert.equal(updates, 0);
});

test('trained-model resumption cannot silently discard previous seed provenance', () => {
  assert.throws(() => trainer.runTraining({ games: 1, initialModel: candidate.model }), /cumulative training provenance/);
});

test('each training opponent receives both candidate colors across two cycles', () => {
  const records = [];
  const artifact = trainer.runTraining({ games: 8, seed: 3, hiddenSize: 8, maxCandidates: 4 }, {
    runtime,
    playEpisode({ candidateColor }) {
      records.push(candidateColor);
      return { completed: true, candidateColor, winner: 'white', candidateWon: candidateColor === 'white',
        resultType: 'normal', off: { white: 15, dark: 1 }, plies: 2, afterstates: { white: [runtime.game.initialState('long')],
          dark: [runtime.game.initialState('long')] } };
    },
  });
  assert.deepEqual(records, ['white', 'white', 'white', 'white', 'dark', 'dark', 'dark', 'dark']);
  for (const name of trainer.OPPONENTS) {
    assert.deepEqual(artifact.results.filter(result => result.opponent === name).map(result => result.candidateColor), ['white', 'dark']);
  }
});

test('actual paired held-out evaluation completes without learning', () => {
  const before = trainer.modelFingerprint(candidate.model);
  const report = evaluator.runEvaluation(candidate, { pairs: 1, opponents: ['pip'],
    maxCandidates: 4, maxElapsedMs: 60000 });
  assert.equal(report.results.length, 2);
  assert.equal(report.learningDuringEvaluation, false);
  assert.equal(report.heldOutDiceStreamsVerified, true);
  assert.equal(report.modelFingerprint, before);
  assert.equal(report.modelFingerprintAfterEvaluation, before);
  assert.equal(report.evaluationTrainerFingerprint, trainer.HARNESS_FINGERPRINT);
  assert.equal(report.trainingHarnessFingerprint, candidate.harnessFingerprint);
  assert.equal(trainer.modelFingerprint(candidate.model), before);
  assert.deepEqual(report.results[0].streamSeeds, report.results[1].streamSeeds);
  assert.deepEqual(report.results.map(result => result.candidateColor), ['white', 'dark']);
  assert.equal(report.summary.gatePassed, false);
  assert.equal(report.summary.productionEligible, false);
});

test('evaluation rejects model/rules/seed/sample/censored provenance tampering', () => {
  const mutations = [
    artifact => { artifact.model.outputBias += 0.01; },
    artifact => { artifact.runtimeFingerprint = 'sha256:' + 'a'.repeat(64); },
    artifact => { artifact.inferenceCodeFingerprint = 'sha256:' + 'a'.repeat(64); },
    artifact => { artifact.seedStreamHelperFingerprint = 'sha256:' + 'a'.repeat(64); },
    artifact => { artifact.trainingManifest.diceStreams[0] = artifact.trainingManifest.diceStreams[1]; },
    artifact => { artifact.trainingManifest.samples += 1; },
    artifact => { artifact.results[0].completed = false; },
    artifact => { artifact.results[0].off[artifact.results[0].winner] = 0; },
    artifact => { artifact.results[0].off = { ...artifact.results[0].off, unexpected: 1 }; },
    artifact => { artifact.results[0].off[artifact.results[0].winner] = 14.5; },
    artifact => { artifact.results[0].off[artifact.results[0].winner === 'white' ? 'dark' : 'white'] =
      artifact.results[0].resultType === 'normal' ? 0 : 1; },
    artifact => { artifact.results[0].streamSeeds.white += 1; },
  ];
  for (const mutate of mutations) {
    const forged = trainer.clone(candidate); mutate(forged);
    assert.throws(() => evaluator.validateTrainingArtifact(forged, neural, runtime));
  }
});

test('learning or model mutation during evaluation fails closed', () => {
  const api = { ...neural, createNeuralBot(game, model) { model.outputBias += 0.01; return { plan() { return []; } }; } };
  assert.throws(() => evaluator.runEvaluation(candidate, { pairs: 1, opponents: ['pip'], maxCandidates: 4 }, {
    api, runtime, playEpisode({ candidateColor }) { return { completed: true, candidateColor,
      winner: candidateColor, candidateWon: true, resultType: 'normal', plies: 1, afterstates: {} }; },
  }), /learning is forbidden/);
});

function pairedResults(pairs, opponent = 'pip') {
  return Array.from({ length: pairs * 2 }, (_, index) => ({
    opponent, pair: Math.floor(index / 2) + 1, leg: index % 2 + 1,
    completed: true, candidateColor: index % 2 ? 'dark' : 'white',
    winner: index % 2 ? 'dark' : 'white', candidateWon: true,
    resultType: 'normal', streamSeeds: { white: Math.floor(index / 2) * 2 + 1,
      dark: Math.floor(index / 2) * 2 + 2 },
  }));
}
test('65 percent gate is paired/confidence bounded and cannot grant production eligibility', () => {
  const small = evaluator.summarizeResults(pairedResults(1), evaluator.evaluationOptions({ pairs: 1, opponents: ['pip'] }));
  assert.equal(small.gatePassed, false);
  const sufficient = evaluator.summarizeResults(pairedResults(100), evaluator.evaluationOptions({ pairs: 100, opponents: ['pip'] }));
  assert.equal(sufficient.poolGatePassed, true);
  assert.equal(sufficient.gatePassed, false);
  assert(sufficient.opponents.pip.pairedConfidence.lower >= 0.65);
  assert.equal(sufficient.productionEligible, false);
  assert.equal(sufficient.scope, 'held-out-defined-simple-opponent-pool-only');
  assert.equal(sufficient.opponents.pip.descriptiveWilson95.descriptiveOnly, true);
  const strong = evaluator.summarizeResults(pairedResults(100, 'current-hard'),
    evaluator.evaluationOptions({ pairs: 100, opponents: ['current-hard'] }));
  assert.equal(strong.gatePassed, true);
  assert.equal(strong.currentHardIncluded, true);
  assert.equal(strong.productionEligible, false);
  assert.throws(() => evaluator.evaluationOptions({ minimumPairs: 1 }), /minimumPairs/);
  assert.throws(() => evaluator.evaluationOptions({ targetWinRate: 0.49 }), /targetWinRate/);
  assert.equal(evaluator.evaluationOptions({ targetWinRate: 0.5 }).targetWinRate, 0.5);
  assert.equal(evaluator.evaluationOptions().targetWinRate, 0.65);
});

test('incomplete, inconsistent, or mismatched paired legs cannot produce a win rate', () => {
  const options = evaluator.evaluationOptions({ pairs: 1, opponents: ['pip'] });
  assert.throws(() => evaluator.summarizeResults(pairedResults(1).slice(0, 1), options), /Incomplete paired/);
  for (const mutate of [
    results => { results[1].completed = false; },
    results => { results[1].streamSeeds.white += 1; },
    results => { results[1].candidateWon = false; },
    results => { results[1].leg = 1; },
    results => { results[1].leg = 3; },
    results => { results[1].resultType = 'fabricated'; },
  ]) {
    const results = pairedResults(1); mutate(results);
    assert.throws(() => evaluator.summarizeResults(results, options));
  }
});

test('optional current-hard is an immutable v35 runtime with production resources and no fallback', () => {
  const snapshot = evaluator.readCurrentHardSnapshot();
  assert.equal(snapshot.entries.length, 3);
  assert.equal(snapshot.sourceFingerprints['game.js'], runtime.fingerprint);
  const hard = evaluator.createCurrentHard(snapshot);
  const state = runtime.game.initialState('long');
  state.turn = 'white'; state.phase = 'roll';
  runtime.game.applyRoll(state, [1, 2]);
  const moves = hard.plan(state);
  trainer.applyPlan(runtime.game, state, moves);
  assert.equal(hard.metadata.engineVersion, 'long-analytic-v35');
  assert.equal(hard.metadata.experiencePatterns, 0);
  assert.equal(hard.metadata.fallbackAllowed, false);
  assert.equal(hard.metadata.learningDuringEvaluation, false);
  assert.deepEqual(hard.metadata.resources, { strategyProfile: 'v25', maxCandidates: 64, analysisNodeBudget: 480 });
  assert.match(hard.metadata.policyWeightsFingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('bounded CLI options reject unknown/duplicate/unsafe configuration before loading', () => {
  assert.throws(() => trainer.cliOptions(['--production']), /Unknown option/);
  assert.throws(() => trainer.cliOptions(['--games', '1', '--games', '2']), /Duplicate/);
  assert.throws(() => trainer.cliOptions(['--games', '0']), /games/);
  assert.throws(() => trainer.cliOptions(['--epsilon', 'NaN']), /finite/);
  assert.throws(() => trainer.cliOptions(['--hidden-size', '129']), /hiddenSize/);
  assert.throws(() => evaluator.cliOptions(['--opponents', 'pip,pip']), /unique/);
  assert.throws(() => evaluator.cliOptions(['--pairs', '10001']), /pairs/);
  const result = spawnSync(process.execPath, [path.join(trainer.ROOT, 'scripts/train-long-bot-neural.js'),
    '--output', 'relative.json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /absolute artifact/);
});

test('atomic private artifact writes leave no temporary files and preserve fingerprints', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-neural-artifact-test-'));
  const file = path.join(directory, 'candidate.json');
  try {
    trainer.writeJsonAtomic(file, candidate);
    const restored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(restored.modelFingerprint, candidate.modelFingerprint);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(directory), ['candidate.json']);
    assert.throws(() => trainer.writeJsonAtomic('relative.json', candidate), /absolute path/);
  } finally {
    fs.unlinkSync(file); fs.rmdirSync(directory);
  }
});
