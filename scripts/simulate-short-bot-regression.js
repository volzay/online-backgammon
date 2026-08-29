const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const UINT32_MAX = 0xffffffff;
const RUNTIME_FILES = ['game.js', 'short-bot-engine.js'];
const VALUE_OPTIONS = new Set([
  'games', 'seed', 'bot-candidates', 'bot-analyze', 'bot-reply-limit',
  'max-plies', 'min-win-rate', 'max-severe-loss-rate', 'output',
]);
const FLAG_OPTIONS = new Set(['trace']);

function fingerprintNamedBuffers(entries) {
  const hash = createHash('sha256');
  for (const [name, bytes] of entries) {
    hash.update(name);
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function readRuntimeSnapshot(root = ROOT) {
  const entries = RUNTIME_FILES.map(file => [file, fs.readFileSync(path.join(root, file))]);
  return { entries, fingerprint: fingerprintNamedBuffers(entries) };
}

function runtimeFingerprint(snapshot = readRuntimeSnapshot()) {
  return snapshot.fingerprint;
}

function fileFingerprint(file) {
  return fingerprintNamedBuffers([[path.basename(file), fs.readFileSync(file)]]);
}

function readHarnessSnapshot(file = __filename) {
  const bytes = fs.readFileSync(file);
  return {
    file: path.basename(file),
    bytes,
    fingerprint: fingerprintNamedBuffers([[path.basename(file), bytes]]),
  };
}

function writeJsonAtomic(file, payload) {
  const target = path.resolve(file);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function assertColdEmptyExperience(runtime, stage = 'runtime load') {
  if (typeof runtime?.engine?.experienceSize !== 'function') {
    throw new Error(`Deterministic simulator cannot verify empty experience at ${stage}`);
  }
  const experienceSize = Number(runtime.engine.experienceSize());
  if (!Number.isSafeInteger(experienceSize) || experienceSize !== 0) {
    throw new Error(
      `Deterministic simulator requires empty experience at ${stage}, received ${experienceSize}`,
    );
  }
  return experienceSize;
}

function parseCliTokens(argv, valueOptions = VALUE_OPTIONS, flagOptions = FLAG_OPTIONS) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith('--') || token.length === 2) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (flagOptions.has(name)) {
      if (flags.has(name)) throw new Error(`Duplicate option: --${name}`);
      flags.add(name);
      continue;
    }
    if (!valueOptions.has(name)) throw new Error(`Unknown option: --${name}`);
    if (values.has(name)) throw new Error(`Duplicate option: --${name}`);
    const raw = argv[index + 1];
    if (raw === undefined || String(raw).startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    values.set(name, String(raw));
    index += 1;
  }
  return { values, flags };
}

function positiveIntegerOption(parsed, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!parsed.values.has(name)) return fallback;
  const raw = parsed.values.get(name);
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`--${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`--${name} must be a positive integer not greater than ${maximum}`);
  }
  return value;
}

function ratioOption(parsed, name, fallback) {
  if (!parsed.values.has(name)) return fallback;
  const value = Number(parsed.values.get(name));
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--${name} must be a number from 0 to 1`);
  }
  return value;
}

function stringOption(parsed, name, fallback = '') {
  if (!parsed.values.has(name)) return fallback;
  const value = parsed.values.get(name).trim();
  if (!value) throw new Error(`--${name} must not be empty`);
  return value;
}

function loadRuntime(runtimeSnapshot = readRuntimeSnapshot()) {
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => {
    throw new Error('Unseeded Math.random() was used during deterministic simulation');
  };
  const context = { window: {}, console, Date, Math: deterministicMath, setTimeout, clearTimeout };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  const runtimeFiles = new Map(runtimeSnapshot.entries);
  vm.runInContext(runtimeFiles.get('game.js').toString('utf8'), context, { filename: 'game.js' });
  context.NarduGame = context.window.NarduGame;
  vm.runInContext(runtimeFiles.get('short-bot-engine.js').toString('utf8'), context, {
    filename: 'short-bot-engine.js',
  });
  const engine = context.window.NarduShortBotEngine;
  const runtime = {
    game: context.window.NarduGame,
    engine,
    runtimeFingerprint: runtimeSnapshot.fingerprint,
    experience: {
      mode: 'cold-empty',
      patternCount: 0,
      fingerprint: fingerprintNamedBuffers([['experience.json', Buffer.from('[]')]]),
    },
  };
  assertColdEmptyExperience(runtime);
  return runtime;
}

function xorshift32(seed) {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x100000000;
  };
}

