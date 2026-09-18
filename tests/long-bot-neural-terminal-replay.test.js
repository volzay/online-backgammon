'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const trainer = require('../scripts/train-long-bot-neural');
const api = trainer.neuralApi();
let legacy; let learned; const checkpoints = [];
const options = { games: 3, seed: 991899, hiddenSize: 8, maxCandidates: 4,
  maxElapsedMs: 60000, lambda: 1, sampleOrder: 'seeded-shuffle', learnColors: 'both',
  replayGames: 2, replaySamples: 8, checkpointEvery: 1 };
test.before(() => {
  legacy = trainer.runTraining({ games: 1, seed: options.seed, hiddenSize: 8,
    maxCandidates: 4, opponents: ['self'], maxElapsedMs: 60000 });
  learned = trainer.runTraining({ ...options, resumeArtifact: legacy }, {
    onCheckpoint(artifact) { checkpoints.push(artifact); },
  });
});

function rehash(value) {
  const { fingerprint: ignored, ...body } = value;
  value.fingerprint = trainer.fingerprint(body);
}

test('terminal replay resumes actual weights and never fabricates missing historical boards', () => {
  assert.equal(learned.trainingManifest.games, 4);
  assert.equal(learned.parentModelFingerprint, legacy.modelFingerprint);
  assert.equal(learned.initialModelFingerprint, legacy.initialModelFingerprint);
  assert.deepEqual(learned.results[0], legacy.results[0]);
  assert.equal(learned.results[0].experienceLeaves, undefined);
  assert.deepEqual(learned.results.slice(1).map(result => result.replayTrainingSamples), [0, 8, 8]);
  assert.deepEqual(learned.experienceReplay.games.map(game => game.game), [3, 4]);
  assert.equal(trainer.validateTrainingProvenance(learned).games, 4);
});

test('native plus replay counts equal exact SGD steps; replay uses only prior completed game leaves', () => {
  let added = 0;
  for (const result of learned.results.slice(1)) {
    assert.equal(result.trainingSamples, result.nativeTrainingSamples + result.replayTrainingSamples);
    assert.equal(result.replaySources.length, result.replayTrainingSamples);
    assert(result.experienceLeaves.length > 0 && result.experienceLeaves.length <= 64);
    let zeros = 0; let ones = 0;
    for (const source of result.replaySources) {
      assert(source.game < result.game);
      const origin = learned.results[source.game - 1];
      const leaf = origin.experienceLeaves.find(leaf => leaf.sampleFingerprint === source.sampleFingerprint);
      assert(leaf);
      assert.equal(source.experienceFingerprint, origin.experienceGameFingerprint);
      if (leaf.target === 0) zeros += 1; else ones += 1;
    }
    assert.equal(zeros, Math.ceil(result.replayTrainingSamples / 2));
    assert.equal(ones, Math.floor(result.replayTrainingSamples / 2));
    added += result.trainingSamples;
  }
  assert.equal(learned.model.trainingSteps, legacy.model.trainingSteps + added);
  assert.equal(learned.trainingManifest.samples, learned.model.trainingSteps);
});

test('compact cache carries rule-only afterstates and terminal labels committed by source records', () => {
  for (const game of learned.experienceReplay.games) {
    const origin = learned.results[game.game - 1];
    assert.equal(game.sourceModelFingerprint, origin.modelFingerprintBefore);
    assert.equal(game.traceFingerprint, origin.traceFingerprint);
    assert.equal(game.fingerprint, origin.experienceGameFingerprint);
    for (const sample of game.samples) {
      assert.equal(sample.target, game.winner === sample.color ? 1 : 0);
      assert.equal(sample.state.phase, 'roll'); assert.equal(sample.state.winner, null);
      assert.equal(sample.state.turn, sample.color === 'white' ? 'dark' : 'white');
      assert.deepEqual(sample.state.dice, []); assert.deepEqual(sample.state.rolled, []);
      assert.deepEqual(sample.state.turnMoves, []);
      assert.equal(sample.state.history, undefined); assert.equal(sample.state.analysis, undefined);
      assert.equal(sample.stateFingerprint, trainer.fingerprint(sample.state));
      api.validateState(sample.state);
    }
  }
});

test('separate replay RNG is deterministic and detached from cached state objects', () => {
  const seed = trainer.streamSeeds(trainer.REPLAY_DOMAIN, options.seed, 4).white;
  const before = trainer.fingerprint(learned.experienceReplay.games);
  const first = trainer.selectReplaySamples(learned.experienceReplay.games, 8, trainer.seededRandom(seed));
  const second = trainer.selectReplaySamples(learned.experienceReplay.games, 8, trainer.seededRandom(seed));
  assert.deepEqual(first, second);
  first[0].state.points = {};
  assert.equal(trainer.fingerprint(learned.experienceReplay.games), before);
  assert.deepEqual(trainer.selectReplaySamples([], 8, trainer.seededRandom(seed)), []);
  assert.throws(() => trainer.trainingOptions({ replayGames: 1, lambda: 0.5 }), /lambda=1/);
  assert.throws(() => trainer.trainingOptions({ replayGames: 65, lambda: 1 }), /replayGames/);
});

test('real complete terminal replay is reproducible without modifying the resume source', () => {
  const before = trainer.fingerprint(legacy);
  const again = trainer.runTraining({ ...options, resumeArtifact: legacy });
  assert.equal(again.modelFingerprint, learned.modelFingerprint);
  assert.deepEqual(again.results, learned.results);
  assert.deepEqual(again.experienceReplay, learned.experienceReplay);
  assert.equal(trainer.fingerprint(legacy), before);
});

