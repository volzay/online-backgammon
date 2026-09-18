#!/usr/bin/env node
'use strict';

// Offline only. No accounts, server calls, production dice or policy changes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createDiceStream, parseCliTokens } = require('./simulate-long-bot-regression');
const artifacts = require('../lib/long-neural-artifact');

const ROOT = path.join(__dirname, '..');
const SCHEMA = 'long-neural-training-artifact-v1';
const CUMULATIVE_SCHEMA = artifacts.CUMULATIVE_SCHEMA;
const OPPONENTS = Object.freeze(['self', 'random', 'pip', 'greedy']);
const TRAIN_DOMAIN = 'nardu/long-neural/training-dice/v1';
const EVALUATION_DOMAIN = 'nardu/long-neural/held-out-dice/v1';
const SAMPLE_ORDER_DOMAIN = 'nardu/long-neural/training-sample-order/v1';
const REPLAY_DOMAIN = 'nardu/long-neural/terminal-replay-selection/v1';
const REPLAY_SCHEMA = 'long-neural-terminal-replay-v1';
const REPLAY_MAX_GAME_SAMPLES = 64;
const SEED_HELPER_FINGERPRINT = fingerprint(fs.readFileSync(require.resolve('./simulate-long-bot-regression')));
const HARNESS_FINGERPRINT = fingerprint(fs.readFileSync(__filename));
const NEURAL_SOURCE_BYTES = fs.readFileSync(path.join(ROOT, 'lib/long-bot-neural.js'));
const NEURAL_CODE_FINGERPRINT = fingerprint(NEURAL_SOURCE_BYTES);
let isolatedNeuralApi;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function fingerprint(value) {
  return `sha256:${crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex')}`;
}
function neuralApi() {
  if (!isolatedNeuralApi) {
    const module = { exports: {} };
    // This is trusted repository code, not an uploaded/external program. A
    // private CommonJS factory compiled from captured bytes preserves source
    // provenance without require-cache drift. Executing in the host realm
    // avoids a VM global-proxy lookup for every gradient weight update.
    const factory = vm.compileFunction(NEURAL_SOURCE_BYTES.toString('utf8'), ['module'],
      { filename: 'lib/long-bot-neural.js' });
    factory(module);
    isolatedNeuralApi = module.exports;
  }
  return isolatedNeuralApi;
}
function modelFingerprint(model) {
  const api = neuralApi();
  return typeof api.modelFingerprint === 'function' ? api.modelFingerprint(model) : fingerprint(model);
}

function loadLongGame() {
  const bytes = fs.readFileSync(path.join(ROOT, 'game.js'));
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => { throw new Error('Unseeded randomness is forbidden in neural experiments'); };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [1])); }
    static now() { return 1; }
  }
  // Trusted rules bytes run in a private factory, never the real window. The
  // explicit Math/Date arguments keep all offline randomness/time deterministic
  // while avoiding VM global-proxy overhead during legal-sequence enumeration.
  const privateWindow = {};
  const factory = vm.compileFunction(bytes.toString('utf8'), ['window', 'Math', 'Date'], { filename: 'game.js' });
  factory(privateWindow, deterministicMath, FixedDate);
  return { game: privateWindow.NarduGame, fingerprint: fingerprint(bytes) };
}