function die(random) {
  return 1 + Math.floor(random() * 6);
}

function roll(random) {
  const first = die(random);
  const second = die(random);
  return first === second ? [first, first, first, first] : [first, second];
}

function createDiceStream(seed) {
  if (!Number.isInteger(seed) || seed <= 0 || seed > UINT32_MAX) {
    throw new Error('Dice stream seed must be a non-zero 32-bit integer');
  }
  const random = xorshift32(seed);
  return {
    openingDie() { return die(random); },
    roll() { return roll(random); },
  };
}

function deriveStreamSeed(seed, pairIndex, color) {
  if (!Number.isInteger(seed) || seed <= 0 || seed > UINT32_MAX) {
    throw new Error('Base seed must be a positive 32-bit integer');
  }
  if (!Number.isSafeInteger(pairIndex) || pairIndex < 0) {
    throw new Error('Pair index must be a non-negative safe integer');
  }
  if (color !== 'white' && color !== 'dark') throw new Error(`Invalid stream color: ${color}`);
  for (let counter = 0; counter <= UINT32_MAX; counter += 1) {
    const digest = createHash('sha256')
      .update('nardu-short-bot/dice-stream/v1\0')
      .update(String(seed)).update('\0')
      .update(String(pairIndex)).update('\0')
      .update(color).update('\0')
      .update(String(counter)).digest();
    const derived = digest.readUInt32BE(0);
    if (derived !== 0) return derived;
  }
  throw new Error('Unable to derive a non-zero dice stream seed');
}

function diceStreamSeeds(seed, pairIndex) {
  return {
    white: deriveStreamSeed(seed, pairIndex, 'white'),
    dark: deriveStreamSeed(seed, pairIndex, 'dark'),
  };
}

function validateDerivedStreamSeeds(seeds, pairsPerSeed) {
  if (!Number.isSafeInteger(pairsPerSeed) || pairsPerSeed < 1) {
    throw new Error('pairsPerSeed must be a positive safe integer');
  }
  const seen = new Map();
  for (const seed of seeds) {
    for (let pairIndex = 0; pairIndex < pairsPerSeed; pairIndex += 1) {
      const derived = diceStreamSeeds(seed, pairIndex);
      for (const color of ['white', 'dark']) {
        const value = derived[color];
        const description = `seed ${seed}, pair ${pairIndex + 1}, ${color}`;
        if (seen.has(value)) {
          throw new Error(`Derived dice stream collision: ${description} matches ${seen.get(value)}`);
        }
        seen.set(value, description);
      }
    }
  }
  return seen.size;
}

function botColorForLeg(leg) {
  if (leg !== 0 && leg !== 1) throw new Error(`Invalid paired leg: ${leg}`);
  return leg === 0 ? 'white' : 'dark';
}

function createLegAssignment(seed, pairIndex, leg) {
  const streamSeeds = diceStreamSeeds(seed, pairIndex);
  const botColor = botColorForLeg(leg);
  return {
    botColor,
    controlColor: botColor === 'white' ? 'dark' : 'white',
    streamSeeds,
    streams: {
      white: createDiceStream(streamSeeds.white),
      dark: createDiceStream(streamSeeds.dark),
    },
  };
}

function applyPlan(game, state, plan, actor = 'Bot') {
  for (const move of Array.isArray(plan) ? plan : []) {
    if (!game.applyMove(state, move.from, move.die, { autoEnd: false })) {
      throw new Error(`${actor} returned illegal move ${move.from}/${move.die}`);
    }
    if (state.winner) break;
  }
  if (!state.winner && state.phase === 'move' && game.hasAnyMoves(state)) {
    throw new Error(`${actor} returned an empty or incomplete plan for ${state.turn}`);
  }
}

