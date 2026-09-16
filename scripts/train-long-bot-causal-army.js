#!/usr/bin/env node
'use strict';

/**
 * Frozen, cold self-play TRAINING data. This is not an A/B league and cannot
 * certify a win-rate target. Only complete exact ledgers from terminal losses
 * are offered to the separate trusted causal reviewer; no pattern is learned
 * or applied by this generator.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createLegAssignment,
  fingerprintNamedBuffers,
  loadRuntime,
  parseCliTokens,
  readRuntimeSnapshot,
  validateDerivedStreamSeeds,
} = require('./simulate-long-bot-regression');
const {
  afterPositionKey,
  canonicalMoveKey,
  canonicalMoves,
  compactAfter,
  stableStringify,
} = require('./generate-long-bot-shadow-replay');
const causalWorker = require('./long-bot-causal-worker');
const CAPTURED_GENERATOR_BYTES = fs.readFileSync(__filename);

const ROOT = path.join(__dirname, '..');
const SCHEMA = 'long-causal-army-training-v1';
const ENGINE_VERSION = 'long-analytic-v35';
const POLICY_DISPATCH = 'production-hardbot-stable9';
const PRODUCTION_WEIGHTS = Object.freeze({ ...causalWorker.PRODUCTION_POLICY.weights });
const DEFAULT_OPTIONS = Object.freeze({
  pairs: 1, seed: 0x35ca01, seedCount: 2, opponentProfiles: Object.freeze(['v19', 'v25']),
  nodes: 480, candidates: 64, maxPlies: 320, gameMs: 600000, workers: 4,
  reviewGames: 1, reviewDecisions: 160, reviewWorkDecisions: 2, reviewSelection: 'last', reviewSamples: 32,
  reviewPositions: 24, reviewMaxPlies: 320, reviewMs: 300000,
  runtimeDirectory: ROOT, output: '',
});
const VALUE_OPTIONS = new Set([
  'pairs', 'seed', 'seed-count', 'opponent-profiles', 'nodes', 'candidates',
  'max-plies', 'game-ms', 'workers', 'review-games', 'review-decisions', 'review-work-decisions', 'review-selection', 'review-samples',
  'review-positions', 'review-max-plies', 'review-ms', 'runtime-dir', 'output',
]);
const FLAG_OPTIONS = new Set(['help']);
const MAX_GAMES = 128;
const WORKER_MEMORY_MB = 256;
const REVIEW_PREFLIGHT_GRACE_MS = 15000;
const REVIEW_REPLAY_BUDGET_MS = causalWorker.DEFAULT_LIMITS.maxElapsedMs;
const OPTION_BOUNDS = Object.freeze({ pairs: [1, 32], seed: [1, 0xffffffff], seedCount: [1, 8],
  nodes: [1, 1150], candidates: [1, 128], maxPlies: [1, 600], gameMs: [1, 3600000], workers: [1, 8],
  reviewGames: [0, 8], reviewDecisions: [1, 160], reviewWorkDecisions: [1, 8], reviewSamples: [32, 128],
  reviewPositions: [2, 24], reviewMaxPlies: [1, 600], reviewMs: [1, 300000] });

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function reviewHardTimeoutMs(reviewMs) {
  if (!Number.isSafeInteger(reviewMs) || reviewMs < 1 || reviewMs > 300000) {
    throw new Error('reviewMs must be a native integer from 1 to 300000');
  }
  // The rollout deadline starts after legal replay and cold action selection.
  // Their allowance must not be taken out of the promised rollout budget.
  return reviewMs + REVIEW_REPLAY_BUDGET_MS + REVIEW_PREFLIGHT_GRACE_MS;
}
function integer(parsed, name, fallback, minimum, maximum) {
  if (!parsed.values.has(name)) return fallback;
  const raw = parsed.values.get(name);
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function validateOptions(options) {
  for (const [name, [minimum, maximum]] of Object.entries(OPTION_BOUNDS)) {
    if (!Number.isSafeInteger(options?.[name]) || options[name] < minimum || options[name] > maximum) {
      throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
  }
  if (!Array.isArray(options.opponentProfiles) || !options.opponentProfiles.length
    || new Set(options.opponentProfiles).size !== options.opponentProfiles.length
    || options.opponentProfiles.some(profile => !['v19', 'v25'].includes(profile))) {
    throw new Error('opponentProfiles must contain unique v19/v25 profiles');
  }
  if (!['last', 'strategic-risk'].includes(options.reviewSelection)) {
    throw new Error('reviewSelection must be last or strategic-risk');
  }
  if (options.pairs * options.seedCount * options.opponentProfiles.length * 2 > MAX_GAMES) {
    throw new Error(`requested training run exceeds the ${MAX_GAMES}-game cap`);
  }
  return options;
}

function parseOptions(argv) {
  const parsed = parseCliTokens(argv, VALUE_OPTIONS, FLAG_OPTIONS);
  const opponentProfiles = (parsed.values.get('opponent-profiles') || DEFAULT_OPTIONS.opponentProfiles.join(','))
    .split(',').map(value => value.trim().toLowerCase());
  if (!opponentProfiles.length || new Set(opponentProfiles).size !== opponentProfiles.length
    || opponentProfiles.some(value => !['v19', 'v25'].includes(value))) {
    throw new Error('--opponent-profiles must be a unique comma-separated subset of v19,v25');
  }
  const options = {
    pairs: integer(parsed, 'pairs', DEFAULT_OPTIONS.pairs, 1, 32),
    seed: integer(parsed, 'seed', DEFAULT_OPTIONS.seed, 1, 0xffffffff),
    seedCount: integer(parsed, 'seed-count', DEFAULT_OPTIONS.seedCount, 1, 8),
    opponentProfiles,
    nodes: integer(parsed, 'nodes', DEFAULT_OPTIONS.nodes, 1, 1150),
    candidates: integer(parsed, 'candidates', DEFAULT_OPTIONS.candidates, 1, 128),
    maxPlies: integer(parsed, 'max-plies', DEFAULT_OPTIONS.maxPlies, 1, 600),
    gameMs: integer(parsed, 'game-ms', DEFAULT_OPTIONS.gameMs, 1, 3600000),
    workers: integer(parsed, 'workers', DEFAULT_OPTIONS.workers, 1, 8),
    reviewGames: integer(parsed, 'review-games', DEFAULT_OPTIONS.reviewGames, 0, 8),
    reviewDecisions: integer(parsed, 'review-decisions', DEFAULT_OPTIONS.reviewDecisions, 1, 160),
    reviewWorkDecisions: integer(parsed, 'review-work-decisions', DEFAULT_OPTIONS.reviewWorkDecisions, 1, 8),
    reviewSelection: parsed.values.has('review-selection') ? parsed.values.get('review-selection') : DEFAULT_OPTIONS.reviewSelection,
    reviewSamples: integer(parsed, 'review-samples', DEFAULT_OPTIONS.reviewSamples, 32, 128),
    reviewPositions: integer(parsed, 'review-positions', DEFAULT_OPTIONS.reviewPositions, 2, 24),
    reviewMaxPlies: integer(parsed, 'review-max-plies', DEFAULT_OPTIONS.reviewMaxPlies, 1, 600),
    reviewMs: integer(parsed, 'review-ms', DEFAULT_OPTIONS.reviewMs, 1, 300000),
    runtimeDirectory: path.resolve(parsed.values.get('runtime-dir') || ROOT),
    output: parsed.values.get('output') || '',
    help: parsed.flags.has('help'),
  };
  if (options.pairs * options.seedCount * opponentProfiles.length * 2 > MAX_GAMES) {
    throw new Error(`requested training run exceeds the ${MAX_GAMES}-game cap`);
  }
  if (parsed.values.has('output') && !options.output.trim()) throw new Error('--output must not be empty');
  return validateOptions(options);
}

function derivedSeeds(seed, count) {
  const seeds = [seed];
  for (let index = 1; index < count; index += 1) {
    let counter = 0;
    let next;
    do {
      next = crypto.createHash('sha256').update(`nardu/causal-army/seeds/v1\0${seed}\0${index}\0${counter++}`)
        .digest().readUInt32BE(0);
    } while (!next || seeds.includes(next));
    seeds.push(next);
  }
  return seeds;
}

function deterministicUuid(value) {
  const bytes = Buffer.from(digest(value).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function orderedConcurrentMap(items, workers, mapper) {
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 8) throw new Error('workers must be from 1 to 8');
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      // Claim exactly once before awaiting: scheduling never changes assignment identity.
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, runWorker));
  return results;
}

function gameIdentity(runIdentity, seed, profile, pairIndex, leg) {
  const id = deterministicUuid(`${SCHEMA}\0${runIdentity}\0${seed}\0${profile}\0${pairIndex}\0${leg}`);
  return { id, roomCode: `TRAIN-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}` };
}

function freezeRuntime(snapshot, parentDirectory = os.tmpdir()) {
  const directory = fs.mkdtempSync(path.join(parentDirectory, 'long-causal-army-runtime-'));
  for (const [name, bytes] of snapshot.entries) {
    if (!['game.js', 'long-bot-engine.js', 'strong-bot.js'].includes(name)) throw new Error(`unexpected runtime file: ${name}`);
    fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx', mode: 0o444 });
  }
  return directory;
}

function freezeTrainingRuntime(snapshot, parentDirectory = os.tmpdir(), worker = causalWorker) {
  const directory = freezeRuntime(snapshot, parentDirectory);
  const runtimeOptions = { gamePath: path.join(directory, 'game.js'),
    runtimePath: path.join(directory, 'long-bot-engine.js') };
  // Read guarded captured bytes, not independently re-labelled live module files.
  const guarded = new Map(worker.runtimeClosureEntries(runtimeOptions));
  const dependencyNames = new Map(worker.EXECUTABLE_DEPENDENCIES.map(([name, file]) => [path.resolve(file), name]));
  const snapshotBytes = new Map(snapshot.entries);
  const files = new Map(snapshot.entries);
  for (const [targetPath, sourcePath] of worker.runtimeClosureFiles(runtimeOptions)) {
    if (path.isAbsolute(targetPath) || targetPath.split(path.sep).includes('..')) {
      throw new Error('executable closure must stay within preserved relative paths');
    }
    const semanticName = targetPath === 'game.js' ? 'game' : targetPath === 'long-bot-engine.js'
      ? 'engine-bundle' : dependencyNames.get(path.resolve(sourcePath));
    const captured = guarded.get(semanticName);
    if (!captured) throw new Error(`untracked executable closure file: ${targetPath}`);
    const bytes = snapshotBytes.get(targetPath) || captured;
    if (snapshotBytes.has(targetPath) && !bytes.equals(captured)) {
      throw new Error(`snapshot differs from captured executable closure: ${targetPath}`);
    }
    files.set(targetPath, bytes);
  }
  if (!fs.readFileSync(__filename).equals(CAPTURED_GENERATOR_BYTES)) {
    throw new Error('Training generator changed after load; restart the immutable generator');
  }
  files.set('scripts/train-long-bot-causal-army.js', CAPTURED_GENERATOR_BYTES);
  for (const [targetPath, bytes] of files) {
    const destination = path.join(directory, targetPath);
    if (fs.existsSync(destination)) {
      if (!fs.readFileSync(destination).equals(bytes)) throw new Error(`frozen file collision: ${targetPath}`);
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o444 });
  }
  return { directory, generatorPath: path.join(directory, 'scripts/train-long-bot-causal-army.js'),
    fingerprint: fingerprintNamedBuffers([...files].sort(([left], [right]) => left.localeCompare(right))),
    files: [...files].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, bytes]) => ({ name, digest: fingerprintNamedBuffers([[name, bytes]]) })) };
}

function freezeEmptyExperience(engine, sessionId) {
  engine.beginExperienceSession(sessionId);
  engine.setExperience([], 'causal-army-cold');
  engine.freezeExperience(sessionId);
  const snapshot = clone(engine.experienceReplaySnapshot());
  if (snapshot.engineVersion !== ENGINE_VERSION || snapshot.size !== 0
    || snapshot.frozen !== true || !Array.isArray(snapshot.patterns) || snapshot.patterns.length) {
    throw new Error('training policy must have canonical empty frozen experience');
  }
  return { ...snapshot, complete: true, patternCount: 0 };
}

function childJob(kind, payload, directory, timeoutMs, identity, generatorPath = __filename) {
  const configPath = path.join(directory, `${kind}-${identity}.input.json`);
  const outputPath = path.join(directory, `${kind}-${identity}.output.json`);
  fs.writeFileSync(configPath, JSON.stringify({ kind, payload, outputPath }), { flag: 'wx', mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${WORKER_MEMORY_MB}`, generatorPath, '--internal-job', configPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', bytes => { stderr = `${stderr}${bytes}`.slice(-1000); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut || code !== 0) {
        const error = new Error(timedOut ? `${kind}-hard-time-cap` : `${kind}-worker-failed: ${stderr}`);
        error.code = timedOut ? `${kind}-hard-time-cap` : `${kind}-worker-failed`;
        reject(error);
        return;
      }
      try { resolve(JSON.parse(fs.readFileSync(outputPath, 'utf8'))); } catch (error) { reject(error); }
    });
  });
}

function censoredGame(snapshot, options, assignment, reason) {
  const identity = gameIdentity(assignment.runIdentity, assignment.seed, assignment.profile, assignment.pairIndex, assignment.leg);
  const { botColor, controlColor, seeds: streamSeeds } = createLegAssignment(assignment.seed, assignment.pairIndex, assignment.leg);
  return { id: identity.id, room_code: identity.roomCode, engine_version: ENGINE_VERSION,
    difficulty: 'hard', variant: 'long', bot_color: botColor, winner: null, result_type: null,
    status: 'censored', censor_reason: reason, plies: null, passTurns: null,
    decisionLedgerUnavailable: true, decisions: [], turns: [],
    provenance: { schema: SCHEMA, trainingOnly: true, certification: false,
      runtimeFingerprint: snapshot.fingerprint, runIdentity: assignment.runIdentity,
      seed: assignment.seed, pair: assignment.pairIndex + 1, leg: assignment.leg + 1,
      streamSeeds, botPolicy: 'v25', opponentPolicy: assignment.profile, opponentColor: controlColor,
      policyDispatch: POLICY_DISPATCH, weights: clone(PRODUCTION_WEIGHTS),
      opponentEngineVersion: ENGINE_VERSION,
      frozenExperienceSize: 0, nodes: options.nodes, candidates: options.candidates,
      maxPlies: options.maxPlies, hardTimeCapMs: options.gameMs },
    final_state: { variant: 'long', analysis: { botMemory: { engineVersion: ENGINE_VERSION,
      coverage: { complete: false, expectedBotDecisions: null, recordedBotDecisions: 0, recoveredBotDecisions: 0 } } } } };
}

function exactExecute(game, state, plan, decision) {
  const beforeMoves = (state.turnMoves || []).length;
  for (const move of Array.isArray(plan) ? plan : []) {
    if (!game.applyMove(state, Number(move.from), Number(move.die), { autoEnd: false })) {
      throw new Error('policy-execution-illegal');
    }
    if (state.winner) break;
  }
  if (!state.winner && game.hasAnyMoves(state)) throw new Error('policy-execution-incomplete');
  const moves = clone(canonicalMoves((state.turnMoves || []).slice(beforeMoves)));
  const after = compactAfter(state);
  if (decision && (canonicalMoveKey(moves) !== canonicalMoveKey(decision.selected?.moves)
    || afterPositionKey(after) !== afterPositionKey(decision.selected))) {
    throw new Error('policy-execution-identity-mismatch');
  }
  return { moves, after };
}

function playTrainingGame(snapshot, options, assignment, dependencies = {}) {
  validateOptions(options);
  const runtimeFactory = dependencies.runtimeFactory || (() => loadRuntime(undefined, snapshot));
  const bot = runtimeFactory();
  const opponent = runtimeFactory();
  if (bot.engine === opponent.engine || bot.engine.version !== ENGINE_VERSION
    || opponent.engine.version !== ENGINE_VERSION) throw new Error('training policies require isolated v35 runtimes');
  if (typeof bot.hardBot?.plan !== 'function' || typeof opponent.hardBot?.plan !== 'function') {
    throw new Error('training policies require the production hard-bot dispatcher');
  }
  const identity = gameIdentity(assignment.runIdentity, assignment.seed, assignment.profile, assignment.pairIndex, assignment.leg);
  const replayExperience = freezeEmptyExperience(bot.engine, identity.id);
  freezeEmptyExperience(opponent.engine, `${identity.id}-opponent`);
  const { botColor, controlColor, seeds: streamSeeds, streams } = createLegAssignment(
    assignment.seed, assignment.pairIndex, assignment.leg,
  );
  const game = bot.game;
  const state = game.initialState('long');
  let whiteDie = streams.white.openingDie();
  let darkDie = streams.dark.openingDie();
  while (whiteDie === darkDie) { whiteDie = streams.white.openingDie(); darkDie = streams.dark.openingDie(); }
  game.decideOpeningRoll(state, { color: 'white', die: whiteDie }, { color: 'dark', die: darkDie });
  game.startOpeningTurn(state);
  const decisions = [];
  const turns = [];
  let expectedBotDecisions = 0;
  let passTurns = 0;
  let plies = 0;
  let failure = '';
  const startedAt = Date.now();
  while (!state.winner && plies < options.maxPlies) {
    if (Date.now() - startedAt > options.gameMs) { failure = 'game-time-cap'; break; }
    plies += 1;
    if (state.phase === 'roll') game.applyRoll(state, streams[state.turn].roll());
    if (state.phase !== 'move') { failure = 'game-phase-invalid'; break; }
    const color = state.turn;
    const isBot = color === botColor;
    const engine = isBot ? bot.engine : opponent.engine;
    const hardBot = isBot ? bot.hardBot : opponent.hardBot;
    const policy = { strategyProfile: isBot ? 'v25' : assignment.profile,
      maxCandidates: options.candidates, analysisNodeBudget: options.nodes };
    const hadMoves = game.hasAnyMoves(state);
    if (isBot && hadMoves) expectedBotDecisions += 1;
    const dice = [...state.dice];
    try {
      const plan = hardBot.plan(state, policy);
      const decision = engine.consumeLastDecision();
      const fallback = hardBot.consumeLastFallbackDecision?.();
      if (fallback) throw new Error('production-dispatch-fallback');
      if (hadMoves && (!decision || decision.source !== 'engine')) throw new Error('engine-decision-missing');
      if (hadMoves && stableStringify(decision.replayInput?.runtime) !== stableStringify({
        ...policy, weights: PRODUCTION_WEIGHTS,
      })) throw new Error('production-policy-provenance-mismatch');
      const executed = exactExecute(game, state, plan, hadMoves ? decision : null);
      if (!hadMoves) passTurns += 1;
      if (isBot && decision) {
        decision.id = deterministicUuid(`${identity.id}\0${plies}\0${decision.stateFingerprintV2}`);
        decision.at = new Date(plies * 1000).toISOString();
        decision.actor = 'bot';
        decision.ply = plies;
        decision.replayExperience = clone(replayExperience);
        decision.execution = {
          complete: true, fallback: false, substituted: false, selectedMatchesExecuted: true,
          executedMoves: executed.moves, after: executed.after,
          executedActionKey: String(decision.selected?.experience?.actionKey || ''),
          experience: clone(decision.selected?.experience || null),
          executed: { moves: executed.moves, after: executed.after,
            experience: clone(decision.selected?.experience || null) },
        };
        if (!causalWorker.exactExecution(decision).ok) throw new Error('exact-execution-validation-failed');
        if (decision.experienceFingerprint !== replayExperience.fingerprint
          || decision.experienceFrozen !== true || decision.selected?.experienceAdjustment !== 0) {
          throw new Error('cold-policy-provenance-mismatch');
        }
        decisions.push(clone(decision));
      }
      turns.push({ ply: plies, color, actor: isBot ? 'bot' : 'opponent', profile: policy.strategyProfile,
        policyDispatch: POLICY_DISPATCH, runtime: decision ? clone(decision.replayInput?.runtime || null) : null,
        dice, pass: !hadMoves, executedMoves: executed.moves, after: executed.after });
      if (!state.winner) game.endTurn(state);
    } catch (error) { failure = String(error?.message || error); break; }
  }
  if (!state.winner && !failure) failure = 'game-ply-cap';
  const complete = Boolean(state.winner) && !failure && expectedBotDecisions > 0
    && expectedBotDecisions === decisions.length;
  if (!complete && !failure) failure = 'training-ledger-incomplete';
  const coverage = { complete, expectedBotDecisions, recordedBotDecisions: decisions.length, recoveredBotDecisions: 0 };
  return {
    id: identity.id, room_code: identity.roomCode, engine_version: ENGINE_VERSION,
    difficulty: 'hard', variant: 'long', bot_color: botColor,
    winner: state.winner || null, result_type: state.resultType || null,
    status: complete ? 'completed' : 'censored', censor_reason: failure, plies, passTurns,
    decisions, turns,
    provenance: { schema: SCHEMA, trainingOnly: true, certification: false,
      runtimeFingerprint: snapshot.fingerprint, runIdentity: assignment.runIdentity,
      seed: assignment.seed, pair: assignment.pairIndex + 1, leg: assignment.leg + 1,
      streamSeeds, botPolicy: 'v25', opponentPolicy: assignment.profile,
      policyDispatch: POLICY_DISPATCH, weights: clone(PRODUCTION_WEIGHTS),
      opponentEngineVersion: ENGINE_VERSION, opponentColor: controlColor, frozenExperienceSize: 0,
      nodes: options.nodes, candidates: options.candidates, maxPlies: options.maxPlies },
    final_state: { variant: 'long', phase: state.phase, winner: state.winner || null,
      resultType: state.resultType || null, ...compactAfter(state),
      analysis: { botMemory: { engineVersion: ENGINE_VERSION, coverage, replayExperience } } },
  };
}

function nativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function archivedOutsideCount(game, decision) {
  const snapshot = decision?.stateSnapshotV2;
  const color = decision?.color;
  if (!['white', 'dark'].includes(color) || (game.bot_color || game.botColor) !== color
    || snapshot?.schema !== 'long-state-v2' || snapshot.variant !== 'long'
    || snapshot.phase !== 'move' || snapshot.turn !== color
    || !snapshot.points || typeof snapshot.points !== 'object' || Array.isArray(snapshot.points)
    || Object.keys(snapshot.points).length > 24 || !snapshot.off || !snapshot.bar) return null;
  const totals = { white: 0, dark: 0 };
  for (const side of ['white', 'dark']) {
    const off = snapshot.off[side];
    if (!Number.isSafeInteger(off) || off < 0 || off > 15 || snapshot.bar[side] !== 0) return null;
    totals[side] = off;
  }
  let outside = 0;
  for (const [key, stack] of Object.entries(snapshot.points)) {
    // JSON point keys require explicit canonical-key parsing, not count/value
    // coercion. This is structural telemetry, never an evaluator's label.
    if (!/^(?:[1-9]|1[0-9]|2[0-4])$/.test(key) || !stack || Array.isArray(stack)
      || !['white', 'dark'].includes(stack.color) || !Number.isSafeInteger(stack.count)
      || stack.count < 1 || stack.count > 15) return null;
    totals[stack.color] += stack.count;
    const point = Number(key);
    const inHome = color === 'white' ? point <= 6 : point >= 13 && point <= 18;
    if (stack.color === color && !inHome) outside += stack.count;
  }
  return totals.white === 15 && totals.dark === 15 ? outside : null;
}

function archivedStrategicRisk(game, decision) {
  const features = decision?.selected?.features;
  if ((game.engine_version || game.engineVersion) !== ENGINE_VERSION
    || decision?.engineVersion !== ENGINE_VERSION || decision?.source !== 'engine'
    || !features || typeof features !== 'object' || Array.isArray(features)) return { tier: 0, signals: [] };
  const choiceCount = decision.choiceCount;
  const multipleChoices = Number.isSafeInteger(choiceCount) && choiceCount > 1;
  const primeBefore = nativeFinite(features.primeRunBefore);
  const primeAfter = nativeFinite(features.primeRunAfter);
  if (multipleChoices && primeBefore !== null && primeAfter !== null
    && Number.isSafeInteger(primeBefore) && primeBefore >= 5 && primeBefore <= 15
    && Number.isSafeInteger(primeAfter) && primeAfter >= 0 && primeAfter < primeBefore) {
    // Multiple boards do not prove a prime-preserving move existed. This is
    // a review hint, including possibly forced loss, never an error label.
    return { tier: 4, signals: ['prime-loss-with-choice'] };
  }
  const primeScoreBefore = nativeFinite(features.primeScoreBefore);
  const blockBefore = nativeFinite(features.opponentMoveBlockBefore);
  const blockGain = nativeFinite(features.opponentMoveBlockGain);
  if (multipleChoices && primeBefore === 4
    && primeAfter !== null && Number.isSafeInteger(primeAfter) && primeAfter >= 0 && primeAfter < 4
    && primeScoreBefore !== null && primeScoreBefore > 0
    && blockBefore !== null && blockBefore > 0 && blockGain !== null && blockGain < 0) {
    // A four-point formation must have actual native blocking pressure and
    // lose that pressure, not merely be a cosmetic run. Still a review hint:
    // multiple choices do not prove a preserving or better action existed.
    return { tier: 4, signals: ['active-four-prime-loss-with-choice'] };
  }
  const structural = [
    ['headLandingBreak', 'head-support-break', value => value > 0],
    ['latentFenceExposureDelta', 'latent-fence-deterioration', value => value < 0],
    ['fenceClosureDelta', 'fence-deterioration', value => value < 0],
    ['escapeGatewayDelta', 'gateway-deterioration', value => value < 0],
  ].filter(([field, , worsens]) => {
    const value = nativeFinite(features[field]);
    return value !== null && worsens(value);
  }).map(([, signal]) => signal);
  if (structural.length) return { tier: 3, signals: structural };
  const shuffle = nativeFinite(features.homeShuffleMoves);
  const reduction = nativeFinite(features.outsideReduction);
  const outside = archivedOutsideCount(game, decision);
  if (shuffle !== null && Number.isSafeInteger(shuffle) && shuffle > 0 && shuffle <= 4
    && reduction !== null && Number.isSafeInteger(reduction) && reduction <= 0 && reduction >= -15
    && outside !== null && outside > 0) {
    return { tier: 2, signals: ['home-shuffle-with-outside-checkers'] };
  }
  const tactical = decision.selected.tactical;
  const missingAnalysis = tactical === null || tactical === undefined;
  const incompleteAnalysis = tactical && typeof tactical === 'object' && !Array.isArray(tactical)
    && (tactical.distributionComplete === undefined || tactical.distributionComplete === false
      || tactical.recoveryDistributionComplete === false || tactical.continuationCoverageComplete === false);
  if (multipleChoices && (missingAnalysis || incompleteAnalysis)) {
    return { tier: 1, signals: ['multiple-choice-analysis-diagnostic'] };
  }
  return { tier: 0, signals: [] };
}

function selectReviewDecisionIndexes(game, options) {
  const maximum = options.reviewWorkDecisions;
  const strategy = options.reviewSelection === undefined ? DEFAULT_OPTIONS.reviewSelection : options.reviewSelection;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8) throw new Error('reviewWorkDecisions must be 1..8');
  if (!['last', 'strategic-risk'].includes(strategy)) throw new Error('reviewSelection must be last or strategic-risk');
  const decisions = Array.isArray(game?.decisions) ? game.decisions : [];
  if (decisions.length > 320) throw new Error('review-selection-ledger-cap');
  const candidates = decisions.map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => causalWorker.botDecision(decision, game));
  if (strategy === 'last') return {
    strategy, ordering: 'reverse-original-bot-ledger', indexes: candidates.slice(-maximum).reverse().map(({ index }) => index),
    riskRole: 'curriculum-only', outcomeUsed: false, risks: [],
  };
  const selected = candidates.map(({ decision, index }) => ({ index, ...archivedStrategicRisk(game, decision) }))
    .sort((left, right) => right.tier - left.tier || right.index - left.index).slice(0, maximum);
  return { strategy, ordering: 'strategic-tier-then-reverse-original-bot-ledger',
    indexes: selected.map(({ index }) => index), riskRole: 'curriculum-only', outcomeUsed: false, risks: selected };
}

async function reviewTrainingGames(games, options, workerOptions, analyzer = causalWorker.analyzeTrainingGame) {
  const results = [];
  const skipped = [];
  let attempted = 0;
  for (const game of games) {
    let reason = '';
    const decisions = Array.isArray(game.decisions) ? game.decisions : [];
    const botDecisions = decisions.filter(decision => causalWorker.botDecision(decision, game)).length;
    if (game.status !== 'completed' || game.final_state?.analysis?.botMemory?.coverage?.complete !== true) reason = 'incomplete-game';
    else if (game.winner === game.bot_color) reason = 'not-loss-cohort';
    else if (decisions.length > 320) reason = 'review-total-ledger-cap';
    else if (botDecisions > options.reviewDecisions) reason = 'review-decision-cap';
    else if (attempted >= options.reviewGames) reason = 'review-game-cap';
    if (reason) { skipped.push({ gameId: game.id, reason }); continue; }
    attempted += 1;
    // Predetermined curriculum never sees future outcomes. Archived risk is
    // selection-only, not a label or weight; the full ledger is passed
    // to every child and validated by the worker before selecting its work.
    const reviewSelection = selectReviewDecisionIndexes(game, options);
    const indexes = reviewSelection.indexes;
    const aggregate = {
      schema: causalWorker.RESULT_SCHEMA, gameId: game.id, accepted: false, reason: '',
      runtimeDigest: workerOptions.runtimeDigest || '', outcomeUsed: false,
      reviewSelection,
      reviewCoverage: {
        schema: 'long-server-game-review-coverage-v1', fullGameEnvelopeValidated: false,
        decisionSnapshotsVerified: 'reviewed-only', scope: reviewSelection.strategy === 'last'
          ? 'trusted-offline-last-n' : 'trusted-offline-strategic-risk',
        ordering: reviewSelection.ordering, totalLedgerDecisions: decisions.length,
        totalBotDecisions: botDecisions, requestedDecisionIndexes: indexes,
        attemptedDecisionIndexes: [], finishedDecisionIndexes: [], failedDecisionIndexes: [],
        completedOutcomeCohorts: 0, selectionCoversWholeLedger: indexes.length === botDecisions,
        everyRequestedReviewFinished: false,
      },
      summary: { decisionsSeen: decisions.length, botDecisionsSeen: 0, confirmedRegret: 0,
        noRegret: 0, diagnosticDisagreement: 0, rejected: 0, evidenceCount: 0 },
      reviews: [], evidence: [], decisionResults: [],
    };
    for (const index of indexes) {
      aggregate.reviewCoverage.attemptedDecisionIndexes.push(index);
      aggregate.summary.botDecisionsSeen += 1;
      try {
        const result = await analyzer(game, { ...workerOptions, reviewDecisionIndexes: [index],
          limits: { maxDecisionsPerGame: options.reviewDecisions, maxTotalDecisionsPerGame: 320 } });
        aggregate.decisionResults.push({ index, result });
        if (result.accepted !== true) {
          const error = new Error(result.reason || 'trusted-game-envelope-rejected');
          error.code = result.reason || 'trusted-game-envelope-rejected';
          throw error;
        }
        const policyId = workerOptions.policyImplementationId || causalWorker.policyImplementationId(workerOptions);
        const coverage = result.reviewCoverage;
        const review = result.reviews?.[0];
        const completeCohort = review?.rollout?.coverage?.complete === true;
        if (result.schema !== causalWorker.RESULT_SCHEMA || result.trustDomain !== causalWorker.TRUST_DOMAIN
          || result.reviewerVersion !== causalWorker.WORKER_RELEASE || result.engineVersion !== ENGINE_VERSION
          || !Array.isArray(result.reviews) || !Array.isArray(result.evidence)
          || !/^[0-9a-f]{64}$/.test(policyId) || result.policyImplementationId !== policyId
          || !/^[0-9a-f]{64}$/.test(workerOptions.runtimeDigest || '') || result.runtimeDigest !== workerOptions.runtimeDigest
          || result.gameId !== game.id || result.outcomeUsed !== false
          || coverage?.schema !== 'long-server-game-review-coverage-v1'
          || coverage.scope !== 'trusted-offline-indexes' || coverage.fullGameEnvelopeValidated !== true
          || coverage.decisionSnapshotsVerified !== 'reviewed-only'
          || coverage.totalLedgerDecisions !== decisions.length || coverage.totalBotDecisions !== botDecisions
          || stableStringify(coverage.requestedDecisionIndexes) !== stableStringify([index])
          || stableStringify(coverage.attemptedDecisionIndexes) !== stableStringify([index])
          || stableStringify(coverage.finishedDecisionIndexes) !== stableStringify([index])
          || coverage.everyRequestedReviewFinished !== true || coverage.selectionCoversWholeLedger !== (botDecisions === 1)
          || coverage.completedOutcomeCohorts !== (completeCohort ? 1 : 0)
          || result.reviews?.length !== 1 || review.decisionId !== String(decisions[index].id || '')
          || review.outcomeUsed !== false
          || !['confirmed-regret', 'no-regret', 'diagnostic-disagreement', 'rejected'].includes(review.status)) {
          throw new Error('review-worker-scope-identity-mismatch');
        }
        let evidence = null;
        if (review.status === 'confirmed-regret') {
          evidence = result.evidence?.find(item => item.evidenceId === review.evidence?.evidenceId);
          if (!completeCohort || !evidence || evidence.schema !== causalWorker.EVIDENCE_SCHEMA
            || evidence.trustDomain !== causalWorker.TRUST_DOMAIN || evidence.reviewerVersion !== causalWorker.WORKER_RELEASE
            || evidence.engineVersion !== ENGINE_VERSION || evidence.policyImplementationId !== policyId
            || evidence.outcomeUsed !== false || evidence.trainingGameId !== game.id || evidence.decisionId !== review.decisionId
            || evidence.runtimeDigest !== result.runtimeDigest
            || stableStringify(evidence) !== stableStringify(review.evidence)) {
            throw new Error('review-worker-evidence-identity-mismatch');
          }
        }
        // Commit this child result atomically only after both scope and
        // evidence identities pass. A killed or malformed later child cannot
        // discard an earlier completed cohort or claim a false completion.
        aggregate.accepted = true;
        aggregate.reviewCoverage.fullGameEnvelopeValidated = true;
        aggregate.reviewCoverage.finishedDecisionIndexes.push(index);
        aggregate.reviews.push(review);
        if (completeCohort) aggregate.reviewCoverage.completedOutcomeCohorts += 1;
        if (evidence) aggregate.evidence.push(evidence);
      } catch (error) {
        aggregate.reviewCoverage.failedDecisionIndexes.push(index);
        if (!aggregate.reason) aggregate.reason = error?.code || String(error?.message || 'trusted-review-failed');
        aggregate.reviews.push({ decisionId: String(decisions[index].id || ''), status: 'rejected',
          reason: error?.code || String(error?.message || 'trusted-review-failed'), evidence: null, outcomeUsed: false });
      }
    }
    aggregate.reviewCoverage.everyRequestedReviewFinished = aggregate.reviewCoverage.finishedDecisionIndexes.length === indexes.length
      && aggregate.reviewCoverage.failedDecisionIndexes.length === 0;
    for (const review of aggregate.reviews) {
      if (review.status === 'confirmed-regret') aggregate.summary.confirmedRegret += 1;
      else if (review.status === 'no-regret') aggregate.summary.noRegret += 1;
      else if (review.status === 'diagnostic-disagreement') aggregate.summary.diagnosticDisagreement += 1;
      else aggregate.summary.rejected += 1;
    }
    aggregate.evidence = causalWorker.uniqueCausalEvidence(aggregate.evidence);
    aggregate.summary.evidenceCount = aggregate.evidence.length;
    results.push(aggregate);
  }
  return { attempted, results, skipped };
}

async function runTraining(options, dependencies = {}) {
  validateOptions(options);
  const snapshot = dependencies.snapshot || readRuntimeSnapshot(options.runtimeDirectory);
  if (loadRuntime(undefined, snapshot).engine.version !== ENGINE_VERSION) {
    throw new Error('causal army training requires a frozen long-analytic-v35 runtime');
  }
  const frozen = freezeTrainingRuntime(snapshot, dependencies.artifactDirectory || os.tmpdir());
  const frozenDirectory = frozen.directory;
  const worker = require(path.join(frozenDirectory, 'scripts/long-bot-causal-worker.js'));
  const workerOptions = {
    gamePath: path.join(frozenDirectory, 'game.js'), runtimePath: path.join(frozenDirectory, 'long-bot-engine.js'),
    // This is a server-owned offline API grant, never inferred from archived provenance.
    trustedTrainingPolicy: { strategyProfile: 'v25', maxCandidates: options.candidates,
      analysisNodeBudget: options.nodes, weights: clone(PRODUCTION_WEIGHTS) },
    rolloutLimits: { samples: options.reviewSamples, minSamples: 32,
      maxUniquePositions: options.reviewPositions, maxPlies: options.reviewMaxPlies,
      maxElapsedMs: options.reviewMs,
      policy: { strategyProfile: 'v25', maxCandidates: 24, analysisNodeBudget: 64 } },
  };
  // Validate the immutable closure and policy binding before spending resources on games.
  workerOptions.runtimeDigest = worker.runtimeDigest(workerOptions);
  const policyImplementationId = worker.policyImplementationId(workerOptions);
  workerOptions.policyImplementationId = policyImplementationId;
  const seeds = derivedSeeds(options.seed, options.seedCount);
  validateDerivedStreamSeeds(seeds, options.pairs);
  const identityOptions = { ...options };
  delete identityOptions.output;
  delete identityOptions.runtimeDirectory;
  delete identityOptions.help;
  // Concurrency is an execution cap, not a policy/seed input.
  delete identityOptions.workers;
  const runIdentity = digest(`${SCHEMA}\0${frozen.fingerprint}\0${workerOptions.runtimeDigest}\0${stableStringify(identityOptions)}`);
  const assignments = [];
  for (const seed of seeds) for (const profile of options.opponentProfiles) {
    for (let pairIndex = 0; pairIndex < options.pairs; pairIndex += 1) for (let leg = 0; leg < 2; leg += 1) {
      assignments.push({ seed, profile, pairIndex, leg, runIdentity });
    }
  }
  const effectiveWorkers = Math.min(options.workers, assignments.length);
  const games = await orderedConcurrentMap(assignments, effectiveWorkers, async (assignment, assignmentIndex) => {
    const identity = gameIdentity(runIdentity, assignment.seed, assignment.profile, assignment.pairIndex, assignment.leg);
    let result;
    if (dependencies.runtimeFactory) result = playTrainingGame(snapshot, options, assignment, dependencies);
    else {
      try {
        result = await childJob('game', { options: { ...options, runtimeDirectory: frozenDirectory }, assignment },
          frozenDirectory, options.gameMs, identity.id, frozen.generatorPath);
        if (result.id !== identity.id || result.engine_version !== ENGINE_VERSION
          || result.provenance?.runtimeFingerprint !== snapshot.fingerprint) throw new Error('game-worker-identity-mismatch');
      } catch (error) { result = censoredGame(snapshot, options, assignment, error?.code || String(error?.message || error)); }
    }
    dependencies.onGame?.(result, assignmentIndex);
    return result;
  });
  const reviewTimeoutMs = reviewHardTimeoutMs(options.reviewMs);
  const analyzer = dependencies.analyzeTrainingGame || ((game, reviewOptions) => childJob('review',
    { game, workerOptions: reviewOptions }, frozenDirectory, reviewTimeoutMs,
    `${game.id}-${reviewOptions.reviewDecisionIndexes[0]}`, frozen.generatorPath));
  const reviews = await reviewTrainingGames(games, options, workerOptions, analyzer);
  const evidence = worker.uniqueCausalEvidence(reviews.results.flatMap(result => result.accepted === true ? (result.evidence || []) : []));
  const completed = games.filter(game => game.status === 'completed');
  const pairKeys = [...new Set(games.map(game => `${game.provenance.seed}:${game.provenance.opponentPolicy}:${game.provenance.pair}`))];
  const completedPairs = pairKeys.filter(key => {
    const legs = games.filter(game => `${game.provenance.seed}:${game.provenance.opponentPolicy}:${game.provenance.pair}` === key);
    return legs.length === 2 && legs.every(game => game.status === 'completed');
  }).length;
  return {
    schema: SCHEMA, purpose: 'training-generation-only', certification: false, targetWinRateClaimed: false,
    runIdentity, engineVersion: ENGINE_VERSION, policyImplementationId, policyDispatch: POLICY_DISPATCH,
    weights: clone(PRODUCTION_WEIGHTS), seeds,
    options: { ...identityOptions, workers: options.workers },
    processLimits: { isolated: true, oldSpaceHeapMb: WORKER_MEMORY_MB,
      workers: effectiveWorkers, gameHardTimeoutMs: options.gameMs,
      reviewHardTimeoutMs: reviewTimeoutMs,
      reviewHardTimeoutScope: 'one-decision-cohort', reviewPreflightGraceMs: REVIEW_PREFLIGHT_GRACE_MS,
      reviewReplayBudgetMs: REVIEW_REPLAY_BUDGET_MS, reviewRolloutBudgetMs: options.reviewMs,
      maxReviewDecisionsPerGame: options.reviewWorkDecisions },
    frozenRuntime: { directory: frozenDirectory, fingerprint: snapshot.fingerprint,
      executableFingerprint: frozen.fingerprint,
      workerRuntimeDigest: workerOptions.runtimeDigest,
      files: frozen.files },
    summary: { requestedPairs: pairKeys.length, completedPairs, censoredPairs: pairKeys.length - completedPairs,
      requestedGames: games.length, completedGames: completed.length,
      censoredGames: games.length - completed.length,
      trainingDecisions: completed.reduce((sum, game) => sum + game.decisions.length, 0),
      recordedDecisions: games.reduce((sum, game) => sum + game.decisions.length, 0),
      completedWins: completed.filter(game => game.winner === game.bot_color).length,
      completedLosses: completed.filter(game => game.winner !== game.bot_color).length,
      reviewAttempts: reviews.attempted, acceptedReviews: reviews.results.filter(result => result.accepted === true).length,
      rejectedReviews: reviews.results.filter(result => result.accepted !== true).length,
      trainingEvidenceCount: evidence.length, evidenceApplied: 0,
      censorReasons: Object.fromEntries([...new Set(games.filter(game => game.status === 'censored').map(game => game.censor_reason))]
        .map(reason => [reason, games.filter(game => game.censor_reason === reason).length])) },
    games, reviews: reviews.results, skippedReviews: reviews.skipped, evidence,
  };
}

function helpText() {
  return 'Usage: train-long-bot-causal-army.js [--pairs N] [--seed N] [--seed-count N] [--opponent-profiles v19,v25]\n'
    + '  [--nodes N] [--candidates N] [--max-plies N] [--game-ms N] [--workers 1..8] [--runtime-dir DIR] [--output NEW.json]\n'
    + '  [--review-games 0..8] [--review-decisions 1..160 ledger cap] [--review-work-decisions 1..8 work cap]\n'
    + '  [--review-selection last|strategic-risk (default last)]\n'
    + '  [--review-samples 32..128]\n'
    + '  [--review-positions 2..24] [--review-max-plies N] [--review-ms N]\n'
    + 'The entire executable closure is frozen; games/reviews use isolated processes with a 256 MB old-space heap cap and hard timeouts.\n'
    + 'Training only; incomplete games/rollouts fail closed. No learning is applied and no 65% claim is made.\n';
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--internal-job') {
    if (argv.length !== 2) throw new Error('internal job requires exactly one config path');
    const { kind, payload, outputPath } = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
    let result;
    if (kind === 'game') {
      const snapshot = readRuntimeSnapshot(payload.options.runtimeDirectory);
      result = playTrainingGame(snapshot, payload.options, payload.assignment);
    } else if (kind === 'review') result = await causalWorker.analyzeTrainingGame(payload.game, payload.workerOptions);
    else throw new Error('unsupported internal job');
    fs.writeFileSync(outputPath, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
    return;
  }
  const options = parseOptions(argv);
  if (options.help) { process.stdout.write(helpText()); return; }
  if (options.output && fs.existsSync(path.resolve(options.output))) throw new Error('--output must name a new file');
  const report = await runTraining(options, {
    onGame(game) { process.stderr.write(`${game.room_code} ${game.status} plies=${game.plies} ${game.censor_reason || game.winner}\n`); },
  });
  if (options.output) fs.writeFileSync(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ schema: report.schema, runIdentity: report.runIdentity,
    certification: false, ...report.summary, frozenRuntime: report.frozenRuntime.directory })}\n`);
  if (report.summary.censoredGames) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});

module.exports = { DEFAULT_OPTIONS, ENGINE_VERSION, MAX_GAMES, POLICY_DISPATCH, PRODUCTION_WEIGHTS, REVIEW_PREFLIGHT_GRACE_MS, REVIEW_REPLAY_BUDGET_MS, reviewHardTimeoutMs, SCHEMA, derivedSeeds,
  archivedOutsideCount, archivedStrategicRisk, selectReviewDecisionIndexes,
  censoredGame, childJob, deterministicUuid, exactExecute, freezeEmptyExperience, freezeRuntime, freezeTrainingRuntime, gameIdentity,
  helpText, main, orderedConcurrentMap, parseOptions, playTrainingGame, reviewTrainingGames, runTraining };