function integer(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
function ratio(name, value, minimum = 0, maximum = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite number from ${minimum} to ${maximum}`);
  }
  return value;
}
function seededRandom(seed) {
  let value = integer('random seed', seed, 1, 0xffffffff) >>> 0;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) / 0x100000000;
  };
}
function streamSeeds(domain, seed, index, opponent = '') {
  integer('seed', seed, 1, 0xffffffff);
  integer('stream index', index, 0, 1000000);
  const result = {};
  for (const color of ['white', 'dark']) {
    let counter = 0;
    do {
      const bytes = crypto.createHash('sha256').update(canonical([domain, seed, index, opponent, color, counter++])).digest();
      result[color] = bytes.readUInt32BE(0);
    } while (!result[color]);
  }
  if (result.white === result.dark) throw new Error('Derived dice stream collision');
  return result;
}
function assertDisjointStreams(records, forbidden = []) {
  const seen = new Set(forbidden);
  for (const record of records) {
    for (const color of ['white', 'dark']) {
      const seed = record.streamSeeds[color];
      integer('dice stream seed', seed, 1, 0xffffffff);
      if (seen.has(seed)) throw new Error('Training/evaluation dice stream collision or repeated seed');
      seen.add(seed);
    }
  }
  return true;
}

function applyPlan(game, state, plan) {
  if (!Array.isArray(plan)) throw new Error('Bot plan must be an array');
  for (const move of plan) {
    if (!game.applyMove(state, move.from, move.die, { autoEnd: false })) {
      throw new Error(`Illegal neural experiment move: ${move.from}/${move.die}`);
    }
    if (state.winner) break;
  }
  if (!state.winner && game.hasAnyMoves(state)) throw new Error('Incomplete bot plan: legal moves remain');
}
function baselineScore(game, state, color, name) {
  const ownOff = state.off[color] || 0;
  if (name === 'pip') return ownOff * 10000 - game.pipsFor(state, color);
  let home = 0; let spread = 0; let head = 0;
  for (const [point, stack] of Object.entries(state.points)) {
    if (stack.color !== color) continue;
    const progress = game.pathPos(color, Number(point), state);
    if (progress >= 18) home += stack.count;
    if (progress === 0) head += stack.count;
    spread += 1;
  }
  return ownOff * 10000 + home * 35 - game.pipsFor(state, color) - head * 8 + spread * 2;
}
function createBaseline(game, name, rng, maxCandidates) {
  if (!['random', 'pip', 'greedy'].includes(name)) throw new Error(`Unsupported baseline: ${name}`);
  return {
    plan(state) {
      // Sampling never authorizes illegal/incomplete sequences. Every chosen
      // sequence is replayed through the exact game rules before execution.
      const legal = game.bestMoveSequences(state, state.turn);
      if (!legal.length) return [];
      if (name === 'random') return legal[Math.floor(rng() * legal.length)].map(({ from, die }) => ({ from, die }));
      let best = null; let score = -Infinity;
      // Include evenly spaced alternatives rather than truncating a DFS prefix.
      const count = Math.min(legal.length, maxCandidates);
      for (let index = 0; index < count; index += 1) {
        const sequence = legal[Math.floor(index * legal.length / count)];
        const next = clone(state);
        applyPlan(game, next, sequence);
        const value = baselineScore(game, next, state.turn, name);
        if (value > score) { score = value; best = sequence; }
      }
      return best.map(({ from, die }) => ({ from, die }));
    },
  };
}

function playEpisode({ game, candidate, opponent, candidateColor, seeds, maxPlies = 640,
  maxGameMs = 30000, collectTraining = false }) {
  integer('maxPlies', maxPlies, 1, 4096);
  integer('maxGameMs', maxGameMs, 1, 3600000);
  if (!['white', 'dark'].includes(candidateColor)) throw new Error('Invalid candidate color');
  const started = performance.now();
  const streams = { white: createDiceStream(seeds.white), dark: createDiceStream(seeds.dark) };
  const state = game.initialState('long');
  let whiteDie; let darkDie;
  do { whiteDie = streams.white.openingDie(); darkDie = streams.dark.openingDie(); } while (whiteDie === darkDie);
  game.decideOpeningRoll(state, { id: 'white', color: 'white', die: whiteDie }, { id: 'dark', color: 'dark', die: darkDie });
  if (!game.startOpeningTurn(state)) throw new Error('Opening turn could not start');
  const afterstates = { white: [], dark: [] };
  const trace = crypto.createHash('sha256');
  let plies = 0;
  while (!state.winner) {
    if (plies >= maxPlies) throw new Error(`Censored game exceeded ${maxPlies} plies; no result or learning credit`);
    if (performance.now() - started > maxGameMs) throw new Error('Censored game exceeded wall-time budget; no result or learning credit');
    plies += 1;
    const color = state.turn;
    const dice = streams[color].roll();
    game.applyRoll(state, dice);
    state.history = []; // Offline trace is hashed separately; avoid quadratic history copies.
    const bot = color === candidateColor ? candidate : opponent;
    const plan = game.hasAnyMoves(state) ? bot.plan(state) : [];
    applyPlan(game, state, plan);
    if (!state.winner) game.endTurn(state);
    trace.update(canonical([color, dice, plan, state.points, state.off]));
    if (collectTraining) afterstates[color].push(clone(state));
  }
  return {
    completed: true, candidateColor, winner: state.winner, candidateWon: state.winner === candidateColor,
    resultType: state.resultType || 'normal', plies, off: { ...state.off },
    traceFingerprint: `sha256:${trace.digest('hex')}`, afterstates,
  };
}

function tdTargets(api, frozenModel, episode, colors, lambda = 0) {
  ratio('TD lambda', lambda);
  if (episode.completed !== true || !['white', 'dark'].includes(episode.winner)) {
    throw new Error('Only terminal complete games can train');
  }
  const samples = [];
  for (const color of colors) {
    // Terminal predictions are exact rule outcomes, not trainable network
    // outputs. Credit the preceding nonterminal afterstate instead.
    const states = episode.afterstates[color].filter(state => !state.winner);
    // Offline forward-view lambda return, computed backward from the known
    // terminal outcome with the SAME frozen episode network. lambda=0 is the
    // original one-step TD target; lambda=1 credits every state with outcome.
    const targets = [];
    let nextTarget = episode.winner === color ? 1 : 0;
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const target = index === states.length - 1 || lambda === 1 ? nextTarget
        : (1 - lambda) * api.predict(frozenModel, states[index + 1], color) + lambda * nextTarget;
      ratio('TD target probability', target);
      targets[index] = target;
      nextTarget = target;
    }
    for (let index = 0; index < states.length; index += 1) {
      samples.push({ state: states[index], color, target: targets[index] });
    }
  }
  return samples;
}

function orderSamples(samples, order = 'chronological', rng) {
  if (!Array.isArray(samples) || !['chronological', 'seeded-shuffle'].includes(order)) {
    throw new Error('Sample order must be chronological or seeded-shuffle');
  }
  const ordered = samples.slice();
  // Legacy order is chronological WITHIN each color, with colors contiguous.
  // Preserve it for replay compatibility, but label it accurately in metadata.
  if (order === 'chronological') return ordered;
  if (typeof rng !== 'function') throw new Error('Sample shuffle requires explicit isolated offline randomness');
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const draw = rng();
    if (typeof draw !== 'number' || !Number.isFinite(draw) || draw < 0 || draw >= 1) {
      throw new Error('Sample shuffle RNG must return a finite value in [0,1)');
    }
    const selected = Math.floor(draw * (index + 1));
    [ordered[index], ordered[selected]] = [ordered[selected], ordered[index]];
  }
  return ordered;
}

function compactReplayState(state) {
  // Exactly the fields read by the 127-feature encoder, without clock/history,
  // future dice, telemetry or fabricated historical positions.
  return { variant: state.variant, points: clone(state.points), bar: clone(state.bar), off: clone(state.off),
    turn: state.turn, phase: state.phase, winner: state.winner || null,
    dice: state.dice.slice(), rolled: state.rolled.slice(), firstMoveDone: clone(state.firstMoveDone),
    turnMoves: state.turnMoves.map(move => ({ ...move })) };
}
function createExperienceGame(game, episode, sourceModelFingerprint, nativeTrainingSamples, api = neuralApi()) {
  if (!episode.completed || !['white', 'dark'].includes(episode.winner)) throw new Error('Replay requires a real completed terminal episode');
  const states = Object.fromEntries(['white', 'dark'].map(color => [color,
    episode.afterstates[color].filter(state => !state.winner)]));
  const limits = Object.fromEntries(['white', 'dark'].map(color => [color,
    Math.min(states[color].length, REPLAY_MAX_GAME_SAMPLES / 2)]));
  let remaining = REPLAY_MAX_GAME_SAMPLES - limits.white - limits.dark;
  for (const color of ['white', 'dark']) {
    const extra = Math.min(remaining, states[color].length - limits[color]);
    limits[color] += extra; remaining -= extra;
  }
  const samples = [];
  for (const color of ['white', 'dark']) {
    for (let index = 0; index < limits[color]; index += 1) {
      const afterstateIndex = Math.floor(index * states[color].length / limits[color]);
      const state = compactReplayState(states[color][afterstateIndex]);
      api.validateState(state);
      if (state.phase !== 'roll' || state.turn !== (color === 'white' ? 'dark' : 'white')
        || state.dice.length || state.rolled.length || state.turnMoves.length) {
        throw new Error('Replay can cache only genuine nonterminal after-turn states');
      }
      const body = { sourceGame: game, sourceTraceFingerprint: episode.traceFingerprint,
        sourceModelFingerprint, color, target: episode.winner === color ? 1 : 0,
        afterstateIndex, stateFingerprint: fingerprint(state) };
      samples.push({ ...body, state, fingerprint: fingerprint(body) });
    }
  }
  const body = { game, winner: episode.winner, traceFingerprint: episode.traceFingerprint,
    sourceModelFingerprint, nativeTrainingSamples,
    stateCounts: { white: states.white.length, dark: states.dark.length }, samples };
  return { ...body, fingerprint: fingerprint(body) };
}
function selectReplaySamples(games, count, rng) {
  const samples = games.flatMap(game => game.samples.map(sample => ({ sample, game })));
  const groups = [samples.filter(({ sample }) => sample.target === 0),
    samples.filter(({ sample }) => sample.target === 1)];
  // Homogeneous terminal labels would recreate the global output-bias failure.
  if (!groups[0].length || !groups[1].length) return [];
  return Array.from({ length: count }, (_, index) => {
    const group = groups[index % 2];
    const draw = rng();
    if (typeof draw !== 'number' || !Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Invalid replay RNG');
    const { sample, game } = group[Math.floor(draw * group.length)];
    return { state: clone(sample.state), color: sample.color, target: sample.target,
      replaySource: { game: game.game, sampleFingerprint: sample.fingerprint, experienceFingerprint: game.fingerprint } };
  });
}
function buildReplayArtifact(games, options) {
  const body = { schema: REPLAY_SCHEMA, target: 'terminal-Monte-Carlo-only', gamesCapacity: options.replayGames,
    maxSamplesPerGame: REPLAY_MAX_GAME_SAMPLES, replaySamplesPerEpisode: options.replaySamples,
    selectionDomain: REPLAY_DOMAIN, games: clone(games) };
  return { ...body, fingerprint: fingerprint(body) };
}

function trainingOptions(input = {}) {
  const options = { games: 64, seed: 0x39a11, hiddenSize: 32, maxPlies: 640,
    maxCandidates: 16, maxGameMs: 30000, maxElapsedMs: 120000,
    epsilon: 0.1, learningRate: 0.01, lambda: 0, checkpointEvery: 16,
    sampleOrder: 'chronological', learnColors: 'candidate', replayGames: 0, replaySamples: 64,
    opponents: [...OPPONENTS], forbiddenDiceStreams: [], ...input };
  integer('games', options.games, 1, 100000);
  integer('seed', options.seed, 1, 0xffffffff);
  integer('hiddenSize', options.hiddenSize, 4, 128);
  integer('maxPlies', options.maxPlies, 1, 4096);
  integer('maxCandidates', options.maxCandidates, 1, 256);
  integer('maxGameMs', options.maxGameMs, 1, 3600000);
  integer('maxElapsedMs', options.maxElapsedMs, 1, 86400000);
  ratio('epsilon', options.epsilon);
  ratio('learningRate', options.learningRate, Number.MIN_VALUE, 1);
  ratio('lambda', options.lambda);
  integer('checkpointEvery', options.checkpointEvery, 1, 100000);
  if (!['chronological', 'seeded-shuffle'].includes(options.sampleOrder)) {
    throw new Error('sampleOrder must be chronological or seeded-shuffle');
  }
  if (!['candidate', 'both'].includes(options.learnColors)) {
    throw new Error('learnColors must be candidate or both');
  }
  integer('replayGames', options.replayGames, 0, 64);
  integer('replaySamples', options.replaySamples, 1, 256);
  if (options.replayGames && options.lambda !== 1) throw new Error('Terminal replay requires lambda=1 Monte Carlo targets');
  if (!Array.isArray(options.forbiddenDiceStreams) || options.forbiddenDiceStreams.length > 1000000
    || new Set(options.forbiddenDiceStreams).size !== options.forbiddenDiceStreams.length) {
    throw new Error('forbiddenDiceStreams must be a bounded unique array of reserved uint32 seeds');
  }
  for (const seed of options.forbiddenDiceStreams) integer('reserved dice stream seed', seed, 1, 0xffffffff);
  if (!Array.isArray(options.opponents) || !options.opponents.length
    || new Set(options.opponents).size !== options.opponents.length
    || options.opponents.some(name => !OPPONENTS.includes(name))) {
    throw new Error('Training opponents must be unique self/random/pip/greedy names');
  }
  return options;
}

function validateTrainingProvenance(artifact, api = neuralApi(), runtime = loadLongGame()) {
  return artifacts.validateTrainingArtifact(artifact, { api, runtimeFingerprint: runtime.fingerprint,
    inferenceCodeFingerprint: NEURAL_CODE_FINGERPRINT, seedStreamHelperFingerprint: SEED_HELPER_FINGERPRINT,
    streamSeeds, trainingDomain: TRAIN_DOMAIN });
}

function runTraining(input = {}, dependencies = {}) {
  const inheritedReplay = input.resumeArtifact?.experienceReplay;
  if (inheritedReplay && input.replayGames === 0) {
    throw new Error('Existing terminal experience cannot be silently disabled/discarded; retain replay on resume');
  }
  const options = trainingOptions({
    ...(inheritedReplay ? { replayGames: inheritedReplay.gamesCapacity,
      replaySamples: inheritedReplay.replaySamplesPerEpisode, lambda: 1 } : {}),
    ...input, hiddenSize: input.hiddenSize ?? input.resumeArtifact?.model?.hiddenSize ?? 32,
  });
  const api = dependencies.api || neuralApi();
  const runtime = dependencies.runtime || loadLongGame();
  if (input.resumeArtifact && input.initialModel) throw new Error('Resume and initial model are mutually exclusive');
  const prior = input.resumeArtifact ? clone(input.resumeArtifact) : null;
  const priorManifest = prior ? validateTrainingProvenance(prior, api, runtime) : null;
  options.forbiddenDiceStreams = [...new Set([
    ...(priorManifest?.segments.flatMap(segment => segment.options?.forbiddenDiceStreams || []) || []),
    ...options.forbiddenDiceStreams,
  ])];
  const reserved = new Set(options.forbiddenDiceStreams);
  if (priorManifest?.diceStreams.some(seed => reserved.has(seed))) {
    throw new Error('Existing training provenance overlaps reserved validation/confirmation dice');
  }
  let model = prior ? clone(prior.model) : input.initialModel ? clone(input.initialModel)
    : api.createModel({ seed: options.seed, hiddenSize: options.hiddenSize });
  api.validateModel(model);
  if (!prior && model.trainingSteps !== 0) throw new Error('Initial model must be untrained: cumulative training provenance is required');
  if (prior && model.hiddenSize !== options.hiddenSize) throw new Error('Resume hidden size must match the existing trained model');
  const initialFingerprint = prior ? prior.initialModelFingerprint : modelFingerprint(model);
  const parentModelFingerprint = modelFingerprint(model);
  const parentArtifactFingerprint = prior ? fingerprint(prior)
    : fingerprint({ schema: 'nardu-long-neural-initial-model-v1', model });
  const cumulative = Boolean(prior || options.lambda > 0);
  const previousSegments = priorManifest ? clone(priorManifest.segments) : [];
  const segmentId = previousSegments.length;
  const priorResults = prior ? clone(prior.results) : [];
  const priorGames = priorResults.length;
  const priorSamples = priorManifest ? priorManifest.samples : 0;
  const replayEnabled = options.replayGames > 0;
  let experienceGames = replayEnabled ? clone(prior?.experienceReplay?.games || []).slice(-options.replayGames) : [];
  if (priorGames + options.games > 1000000) throw new Error('Cumulative training exceeds one million completed games');
  let streamIndexStart = 0;
  for (const segment of previousSegments) {
    if (segment.seed === options.seed) streamIndexStart = Math.max(streamIndexStart, segment.streamIndexStart + segment.games);
  }
  if (streamIndexStart + options.games > 1000001) throw new Error('Training stream index limit exceeded');
  const appearances = Object.fromEntries(options.opponents.map(name => [name,
    priorResults.filter(result => result.opponent === name).length]));
  const records = Array.from({ length: options.games }, (_, index) => {
    const opponent = options.opponents[index % options.opponents.length];
    const appearance = appearances[opponent]++;
    return { game: priorGames + index + 1, opponent,
      candidateColor: appearance % 2 ? 'dark' : 'white',
      streamIndex: streamIndexStart + index, segmentId,
      streamSeeds: streamSeeds(TRAIN_DOMAIN, options.seed, streamIndexStart + index) };
  });
  assertDisjointStreams(records, [...(priorManifest?.diceStreams || []), ...options.forbiddenDiceStreams]);
  const started = performance.now();
  let results = []; let samples = 0;
  const { initialModel, resumeArtifact, ...publicOptions } = options;
  function artifact(complete = false) {
    if (!results.length) return null;
    const currentFingerprint = modelFingerprint(model);
    const allResults = [...priorResults, ...results];
    const status = { requestedGames: options.games, completedGames: results.length,
      totalCompletedGames: allResults.length, complete: results.length === options.games };
    const common = {
      schema: cumulative ? CUMULATIVE_SCHEMA : SCHEMA,
      mode: 'experimental-offline-candidate', productionEligible: false,
      model: clone(model), modelFingerprint: currentFingerprint, initialModelFingerprint: initialFingerprint,
      runtimeFingerprint: runtime.fingerprint, inferenceCodeFingerprint: NEURAL_CODE_FINGERPRINT,
      harnessFingerprint: HARNESS_FINGERPRINT, seedStreamHelperFingerprint: SEED_HELPER_FINGERPRINT,
      trainingStatus: status, results: clone(allResults),
    };
    if (replayEnabled) common.experienceReplay = buildReplayArtifact(experienceGames, options);
    else if (prior?.experienceReplay) common.experienceReplay = clone(prior.experienceReplay);
    const diceStreams = [...(priorManifest?.diceStreams || []),
      ...results.flatMap(result => [result.streamSeeds.white, result.streamSeeds.dark])];
    if (!cumulative) {
      common.trainingManifest = { algorithm: 'episodic-terminal-only-TD(0)', target: 'win-probability',
        diceDomain: TRAIN_DOMAIN, seed: options.seed, games: results.length, samples,
        diceStreams, options: publicOptions };
    } else {
      const segment = { id: segmentId, importedLegacy: false,
        algorithm: options.lambda === 0 ? 'episodic-terminal-only-TD(0)' : 'episodic-terminal-only-TD(lambda)',
        lambda: options.lambda, seed: options.seed, streamIndexStart, games: results.length, samples,
        sampleOrder: options.sampleOrder,
        orderingAlgorithm: options.sampleOrder === 'seeded-shuffle' ? 'seeded-fisher-yates-v1' : 'color-major-chronological-v1',
        sampleOrderDomain: SAMPLE_ORDER_DOMAIN,
        options: publicOptions, initialModelFingerprint: initialFingerprint,
        modelFingerprintBefore: parentModelFingerprint, modelFingerprintAfter: currentFingerprint,
        runtimeFingerprint: runtime.fingerprint, inferenceCodeFingerprint: NEURAL_CODE_FINGERPRINT,
        seedStreamHelperFingerprint: SEED_HELPER_FINGERPRINT, harnessFingerprint: HARNESS_FINGERPRINT,
        parentArtifactFingerprint, parentModelFingerprint };
      common.parentArtifactFingerprint = parentArtifactFingerprint;
      common.parentModelFingerprint = parentModelFingerprint;
      common.trainingManifest = { algorithm: 'episodic-terminal-only-TD(lambda)', target: 'win-probability',
        diceDomain: TRAIN_DOMAIN, games: priorGames + results.length, samples: priorSamples + samples,
        diceStreams, segments: [...clone(previousSegments), segment] };
    }
    return common;
  }
  function checkpoint(complete = false) {
    const saved = artifact(complete);
    if (saved && dependencies.onCheckpoint) dependencies.onCheckpoint(saved);
    return saved;
  }
  try {
    for (let index = 0; index < records.length; index += 1) {
      const remainingMs = Math.floor(options.maxElapsedMs - (performance.now() - started));
      if (remainingMs <= 0) throw new Error('Training run exceeded total wall-time budget');
      const record = records[index];
      const frozenModel = clone(model);
      const policySeed = streamSeeds('nardu/long-neural/training-policy/v1', options.seed, record.streamIndex);
      const candidate = api.createNeuralBot(runtime.game, frozenModel, {
        epsilon: options.epsilon, rng: seededRandom(policySeed.white), maxCandidates: options.maxCandidates,
      });
      const opponent = record.opponent === 'self'
        ? api.createNeuralBot(runtime.game, frozenModel, { epsilon: options.epsilon,
          rng: seededRandom(policySeed.dark), maxCandidates: options.maxCandidates })
        : createBaseline(runtime.game, record.opponent, seededRandom(policySeed.dark), options.maxCandidates);
      const episode = (dependencies.playEpisode || playEpisode)({ game: runtime.game, candidate, opponent,
        candidateColor: record.candidateColor, seeds: record.streamSeeds, maxPlies: options.maxPlies,
        maxGameMs: Math.min(options.maxGameMs, remainingMs), collectTraining: true });
      if (performance.now() - started > options.maxElapsedMs) throw new Error('Training run exceeded total wall-time budget before episode credit');
      const batch = tdTargets(api, frozenModel, episode,
        record.opponent === 'self' || options.learnColors === 'both' ? ['white', 'dark'] : [record.candidateColor], options.lambda);
      if (!batch.length) throw new Error('Terminal episode has no nonterminal training states');
      const beforeFingerprint = modelFingerprint(frozenModel);
      // Select only PAST committed experience; never replay the currently
      // finishing game until its complete gradient/cache transaction is saved.
      const replaySeed = streamSeeds(REPLAY_DOMAIN, options.seed, record.streamIndex).white;
      const replayBatch = replayEnabled ? selectReplaySamples(experienceGames, options.replaySamples, seededRandom(replaySeed)) : [];
      const newExperience = replayEnabled ? createExperienceGame(record.game, episode, beforeFingerprint, batch.length, api) : null;
      const sampleOrderSeed = streamSeeds(SAMPLE_ORDER_DOMAIN, options.seed, record.streamIndex).white;
      const orderedBatch = orderSamples([...batch, ...replayBatch], options.sampleOrder, seededRandom(sampleOrderSeed));
      // Stage the WHOLE terminal episode update. A failed gradient/validation
      // never leaks a partially trained model into checkpoints or provenance.
      const nextModel = clone(model);
      for (const sample of orderedBatch) api.trainSample(nextModel, sample.state, sample.color, sample.target,
        { learningRate: options.learningRate });
      api.validateModel(nextModel);
      const { afterstates, ...result } = episode;
      const publicRecord = { ...record };
      if (!cumulative) { delete publicRecord.streamIndex; delete publicRecord.segmentId; }
      const trainingResult = { ...publicRecord, ...result, trainingSamples: orderedBatch.length };
      if (replayEnabled) {
        const leaves = newExperience.samples.map(sample => ({ color: sample.color, target: sample.target,
          afterstateIndex: sample.afterstateIndex, stateFingerprint: sample.stateFingerprint,
          sampleFingerprint: sample.fingerprint }));
        Object.assign(trainingResult, { nativeTrainingSamples: batch.length, replayTrainingSamples: replayBatch.length,
          modelFingerprintBefore: beforeFingerprint, modelFingerprintAfter: modelFingerprint(nextModel),
          experienceGameFingerprint: newExperience.fingerprint,
          experienceLeaves: leaves, experienceEntriesFingerprint: fingerprint(leaves),
          replaySources: replayBatch.map(sample => sample.replaySource) });
      }
      // Construct every potentially throwing hash/record/cache allocation
      // BEFORE publishing ANY episode component. Primitive assignments below
      // form one synchronous completed-episode commit for all checkpoints.
      const nextExperienceGames = replayEnabled ? [...experienceGames, newExperience].slice(-options.replayGames) : experienceGames;
      const nextResults = [...results, trainingResult];
      const nextSamples = samples + orderedBatch.length;
      model = nextModel; samples = nextSamples; results = nextResults; experienceGames = nextExperienceGames;
      if (dependencies.onProgress) dependencies.onProgress({ completedGames: results.length,
        requestedGames: options.games, totalCompletedGames: priorGames + results.length,
        samples: priorSamples + samples, elapsedMs: performance.now() - started });
      if (results.length % options.checkpointEvery === 0 || results.length === options.games) {
        checkpoint(results.length === options.games);
      }
    }
    return artifact(true);
  } catch (error) {
    error.completedArtifact = checkpoint(false);
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  if (!file || !path.isAbsolute(file)) throw new Error('Artifact output must be an explicit absolute path');
  const directory = path.dirname(file);
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) throw new Error('Artifact output directory does not exist');
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

const VALUE_OPTIONS = new Set(['games', 'seed', 'hidden-size', 'max-plies', 'max-candidates',
  'max-game-ms', 'max-elapsed-ms', 'epsilon', 'learning-rate', 'lambda', 'checkpoint-every',
  'sample-order', 'learn-colors', 'replay-games', 'replay-samples',
  'opponents', 'output', 'initial-model', 'resume', 'forbidden-dice-seeds']);
function cliOptions(argv) {
  const parsed = parseCliTokens(argv, VALUE_OPTIONS, new Set(['help']));
  if (parsed.flags.has('help')) return { help: true };
  const options = {};
  const mapping = { games: 'games', seed: 'seed', 'hidden-size': 'hiddenSize', 'max-plies': 'maxPlies',
    'max-candidates': 'maxCandidates', 'max-game-ms': 'maxGameMs', 'max-elapsed-ms': 'maxElapsedMs',
    epsilon: 'epsilon', 'learning-rate': 'learningRate', lambda: 'lambda', 'checkpoint-every': 'checkpointEvery',
    'replay-games': 'replayGames', 'replay-samples': 'replaySamples' };
  for (const [flag, key] of Object.entries(mapping)) {
    if (parsed.values.has(flag)) options[key] = Number(parsed.values.get(flag));
  }
  if (parsed.values.has('opponents')) options.opponents = parsed.values.get('opponents').split(',');
  if (parsed.values.has('sample-order')) options.sampleOrder = parsed.values.get('sample-order');
  if (parsed.values.has('learn-colors')) options.learnColors = parsed.values.get('learn-colors');
  if (parsed.values.has('resume')) {
    const file = parsed.values.get('resume');
    if (!path.isAbsolute(file)) throw new Error('--resume requires an explicit absolute artifact path');
    const bytes = fs.readFileSync(file);
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Resume artifact exceeds the 64 MiB offline input limit');
    options.resumeArtifact = JSON.parse(bytes.toString('utf8'));
    if (!parsed.values.has('hidden-size')) options.hiddenSize = options.resumeArtifact?.model?.hiddenSize;
  }
  if (parsed.values.has('forbidden-dice-seeds')) {
    const file = parsed.values.get('forbidden-dice-seeds');
    if (!path.isAbsolute(file)) throw new Error('--forbidden-dice-seeds requires an explicit absolute artifact path');
    options.forbiddenDiceStreams = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (parsed.values.has('initial-model')) {
    const prior = JSON.parse(fs.readFileSync(path.resolve(parsed.values.get('initial-model')), 'utf8'));
    // Resume provenance must not be discarded: use fresh runs until explicit
    // merged training manifests are supported.
    if ([SCHEMA, CUMULATIVE_SCHEMA].includes(prior.schema)) throw new Error('Use --resume to retain cumulative seed provenance');
    options.initialModel = prior;
  }
  return { options: trainingOptions({ ...(options.resumeArtifact?.experienceReplay && !Object.hasOwn(options, 'replayGames')
    ? { replayGames: options.resumeArtifact.experienceReplay.gamesCapacity,
      replaySamples: options.resumeArtifact.experienceReplay.replaySamplesPerEpisode, lambda: 1 } : {}), ...options }),
    suppliedOptions: options, output: parsed.values.get('output') || '' };
}
function main(argv = process.argv.slice(2)) {
  const parsed = cliOptions(argv);
  if (parsed.help) {
    console.log('Offline long neural training: --games 64 --seed 236049 --opponents self,random,pip,greedy --output /absolute/existing-directory/candidate.json [--resume /absolute/prior.json --lambda 1 --sample-order seeded-shuffle --learn-colors both --replay-games 32 --replay-samples 64 --checkpoint-every 16 --forbidden-dice-seeds /absolute/reserved.json]');
    return;
  }
  if (!parsed.output || !path.isAbsolute(parsed.output)) throw new Error('--output requires an explicit absolute artifact path');
  if (parsed.options.resumeArtifact && parsed.options.initialModel) throw new Error('--resume and --initial-model are mutually exclusive');
  const artifact = runTraining(parsed.suppliedOptions || parsed.options, {
    onCheckpoint(checkpoint) { writeJsonAtomic(parsed.output, checkpoint); },
    onProgress(progress) {
      if (progress.completedGames % 16 === 0 || progress.completedGames === progress.requestedGames) {
        console.error(JSON.stringify({ event: 'terminal-training-progress', ...progress }));
      }
    },
  });
  writeJsonAtomic(parsed.output, artifact);
  console.log(JSON.stringify({ schema: artifact.schema, mode: artifact.mode, games: artifact.trainingManifest.games,
    samples: artifact.trainingManifest.samples, modelFingerprint: artifact.modelFingerprint,
    completedGames: artifact.trainingStatus.completedGames, requestedGames: artifact.trainingStatus.requestedGames,
    complete: artifact.trainingStatus.complete, productionEligible: false, output: parsed.output }));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || String(error)); process.exitCode = 2; }
}
module.exports = { ROOT, SCHEMA, CUMULATIVE_SCHEMA, OPPONENTS, TRAIN_DOMAIN, EVALUATION_DOMAIN,
  SAMPLE_ORDER_DOMAIN, REPLAY_DOMAIN, REPLAY_SCHEMA, REPLAY_MAX_GAME_SAMPLES,
  HARNESS_FINGERPRINT, SEED_HELPER_FINGERPRINT, NEURAL_CODE_FINGERPRINT, neuralApi, clone, canonical, fingerprint,
  modelFingerprint, loadLongGame, integer, ratio, seededRandom, streamSeeds, assertDisjointStreams,
  applyPlan, baselineScore, createBaseline, playEpisode, tdTargets, orderSamples, trainingOptions, runTraining,
  compactReplayState, createExperienceGame, selectReplaySamples, buildReplayArtifact,
  validateTrainingProvenance, writeJsonAtomic, cliOptions, main };