function playGame(pairIndex, leg, runtime, options) {
  const { game, engine } = runtime;
  const { botColor, controlColor, streamSeeds, streams } = createLegAssignment(
    options.seed, pairIndex, leg,
  );
  const state = game.initialState('short');
  let whiteDie = streams.white.openingDie();
  let darkDie = streams.dark.openingDie();
  while (whiteDie === darkDie) {
    whiteDie = streams.white.openingDie();
    darkDie = streams.dark.openingDie();
  }
  game.decideOpeningRoll(state, {
    id: 'white', name: 'White', color: 'white', die: whiteDie,
  }, {
    id: 'dark', name: 'Dark', color: 'dark', die: darkDie,
  });
  game.startOpeningTurn(state);

  let plies = 0;
  let botRolls = 0;
  let controlRolls = 0;
  let botDoubles = 0;
  let controlDoubles = 0;
  const decisions = [];
  while (!state.winner && plies < options.maxPlies) {
    plies += 1;
    if (state.phase === 'roll') {
      const dice = streams[state.turn].roll();
      if (state.turn === botColor) botRolls += 1;
      else controlRolls += 1;
      if (dice.length === 4) {
        if (state.turn === botColor) botDoubles += 1;
        else controlDoubles += 1;
      }
      game.applyRoll(state, dice);
    }
    const actingColor = state.turn;
    const botTurn = actingColor === botColor;
    const stateBeforePlanning = JSON.stringify(state);
    const planningState = JSON.parse(stateBeforePlanning);
    const plan = botTurn
      ? engine.plan(planningState, {
        maxCandidates: options.botCandidates,
        analyzeCandidates: options.botAnalyze,
        replyLimit: options.botReplyLimit,
      })
      : (game.chooseBotSequence(planningState, actingColor, { difficulty: 'hard' }) || []);
    if (JSON.stringify(state) !== stateBeforePlanning) {
      throw new Error(`${botTurn ? 'Analytical bot' : 'Control bot'} mutated authoritative state`);
    }
    const decision = botTurn ? engine.consumeLastDecision?.() : null;
    if (options.trace) {
      decisions.push({
        ply: plies,
        color: actingColor,
        actor: botTurn ? 'bot' : 'control',
        dice: [...(state.dice || [])],
        pips: { white: game.pipsFor(state, 'white'), dark: game.pipsFor(state, 'dark') },
        points: JSON.parse(JSON.stringify(state.points || {})),
        bar: { ...state.bar },
        off: { ...state.off },
        plan: plan.map(move => ({ ...move })),
        selected: decision?.selected || null,
        alternatives: decision?.alternatives || [],
      });
    }
    applyPlan(game, state, plan, botTurn ? 'Analytical bot' : 'Control bot');
    if (!state.winner) game.endTurn(state);
  }
  if (!state.winner) {
    throw new Error(`Game ${pairIndex * 2 + leg + 1} exceeded ${options.maxPlies} plies`);
  }
  assertColdEmptyExperience(runtime, `after game ${pairIndex * 2 + leg + 1}`);
  return {
    game: pairIndex * 2 + leg + 1,
    pair: pairIndex + 1,
    leg: leg + 1,
    botColor,
    controlColor,
    streamSeeds,
    winner: state.winner,
    botWon: state.winner === botColor,
    resultType: state.resultType || 'normal',
    plies,
    botRolls,
    controlRolls,
    botDoubles,
    controlDoubles,
    off: { ...state.off },
    ...(options.trace ? { decisions } : {}),
  };
}

function parseOptions(argv) {
  const parsed = parseCliTokens(argv);
  const games = positiveIntegerOption(parsed, 'games', 100);
  if (games < 2 || games % 2 !== 0) {
    throw new Error('--games must be an even number of at least 2 for paired simulation');
  }
  return {
    games,
    seed: positiveIntegerOption(parsed, 'seed', 0x1f39a7b1, UINT32_MAX),
    botCandidates: positiveIntegerOption(parsed, 'bot-candidates', 48),
    botAnalyze: positiveIntegerOption(parsed, 'bot-analyze', 6),
    botReplyLimit: positiveIntegerOption(parsed, 'bot-reply-limit', 12),
    maxPlies: positiveIntegerOption(parsed, 'max-plies', 500),
    minWinRate: ratioOption(parsed, 'min-win-rate', 0.67),
    maxSevereLossRate: ratioOption(parsed, 'max-severe-loss-rate', 0.1),
    output: stringOption(parsed, 'output'),
    trace: parsed.flags.has('trace'),
  };
}