test('evicted source leaf anchors remain available and altered source/outcome/state/counts fail closed', () => {
  assert.equal(learned.experienceReplay.games.some(game => game.game === 2), false);
  assert(learned.results[1].experienceLeaves.length);
  for (const mutate of [
    artifact => { artifact.results[2].replaySources[0].game = 3; },
    artifact => { artifact.results[2].replaySources[0].sampleFingerprint = artifact.results[1].experienceLeaves[0].stateFingerprint; },
    artifact => { artifact.results[2].nativeTrainingSamples += 1; },
    artifact => { artifact.results[1].experienceLeaves[0].target = 1 - artifact.results[1].experienceLeaves[0].target; },
    artifact => { artifact.experienceReplay.games[0].samples[0].state.off.white += 1; },
    artifact => { artifact.experienceReplay.games[0].samples[0].state.dice = [6]; },
    artifact => { artifact.experienceReplay.games[0].samples[0].state.account = 'unexpected'; },
    artifact => { artifact.experienceReplay.games[0].samples[0].sourceGame = 1; },
    artifact => { artifact.results[1].modelFingerprintBefore = artifact.modelFingerprint; },
    artifact => { delete artifact.experienceReplay; },
  ]) {
    const forged = trainer.clone(learned); mutate(forged);
    assert.throws(() => trainer.validateTrainingProvenance(forged));
  }
});

test('rehashing cannot detach cache settings or native sample counts from recorded segment semantics', () => {
  for (const mutate of [
    artifact => { artifact.experienceReplay.gamesCapacity = 63; artifact.experienceReplay.replaySamplesPerEpisode = 99; },
    artifact => {
      const cached = artifact.experienceReplay.games.at(-1);
      cached.stateCounts = { white: 123, dark: 234 };
      rehash(cached);
      artifact.results[cached.game - 1].experienceGameFingerprint = cached.fingerprint;
    },
  ]) {
    const forged = trainer.clone(learned);
    mutate(forged); rehash(forged.experienceReplay);
    assert.throws(() => trainer.validateTrainingProvenance(forged), /settings differ|state counts differ/);
  }
});

test('replay references and final cache must respect the reconstructed exact rolling window', () => {
  const next = trainer.runTraining({ ...options, games: 1, resumeArtifact: learned });
  const oldOrigin = next.results[1]; // Game 2 was committed but evicted before game 5.
  const leaves = [0, 1].map(target => oldOrigin.experienceLeaves.find(leaf => leaf.target === target));
  const staleSource = trainer.clone(next);
  staleSource.results.at(-1).replaySources = Array.from({ length: options.replaySamples }, (_, index) => ({
    game: 2, sampleFingerprint: leaves[index % 2].sampleFingerprint,
    experienceFingerprint: oldOrigin.experienceGameFingerprint,
  }));
  assert.throws(() => trainer.validateTrainingProvenance(staleSource), /evicted/);
  const staleCache = trainer.clone(learned);
  staleCache.experienceReplay.games = trainer.clone(checkpoints[1].experienceReplay.games);
  rehash(staleCache.experienceReplay);
  assert.throws(() => trainer.validateTrainingProvenance(staleCache), /exact completed-game rolling window/);
  assert.equal(trainer.validateTrainingProvenance(next).games, 5);
});

test('censored future episode never changes committed replay cache or model', () => {
  let error; let checkpoints = 0;
  try {
    trainer.runTraining({ ...options, games: 1, resumeArtifact: learned }, {
      playEpisode() { throw new Error('Censored replay episode'); },
      onCheckpoint() { checkpoints += 1; },
    });
  } catch (caught) { error = caught; }
  assert.match(error.message, /Censored replay/);
  assert.equal(error.completedArtifact, null);
  assert.equal(checkpoints, 0);
  assert.equal(trainer.modelFingerprint(learned.model), learned.modelFingerprint);
  assert.equal(trainer.validateTrainingProvenance(learned).games, 4);
});

test('metadata failure after gradient staging never publishes orphan weights or cache', () => {
  const originalFingerprint = trainer.fingerprint(learned);
  let gradients = 0; let checkpointCalls = 0;
  const countingApi = { ...api, trainSample(...args) { gradients += 1; return api.trainSample(...args); } };
  let error;
  try {
    trainer.runTraining({ ...options, games: 1, resumeArtifact: learned }, {
      api: countingApi,
      playEpisode(args) {
        const complete = trainer.playEpisode(args);
        Object.defineProperty(complete, 'metadataFailure', { enumerable: true,
          get() { throw new Error('Failed metadata construction after staged gradients'); } });
        return complete;
      },
      onCheckpoint() { checkpointCalls += 1; },
    });
  } catch (caught) { error = caught; }
  assert.match(error.message, /metadata construction/);
  assert(gradients > 0);
  assert.equal(error.completedArtifact, null);
  assert.equal(checkpointCalls, 0);
  assert.equal(trainer.fingerprint(learned), originalFingerprint);
  assert.equal(trainer.validateTrainingProvenance(learned).games, 4);
});

test('resume inherits committed replay settings and explicit discard fails before play', () => {
  let played = 0;
  assert.throws(() => trainer.runTraining({ games: 1, resumeArtifact: learned, replayGames: 0 }, {
    playEpisode() { played += 1; throw new Error('Should not play'); },
  }), /cannot be silently disabled/);
  assert.equal(played, 0);
  const restarted = trainer.runTraining({ games: 1, seed: options.seed, maxCandidates: 4,
    resumeArtifact: learned, sampleOrder: 'seeded-shuffle', learnColors: 'both', maxElapsedMs: 60000 });
  assert.equal(restarted.results.at(-1).replayTrainingSamples, 8);
  assert.equal(restarted.experienceReplay.gamesCapacity, 2);
  assert(restarted.results.at(-1).replaySources.every(source => source.game < 5));
  assert.equal(trainer.validateTrainingProvenance(restarted).games, 5);
});
