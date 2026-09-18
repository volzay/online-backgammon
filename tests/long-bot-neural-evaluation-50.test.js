'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const evaluator = require('../scripts/evaluate-long-bot-neural');
const trainer = require('../scripts/train-long-bot-neural');
const neural = require('../lib/long-bot-neural');

function protocol() {
  return { schema: 'long-neural-benchmark-protocol-v1', targetWinRate: 0.5,
    minimumPairsPerOpponent: 30, opponents: ['random', 'pip', 'greedy'],
    validationSeed: 410099, confirmationSeed: 420099, validationPairs: 4,
    confirmationPairs: 30, maxCandidates: 16, maxPlies: 640,
    createdBeforeTraining: true, baselineModelFingerprint: `sha256:${'a'.repeat(64)}` };
}

function outcomes(pairs, winsPerOpponent) {
  return ['random', 'pip', 'greedy'].flatMap((opponent, opponentIndex) =>
    Array.from({ length: pairs * 2 }, (_, index) => {
      const candidateColor = index % 2 ? 'dark' : 'white';
      const candidateWon = index < winsPerOpponent[opponentIndex];
      const stream = opponentIndex * 100000 + Math.floor(index / 2) * 2 + 1;
      return { opponent, pair: Math.floor(index / 2) + 1, leg: index % 2 + 1,
        completed: true, candidateColor, candidateWon,
        winner: candidateWon ? candidateColor : candidateColor === 'white' ? 'dark' : 'white',
        resultType: 'normal', streamSeeds: { white: stream, dark: stream + 1 } };
    }));
}

test('50 percent is a separate research target; production target stays 65 percent', () => {
  assert.equal(evaluator.evaluationOptions().targetWinRate, 0.65);
  assert.equal(evaluator.evaluationOptions({ targetWinRate: 0.5 }).targetWinRate, 0.5);
  assert.throws(() => evaluator.evaluationOptions({ targetWinRate: 0.49 }), /targetWinRate/);
  assert.throws(() => evaluator.evaluationOptions({ purpose: 'final-if-it-wins' }), /purpose/);
});

test('protocol fixes balanced opponents, resources, distinct seeds and minimum independent pairs', () => {
  const declared = protocol();
  const final = evaluator.protocolOptions(declared, 'held-out-confirmation');
  assert.equal(final.seed, 420099); assert.equal(final.pairs, 30);
  assert.equal(final.reservedSeed, 420099); assert.equal(final.targetWinRate, 0.5);
  assert.equal(final.protocolFingerprint, trainer.fingerprint(declared));
  const development = evaluator.protocolOptions(declared, 'development-validation');
  assert.equal(development.seed, 410099); assert.equal(development.pairs, 4);
  assert.throws(() => evaluator.protocolOptions(declared, 'held-out-confirmation', { pairs: 31 }), /differs/);
  assert.throws(() => evaluator.validateBenchmarkProtocol({ ...declared, confirmationSeed: 410099 }), /distinct/);
  assert.throws(() => evaluator.validateBenchmarkProtocol({ ...declared, confirmationPairs: 29 }), /confirmationPairs/);
  assert.throws(() => evaluator.validateBenchmarkProtocol({ ...declared, opponents: ['random'] }), /fixed/);
  assert.throws(() => evaluator.validateBenchmarkProtocol({ ...declared, createdBeforeTraining: false }), /predeclared/);
  assert.throws(() => evaluator.evaluationOptions({ purpose: 'development-validation', seed: 420099, reservedSeed: 420099 }), /reserved/);
});

test('aggregate paired lower bound can confirm research 50 without claiming per-opponent or production 65', () => {
  const options = evaluator.protocolOptions(protocol(), 'held-out-confirmation');
  const summary = evaluator.summarizeResults(outcomes(30, [42, 40, 33]), options);
  assert.equal(summary.aggregate.wins, 115);
  assert.equal(summary.aggregate.games, 180);
  assert.equal(summary.aggregate.winRate, 115 / 180);
  assert(summary.aggregate.pairedConfidence.lower >= 0.5);
  assert.equal(summary.researchMilestonePassed, true);
  assert.equal(summary.poolGatePassed, false);
  assert.equal(summary.gatePassed, false);
  assert.equal(summary.productionEligible, false);
  assert.equal(summary.aggregate.doesNotEstimateHumanOrProductionWinRate, true);
});

