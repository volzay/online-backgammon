'use strict';

// Offline artifact provenance. File-supplied hashes are consistency checks,
// not signatures or evidence about production/human playing strength.
const crypto = require('node:crypto');
const LEGACY_SCHEMA = 'long-neural-training-artifact-v1';
const CUMULATIVE_SCHEMA = 'long-neural-training-artifact-v2';
const HASH = /^sha256:[a-f0-9]{64}$/;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fingerprint(value) { return `sha256:${crypto.createHash('sha256').update(canonical(value)).digest('hex')}`; }
function integer(name, value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is outside its integer bounds`);
  return value;
}
function check(condition, message) { if (!condition) throw new Error(message); }
function checkHash(value, name) { check(typeof value === 'string' && HASH.test(value), `Invalid ${name} fingerprint`); }
function keys(value, expected, name) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)), `Invalid ${name} fields`);
}
function validateReplayProvenance(artifact, api, segmentsByGame) {
  const leafMaps = new Map();
  let eligibleGames = [];
  let latestReplaySegment = null;
  for (const result of artifact.results) {
    const segment = segmentsByGame[result.game - 1];
    if (!segment.options?.replayGames) {
      check(result.replayTrainingSamples === undefined && result.experienceLeaves === undefined,
        'Unrecorded replay in a replay-disabled training segment');
      check(!latestReplaySegment, 'Committed terminal replay cannot be silently disabled');
      continue;
    }
    check(segment.lambda === 1, 'Replay is valid only for terminal Monte Carlo segments');
    integer('replay game capacity', segment.options.replayGames, 1, 64);
    integer('replay samples per episode', segment.options.replaySamples, 1, 256);
    eligibleGames = eligibleGames.slice(-segment.options.replayGames);
    latestReplaySegment = segment;
    integer('native episode samples', result.nativeTrainingSamples, 1, 8192);
    integer('replay episode samples', result.replayTrainingSamples, 0, segment.options.replaySamples);
    check(result.trainingSamples === result.nativeTrainingSamples + result.replayTrainingSamples,
      'Native/replay SGD counts do not match the completed game');
    checkHash(result.modelFingerprintBefore, 'replay model before');
    checkHash(result.modelFingerprintAfter, 'replay model after');
    checkHash(result.traceFingerprint, 'experience source trace');
    checkHash(result.experienceGameFingerprint, 'experience game');
    checkHash(result.experienceEntriesFingerprint, 'experience entries');
    check(Array.isArray(result.experienceLeaves) && result.experienceLeaves.length > 0
      && result.experienceLeaves.length <= 64 && fingerprint(result.experienceLeaves) === result.experienceEntriesFingerprint,
      'Experience origin leaves do not match their commitment');
    const leaves = new Map();
    for (const leaf of result.experienceLeaves) {
      keys(leaf, ['color', 'target', 'afterstateIndex', 'stateFingerprint', 'sampleFingerprint'], 'experience leaf');
      check(['white', 'dark'].includes(leaf.color) && leaf.target === (result.winner === leaf.color ? 1 : 0),
        'Experience leaf terminal label differs from source game');
      integer('experience afterstate index', leaf.afterstateIndex, 0, 4095);
      checkHash(leaf.stateFingerprint, 'experience state');
      checkHash(leaf.sampleFingerprint, 'experience sample');
      const body = { sourceGame: result.game, sourceTraceFingerprint: result.traceFingerprint,
        sourceModelFingerprint: result.modelFingerprintBefore, color: leaf.color, target: leaf.target,
        afterstateIndex: leaf.afterstateIndex, stateFingerprint: leaf.stateFingerprint };
      check(fingerprint(body) === leaf.sampleFingerprint && !leaves.has(leaf.sampleFingerprint),
        'Experience leaf has mismatched semantic/source commitment');
      leaves.set(leaf.sampleFingerprint, leaf);
    }
    leafMaps.set(result.game, leaves);
    check(Array.isArray(result.replaySources) && result.replaySources.length === result.replayTrainingSamples,
      'Replay SGD source count mismatch');
    let zeros = 0; let ones = 0;
    for (const source of result.replaySources) {
      keys(source, ['game', 'sampleFingerprint', 'experienceFingerprint'], 'replay source');
      integer('past experience game', source.game, 1, result.game - 1);
      check(eligibleGames.includes(source.game), 'Replay source was evicted from the eligible past experience window');
      const origin = artifact.results[source.game - 1];
      const leaf = leafMaps.get(source.game)?.get(source.sampleFingerprint);
      check(leaf && origin.experienceGameFingerprint === source.experienceFingerprint,
        'Replay sample is not committed by a prior real completed game');
      if (leaf.target === 0) zeros += 1; else ones += 1;
    }
    check(zeros === Math.ceil(result.replayTrainingSamples / 2) && ones === Math.floor(result.replayTrainingSamples / 2),
      'Replay must balance past terminal winner/loser labels');
    const availableTargets = new Set(eligibleGames.flatMap(game => [...leafMaps.get(game).values()].map(leaf => leaf.target)));
    check(result.replayTrainingSamples === (availableTargets.size === 2 ? segment.options.replaySamples : 0),
      'Replay count differs from configured eligible past terminal experience');
    eligibleGames = [...eligibleGames, result.game].slice(-segment.options.replayGames);
  }
  if (!artifact.experienceReplay) {
    check(!artifact.results.some(result => result.experienceLeaves !== undefined), 'Experience cache missing from replay artifact');
    return;
  }
  const cache = artifact.experienceReplay;
  keys(cache, ['schema', 'target', 'gamesCapacity', 'maxSamplesPerGame', 'replaySamplesPerEpisode',
    'selectionDomain', 'games', 'fingerprint'], 'terminal replay cache');
  check(cache.schema === 'long-neural-terminal-replay-v1' && cache.target === 'terminal-Monte-Carlo-only'
    && cache.maxSamplesPerGame === 64 && cache.selectionDomain === 'nardu/long-neural/terminal-replay-selection/v1',
    'Incompatible terminal replay cache');
  integer('experience capacity', cache.gamesCapacity, 1, 64);
  integer('experience replay samples', cache.replaySamplesPerEpisode, 1, 256);
  check(latestReplaySegment && cache.gamesCapacity === latestReplaySegment.options.replayGames
    && cache.replaySamplesPerEpisode === latestReplaySegment.options.replaySamples,
    'Experience cache settings differ from the latest recorded replay segment');
  const { fingerprint: cacheFingerprint, ...cacheBody } = cache;
  check(fingerprint(cacheBody) === cacheFingerprint && Array.isArray(cache.games)
    && cache.games.length > 0 && cache.games.length <= cache.gamesCapacity, 'Experience cache fingerprint/bounds mismatch');
  check(canonical(cache.games.map(game => game.game)) === canonical(eligibleGames),
    'Experience cache does not match the exact completed-game rolling window');
  let previousGame = 0;
  for (const game of cache.games) {
    keys(game, ['game', 'winner', 'traceFingerprint', 'sourceModelFingerprint', 'nativeTrainingSamples',
      'stateCounts', 'samples', 'fingerprint'], 'experience game');
    integer('cached completed game', game.game, previousGame + 1, artifact.trainingManifest.games);
    previousGame = game.game;
    const origin = artifact.results[game.game - 1];
    check(origin.completed && origin.winner === game.winner && origin.traceFingerprint === game.traceFingerprint
      && origin.modelFingerprintBefore === game.sourceModelFingerprint
      && origin.nativeTrainingSamples === game.nativeTrainingSamples
      && origin.experienceGameFingerprint === game.fingerprint, 'Cached experience source does not match completed game record');
    const { fingerprint: gameFingerprint, ...gameBody } = game;
    check(fingerprint(gameBody) === gameFingerprint && Array.isArray(game.samples)
      && game.samples.length === origin.experienceLeaves.length && game.samples.length <= 64, 'Cached experience game payload mismatch');
    keys(game.stateCounts, ['white', 'dark'], 'experience state counts');
    for (const color of ['white', 'dark']) integer('source nonterminal state count', game.stateCounts[color], 1, 4096);
    const sourceSegment = segmentsByGame[game.game - 1];
    const bothColors = origin.opponent === 'self' || sourceSegment.options?.learnColors === 'both';
    const expectedNativeSamples = bothColors ? game.stateCounts.white + game.stateCounts.dark
      : game.stateCounts[origin.candidateColor];
    check(game.nativeTrainingSamples === expectedNativeSamples,
      'Cached nonterminal state counts differ from native learning sample count');
    const used = new Set();
    for (const sample of game.samples) {
      keys(sample, ['sourceGame', 'sourceTraceFingerprint', 'sourceModelFingerprint', 'color', 'target',
        'afterstateIndex', 'stateFingerprint', 'state', 'fingerprint'], 'cached experience sample');
      const leaf = leafMaps.get(game.game)?.get(sample.fingerprint);
      check(leaf && sample.sourceGame === game.game && sample.sourceTraceFingerprint === game.traceFingerprint
        && sample.sourceModelFingerprint === game.sourceModelFingerprint
        && ['color', 'target', 'afterstateIndex', 'stateFingerprint'].every(key => sample[key] === leaf[key])
        && !used.has(sample.fingerprint), 'Cached state lacks matching origin leaf');
      used.add(sample.fingerprint);
      integer('cached afterstate index', sample.afterstateIndex, 0, game.stateCounts[sample.color] - 1);
      keys(sample.state, ['variant', 'points', 'bar', 'off', 'turn', 'phase', 'winner', 'dice', 'rolled',
        'firstMoveDone', 'turnMoves'], 'cached rule state');
      api.validateState(sample.state);
      check(sample.state.phase === 'roll' && sample.state.winner === null
        && sample.state.turn === (sample.color === 'white' ? 'dark' : 'white')
        && !sample.state.dice.length && !sample.state.rolled.length && !sample.state.turnMoves.length
        && fingerprint(sample.state) === sample.stateFingerprint, 'Cached state includes terminal/future/altered rule inputs');
    }
  }
}
function normalizedLegacySegment(artifact) {
  const manifest = artifact.trainingManifest;
  return {
    id: 0, importedLegacy: true, algorithm: 'episodic-terminal-only-TD(0)', lambda: 0,
    seed: manifest.seed, streamIndexStart: 0, games: manifest.games, samples: manifest.samples,
    options: manifest.options, initialModelFingerprint: artifact.initialModelFingerprint,
    modelFingerprintBefore: artifact.initialModelFingerprint, modelFingerprintAfter: artifact.modelFingerprint,
    runtimeFingerprint: artifact.runtimeFingerprint, inferenceCodeFingerprint: artifact.inferenceCodeFingerprint,
    seedStreamHelperFingerprint: artifact.seedStreamHelperFingerprint, harnessFingerprint: artifact.harnessFingerprint,
    parentArtifactFingerprint: null, parentModelFingerprint: null,
  };
}

function validateTrainingArtifact(artifact, context) {
  const { api, runtimeFingerprint, inferenceCodeFingerprint, seedStreamHelperFingerprint,
    streamSeeds, trainingDomain } = context || {};
  check(api && typeof api.validateModel === 'function' && typeof streamSeeds === 'function', 'Artifact validation context is required');
  check(artifact && [LEGACY_SCHEMA, CUMULATIVE_SCHEMA].includes(artifact.schema)
    && artifact.mode === 'experimental-offline-candidate' && artifact.productionEligible === false,
  'A complete offline training artifact is required');
  api.validateModel(artifact.model);
  check(artifact.modelFingerprint === fingerprint(artifact.model), 'Training model fingerprint mismatch');
  check(artifact.runtimeFingerprint === runtimeFingerprint, 'Training/evaluation rules bytes differ; retrain this candidate');
  check(artifact.inferenceCodeFingerprint === inferenceCodeFingerprint, 'Training/evaluation inference bytes differ; retrain this candidate');
  check(artifact.seedStreamHelperFingerprint === seedStreamHelperFingerprint,
    'Training/evaluation dice stream helper bytes differ; retrain this candidate');
  checkHash(artifact.initialModelFingerprint, 'initial model');
  checkHash(artifact.harnessFingerprint, 'training harness');
  const manifest = artifact.trainingManifest;
  check(manifest && manifest.target === 'win-probability' && manifest.diceDomain === trainingDomain, 'Invalid training provenance');
  integer('training games', manifest.games, 1, 1000000);
  integer('training samples', manifest.samples, 1, Number.MAX_SAFE_INTEGER - 1);
  check(Array.isArray(artifact.results) && artifact.results.length === manifest.games
    && Array.isArray(manifest.diceStreams) && manifest.diceStreams.length === manifest.games * 2,
  'Incomplete training dice provenance');
  let segments;
  if (artifact.schema === LEGACY_SCHEMA) {
    check(manifest.algorithm === 'episodic-terminal-only-TD(0)', 'Invalid legacy training algorithm');
    segments = [normalizedLegacySegment(artifact)];
  } else {
    check(manifest.algorithm === 'episodic-terminal-only-TD(lambda)' && Array.isArray(manifest.segments)
      && manifest.segments.length > 0 && manifest.segments.length <= 1000, 'Invalid cumulative training segments');
    segments = manifest.segments;
    checkHash(artifact.parentArtifactFingerprint, 'parent artifact');
    checkHash(artifact.parentModelFingerprint, 'parent model');
  }
  const expectedSeeds = [];
  const seen = new Set();
  const reserved = new Set();
  const segmentsByGame = [];
  let resultOffset = 0; let totalSamples = 0; let previousModel = artifact.initialModelFingerprint;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    check(segment && segment.id === segmentIndex, 'Non-contiguous training segment ids');
    integer('segment games', segment.games, 1, 100000);
    integer('segment samples', segment.samples, 1, Number.MAX_SAFE_INTEGER - 1);
    integer('segment seed', segment.seed, 1, 0xffffffff);
    integer('segment stream index start', segment.streamIndexStart, 0, 1000000);
    check(segment.streamIndexStart + segment.games <= 1000001, 'Training stream index limit exceeded');
    check(typeof segment.lambda === 'number' && Number.isFinite(segment.lambda) && segment.lambda >= 0 && segment.lambda <= 1,
      'Invalid segment TD lambda');
    check(segment.algorithm === (segment.lambda === 0 ? 'episodic-terminal-only-TD(0)' : 'episodic-terminal-only-TD(lambda)'),
      'Segment algorithm/lambda mismatch');
    check(segment.initialModelFingerprint === artifact.initialModelFingerprint
      && segment.modelFingerprintBefore === previousModel, 'Broken cumulative model chain');
    for (const [key, expected] of [['runtimeFingerprint', runtimeFingerprint],
      ['inferenceCodeFingerprint', inferenceCodeFingerprint], ['seedStreamHelperFingerprint', seedStreamHelperFingerprint]]) {
      check(segment[key] === expected, `Training segment ${key} differs`);
    }
    checkHash(segment.harnessFingerprint, 'segment harness');
    checkHash(segment.modelFingerprintBefore, 'segment model before');
    checkHash(segment.modelFingerprintAfter, 'segment model after');
    if (segment.options?.forbiddenDiceStreams !== undefined) {
      check(Array.isArray(segment.options.forbiddenDiceStreams)
        && segment.options.forbiddenDiceStreams.length <= 1000000, 'Invalid reserved dice provenance');
      for (const seed of segment.options.forbiddenDiceStreams) {
        integer('reserved dice seed', seed, 1, 0xffffffff); reserved.add(seed);
      }
    }
    if (segmentIndex > 0) {
      checkHash(segment.parentArtifactFingerprint, 'segment parent artifact');
      check(segment.parentModelFingerprint === segment.modelFingerprintBefore, 'Segment parent model does not match its start');
    }
    let segmentSamples = 0;
    let episodeModel = segment.modelFingerprintBefore;
    for (let localIndex = 0; localIndex < segment.games; localIndex += 1) {
      const result = artifact.results[resultOffset + localIndex];
      segmentsByGame[resultOffset + localIndex] = segment;
      const streamIndex = segment.streamIndexStart + localIndex;
      const seeds = streamSeeds(trainingDomain, segment.seed, streamIndex);
      check(result && result.game === resultOffset + localIndex + 1 && result.completed === true
        && ['white', 'dark'].includes(result.winner) && ['white', 'dark'].includes(result.candidateColor)
        && result.candidateWon === (result.winner === result.candidateColor)
        && ['normal', 'mars', 'koks'].includes(result.resultType)
        && canonical(result.streamSeeds) === canonical(seeds), 'Censored/mismatched game in training manifest');
      keys(result.off, ['white', 'dark'], 'terminal borne-off counts');
      for (const color of ['white', 'dark']) integer('terminal borne-off count', result.off[color], 0, 15);
      const loser = result.winner === 'white' ? 'dark' : 'white';
      check(result.off[result.winner] === 15 && result.off[loser] < 15
        && (result.resultType === 'normal' ? result.off[loser] > 0 : result.off[loser] === 0),
        'Completed game terminal borne-off counts differ from its winner/result');
      if (artifact.schema === CUMULATIVE_SCHEMA && !segment.importedLegacy) {
        check(result.segmentId === segmentIndex && result.streamIndex === streamIndex, 'Training game segment/index mismatch');
      }
      segmentSamples += integer('training samples per game', result.trainingSamples, 1, 8192);
      if (segment.options?.replayGames) {
        check(result.modelFingerprintBefore === episodeModel, 'Replay episode model chain does not match the segment');
        episodeModel = result.modelFingerprintAfter;
      }
      for (const color of ['white', 'dark']) {
        check(!seen.has(seeds[color]), 'Repeated training dice stream');
        seen.add(seeds[color]); expectedSeeds.push(seeds[color]);
      }
    }
    check(segmentSamples === segment.samples, 'Training segment sample count mismatch');
    if (segment.options?.replayGames) check(episodeModel === segment.modelFingerprintAfter, 'Replay segment final model chain mismatch');
    resultOffset += segment.games; totalSamples += segmentSamples;
    previousModel = segment.modelFingerprintAfter;
  }
  check(resultOffset === manifest.games && totalSamples === manifest.samples
    && artifact.model.trainingSteps === totalSamples && previousModel === artifact.modelFingerprint
    && canonical(expectedSeeds) === canonical(manifest.diceStreams), 'Training seed/sample/model manifest does not match the model');
  check(expectedSeeds.every(seed => !reserved.has(seed)), 'Training provenance overlaps reserved validation/confirmation dice');
  if (artifact.schema === CUMULATIVE_SCHEMA) {
    const last = segments[segments.length - 1];
    check(artifact.parentArtifactFingerprint === last.parentArtifactFingerprint
      && artifact.parentModelFingerprint === last.parentModelFingerprint, 'Cumulative artifact parent linkage mismatch');
  }
  if (artifact.trainingStatus) {
    const status = artifact.trainingStatus;
    integer('requested segment games', status.requestedGames, 1, 100000);
    integer('completed segment games', status.completedGames, 1, status.requestedGames);
    check(status.totalCompletedGames === manifest.games && typeof status.complete === 'boolean'
      && status.complete === (status.completedGames === status.requestedGames), 'Training checkpoint completion status mismatch');
    if (artifact.schema === CUMULATIVE_SCHEMA) check(status.completedGames === segments[segments.length - 1].games,
      'Training checkpoint status differs from terminal segment count');
  }
  validateReplayProvenance(artifact, api, segmentsByGame);
  return { ...manifest, segments, sourceSchema: artifact.schema };
}

module.exports = { LEGACY_SCHEMA, CUMULATIVE_SCHEMA, canonical, fingerprint,
  normalizedLegacySegment, validateTrainingArtifact, validateReplayProvenance };