function summarize(results, runtime, options, harnessSnapshot = readHarnessSnapshot()) {
  assertColdEmptyExperience(runtime, 'summary');
  validatePairedResults(results, options.games);
  const completePairs = Array.from({ length: results.length / 2 }, (_, index) => (
    results.filter(result => result.pair === index + 1)
  ));
  const summary = {
    engineVersion: runtime.engine.version,
    opponent: 'legacy-short-hard',
    runtimeFingerprint: runtime.runtimeFingerprint,
    simulatorHarnessFingerprint: harnessSnapshot.fingerprint,
    experience: { ...runtime.experience },
    games: results.length,
    pairs: completePairs.length,
    botWins: results.filter(result => result.botWon).length,
    controlWins: results.filter(result => !result.botWon).length,
    severeBotLosses: results.filter(result => !result.botWon && result.resultType !== 'normal').length,
    pairSweeps: completePairs.filter(pair => pair.every(result => result.botWon)).length,
    pairSplits: completePairs.filter(pair => pair.filter(result => result.botWon).length === 1).length,
    pairLosses: completePairs.filter(pair => pair.every(result => !result.botWon)).length,
    botRolls: results.reduce((sum, result) => sum + result.botRolls, 0),
    controlRolls: results.reduce((sum, result) => sum + result.controlRolls, 0),
    botDoubles: results.reduce((sum, result) => sum + result.botDoubles, 0),
    controlDoubles: results.reduce((sum, result) => sum + result.controlDoubles, 0),
    averagePlies: results.reduce((sum, result) => sum + result.plies, 0) / results.length,
    options,
  };
  summary.winRate = summary.botWins / summary.games;
  summary.severeLossRate = summary.severeBotLosses / summary.games;
  summary.botDoubleRate = summary.botRolls ? summary.botDoubles / summary.botRolls : 0;
  summary.controlDoubleRate = summary.controlRolls ? summary.controlDoubles / summary.controlRolls : 0;
  summary.doubleRateDifference = summary.botDoubleRate - summary.controlDoubleRate;
  summary.passed = summary.winRate >= options.minWinRate
    && summary.severeLossRate <= options.maxSevereLossRate;
  return summary;
}

function validatePairedResults(results, expectedGames) {
  if (!Array.isArray(results) || results.length !== expectedGames || expectedGames % 2 !== 0) {
    throw new Error(`Expected ${expectedGames} results forming complete pairs`);
  }
  for (let pairIndex = 0; pairIndex < expectedGames / 2; pairIndex += 1) {
    const pair = results
      .filter(result => result.pair === pairIndex + 1)
      .sort((left, right) => left.leg - right.leg);
    if (pair.length !== 2 || pair[0].leg !== 1 || pair[1].leg !== 2) {
      throw new Error(`Pair ${pairIndex + 1} must contain exactly legs 1 and 2`);
    }
    if (pair[0].botColor !== 'white' || pair[1].botColor !== 'dark') {
      throw new Error(`Pair ${pairIndex + 1} must swap the analytical bot color`);
    }
    if (pair[0].controlColor !== 'dark' || pair[1].controlColor !== 'white') {
      throw new Error(`Pair ${pairIndex + 1} must swap the control bot color`);
    }
    if (JSON.stringify(pair[0].streamSeeds) !== JSON.stringify(pair[1].streamSeeds)) {
      throw new Error(`Pair ${pairIndex + 1} must reuse identical physical dice streams`);
    }
  }
}

function runSimulation(
  options,
  runtimeSnapshot = readRuntimeSnapshot(),
  harnessSnapshot = readHarnessSnapshot(),
) {
  validateDerivedStreamSeeds([options.seed], options.games / 2);
  const summaryRuntime = loadRuntime(runtimeSnapshot);
  const results = [];
  for (let pairIndex = 0; pairIndex < options.games / 2; pairIndex += 1) {
    for (let leg = 0; leg < 2; leg += 1) {
      const runtime = loadRuntime(runtimeSnapshot);
      results.push(playGame(pairIndex, leg, runtime, options));
    }
    if (results.length % 10 === 0 || results.length === options.games) {
      const wins = results.filter(result => result.botWon).length;
      console.log(`${results.length}/${options.games}: bot ${wins}, control ${results.length - wins}`);
    }
  }
  return { summary: summarize(results, summaryRuntime, options, harnessSnapshot), results };
}

function main(argv = process.argv.slice(2)) {
  const harnessSnapshot = readHarnessSnapshot();
  const options = parseOptions(argv);
  require('./build-short-bot-engine')();
  const payload = runSimulation(options, readRuntimeSnapshot(), harnessSnapshot);
  if (options.output) writeJsonAtomic(options.output, payload);
  console.log(JSON.stringify(payload.summary));
  if (!payload.summary.passed) process.exitCode = 1;
  return payload;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 2;
  }
}

module.exports = {
  applyPlan,
  assertColdEmptyExperience,
  botColorForLeg,
  createDiceStream,
  createLegAssignment,
  deriveStreamSeed,
  diceStreamSeeds,
  fileFingerprint,
  fingerprintNamedBuffers,
  loadRuntime,
  main,
  parseCliTokens,
  parseOptions,
  playGame,
  readHarnessSnapshot,
  readRuntimeSnapshot,
  runSimulation,
  runtimeFingerprint,
  summarize,
  validatePairedResults,
  validateDerivedStreamSeeds,
  writeJsonAtomic,
};