test('observed 50 percent, small samples, unreserved reports and reused validation are not confirmation', () => {
  const final = evaluator.protocolOptions(protocol(), 'held-out-confirmation');
  const observed = evaluator.summarizeResults(outcomes(30, [30, 30, 30]), final);
  assert.equal(observed.aggregate.observedAtLeast50Percent, true);
  assert.equal(observed.researchMilestonePassed, false);
  const tooSmall = evaluator.summarizeResults(outcomes(29, [58, 58, 58]), { ...final, pairs: 29 });
  assert.equal(tooSmall.researchMilestonePassed, false);
  const validation = evaluator.summarizeResults(outcomes(30, [60, 60, 60]), { ...final, purpose: 'development-validation' });
  assert.equal(validation.researchMilestonePassed, false);
  const noReservation = evaluator.summarizeResults(outcomes(30, [60, 60, 60]),
    evaluator.evaluationOptions({ pairs: 30, targetWinRate: 0.5 }));
  assert.equal(noReservation.researchMilestonePassed, false);
});

test('repeated pair streams cannot inflate independent sample size', () => {
  const results = outcomes(30, [60, 60, 60]);
  results[2].streamSeeds = { ...results[0].streamSeeds };
  results[3].streamSeeds = { ...results[0].streamSeeds };
  assert.throws(() => evaluator.summarizeResults(results,
    evaluator.protocolOptions(protocol(), 'held-out-confirmation')), /independent/);
});

test('development evaluations label seed separation but do not call tuning data held-out', () => {
  const runtime = trainer.loadLongGame();
  const artifact = trainer.runTraining({ games: 1, hiddenSize: 8, maxCandidates: 4, seed: 7722 }, {
    runtime,
    playEpisode({ candidateColor }) { return { completed: true, candidateColor, winner: candidateColor,
      candidateWon: true, resultType: 'normal', plies: 2,
      off: { [candidateColor]: 15, [candidateColor === 'white' ? 'dark' : 'white']: 1 },
      afterstates: { white: [runtime.game.initialState('long')], dark: [] } }; },
  });
  const report = evaluator.runEvaluation(artifact, { benchmarkProtocol: protocol(), purpose: 'development-validation' }, {
    runtime,
    playEpisode({ candidateColor }) { return { completed: true, candidateColor, winner: candidateColor,
      candidateWon: true, resultType: 'normal', plies: 2,
      off: { [candidateColor]: 15, [candidateColor === 'white' ? 'dark' : 'white']: 1 },
      afterstates: {} }; },
  });
  assert.equal(report.results.length, 24);
  assert.equal(report.diceDomain, evaluator.DEVELOPMENT_DOMAIN);
  assert.equal(report.trainingDiceStreamsDisjointVerified, true);
  assert.equal(report.heldOutDiceStreamsVerified, false);
  assert.equal(report.developmentValidationMayBeReusedForModelSelection, true);
  assert.equal(report.summary.researchMilestonePassed, false);
  assert.equal(report.benchmarkProtocolFingerprint, trainer.fingerprint(protocol()));
});

test('native hard factory preserves captured v35 source/policy and selected opening plans', () => {
  const snapshot = evaluator.readCurrentHardSnapshot();
  const native = evaluator.createCurrentHard(snapshot);
  const vm = evaluator.createCurrentHard(snapshot, { loader: 'vm' });
  const { game } = trainer.loadLongGame();
  for (const color of ['white', 'dark']) {
    for (const dice of [[1, 2], [3, 3], [6, 5]]) {
      const state = game.initialState('long'); state.turn = color; state.phase = 'roll';
      game.applyRoll(state, dice);
      assert.deepEqual(trainer.clone(native.plan(state)), trainer.clone(vm.plan(state)));
      assert.deepEqual(native.metadata, trainer.clone(vm.metadata));
    }
  }
  const corrupted = { ...snapshot, sourceFingerprints: { ...snapshot.sourceFingerprints, 'game.js': `sha256:${'0'.repeat(64)}` } };
  assert.throws(() => evaluator.createCurrentHard(corrupted), /fingerprint mismatch/);
  assert.throws(() => evaluator.createCurrentHard(snapshot, { loader: 'fallback' }), /loader/);
});

test('native hard factory preserves two complete terminal race-fixture VM traces', { timeout: 60000 }, () => {
  const snapshot = evaluator.readCurrentHardSnapshot();
  const { game: rules } = trainer.loadLongGame();
  const game = { ...rules, initialState(variant) {
    const state = rules.initialState(variant);
    state.points = {};
    // Two rule-valid separated home boards, seven checkers each and eight off.
    // This proves complete terminal replay equivalence, not a complete game
    // beginning from the real fifteen-checker head position or bot strength.
    for (const [color, first] of [['white', 6], ['dark', 18]]) {
      for (let offset = 0; offset < 6; offset += 1) {
        state.points[first - offset] = { color, count: offset ? 1 : 2 };
      }
      state.off[color] = 8;
    }
    return state;
  } };
  const traces = [];
  for (const candidateColor of ['white', 'dark']) {
    const seeds = trainer.streamSeeds('nardu/long-neural/native-hard-equivalence/v1', 55381,
      candidateColor === 'white' ? 0 : 1);
    const episodes = ['native', 'vm'].map(loader => trainer.playEpisode({ game,
      candidate: trainer.createBaseline(game, 'pip', trainer.seededRandom(1), 16),
      opponent: evaluator.createCurrentHard(snapshot, { loader }), candidateColor, seeds,
      maxPlies: 100, maxGameMs: 30000, collectTraining: false }));
    assert.deepEqual(episodes[0], episodes[1]);
    assert.equal(episodes[0].completed, true);
    traces.push(episodes[0].traceFingerprint);
  }
  assert.notEqual(traces[0], traces[1]);
});

test('optional slow native hard equivalence from the real initial board', {
  skip: process.env.LONG_NEURAL_VERIFY_NATIVE_FULL !== '1', timeout: 1200000,
}, () => {
  const snapshot = evaluator.readCurrentHardSnapshot();
  const { game } = trainer.loadLongGame();
  const seeds = trainer.streamSeeds('nardu/long-neural/native-hard-equivalence/v1', 55381, 0);
  const episodes = ['native', 'vm'].map(loader => trainer.playEpisode({ game,
    candidate: trainer.createBaseline(game, 'pip', trainer.seededRandom(1), 16),
    opponent: evaluator.createCurrentHard(snapshot, { loader }), candidateColor: 'white', seeds,
    maxPlies: 640, maxGameMs: 600000, collectTraining: false }));
  assert.deepEqual(episodes[0], episodes[1]);
  assert.equal(episodes[0].completed, true);
});

test('50 target CLI parses protocol/purpose while invalid purpose fails before a game', () => {
  const parsed = evaluator.cliOptions(['--target-win-rate', '0.5', '--purpose', 'development-validation',
    '--reserved-seed', '420099', '--seed', '410099', '--protocol', '/private/tmp/protocol.json']);
  assert.equal(parsed.protocol, '/private/tmp/protocol.json');
  assert.equal(parsed.options.targetWinRate, 0.5);
  assert.equal(parsed.options.purpose, 'development-validation');
  assert.throws(() => evaluator.cliOptions(['--purpose', 'select-winning-seed']), /purpose/);
});

test('confirmation CLI consumes a reserved protocol even if a game is censored, preventing seed selection retries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-neural-confirmation-journal-'));
  const runtime = trainer.loadLongGame();
  const artifact = trainer.runTraining({ games: 1, hiddenSize: 8, maxCandidates: 4, seed: 7723 }, {
    runtime,
    playEpisode({ candidateColor }) { return { completed: true, candidateColor, winner: candidateColor,
      candidateWon: true, resultType: 'normal', plies: 2,
      off: { [candidateColor]: 15, [candidateColor === 'white' ? 'dark' : 'white']: 1 },
      afterstates: { white: [runtime.game.initialState('long')], dark: [] } }; },
  });
  const model = path.join(directory, 'candidate.json');
  const declaration = path.join(directory, 'protocol.json');
  const output = path.join(directory, 'evaluation.json');
  const journal = `${declaration}.confirmation-use.json`;
  try {
    trainer.writeJsonAtomic(model, artifact);
    trainer.writeJsonAtomic(declaration, { ...protocol(), maxPlies: 1 });
    const argv = ['--model', model, '--output', output, '--protocol', declaration,
      '--purpose', 'held-out-confirmation'];
    assert.throws(() => evaluator.main(argv), /Censored/);
    const record = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.equal(record.status, 'aborted');
    assert.equal(record.noWinRateOrGateIssued, true);
    assert.equal(record.modelFingerprint, artifact.modelFingerprint);
    assert.equal(record.options.seed, protocol().confirmationSeed);
    assert.equal(record.options.pairs, 30);
    assert.equal(record.options.purpose, 'held-out-confirmation');
    assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(output), false);
    assert.throws(() => evaluator.main(argv), /already consumed/);
    assert.equal(JSON.parse(fs.readFileSync(journal, 'utf8')).status, 'aborted');
  } finally {
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  }
});
