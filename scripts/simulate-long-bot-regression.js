const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const UINT32_MAX = 0xffffffff;
const RUNTIME_FILES = ['game.js', 'long-bot-engine.js', 'strong-bot.js'];
const VALUE_OPTIONS = new Set([
  'games',
  'seed',
  'bot-nodes',
  'control-nodes',
  'bot-candidates',
  'control-candidates',
  'max-plies',
  'min-win-rate',
  'max-severe-loss-rate',
  'bot-profile',
  'control-profile',
  'output',
  'experience',
]);
const FLAG_OPTIONS = new Set(['trace', 'learn']);
const SUPPORTED_PROFILES = new Set(['v19', 'v25']);

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
  return {
    entries,
    fingerprint: fingerprintNamedBuffers(entries),
  };
}

function runtimeFingerprint(snapshot = readRuntimeSnapshot()) {
  return snapshot.fingerprint;
}

function fileFingerprint(file) {
  return fingerprintNamedBuffers([[path.basename(file), fs.readFileSync(file)]]);
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

function profileOption(parsed, name, fallback) {
  const value = stringOption(parsed, name, fallback).toLowerCase();
  if (!SUPPORTED_PROFILES.has(value)) {
    throw new Error(`--${name} must be one of: ${[...SUPPORTED_PROFILES].join(', ')}`);
  }
  return value;
}

function readExperienceSnapshot(experienceFile) {
  const bytes = experienceFile ? fs.readFileSync(experienceFile) : Buffer.from('[]', 'utf8');
  const experience = JSON.parse(bytes.toString('utf8'));
  const patterns = Array.isArray(experience) ? experience : experience?.patterns;
  if (!Array.isArray(patterns)) {
    throw new Error('Experience file must contain an array or an object with a patterns array');
  }
  return {
    patterns,
    fingerprint: fingerprintNamedBuffers([['experience.json', bytes]]),
  };
}

function loadRuntime(experienceFile, runtimeSnapshot = readRuntimeSnapshot()) {
  const experienceSnapshot = readExperienceSnapshot(experienceFile);
  const patterns = experienceSnapshot.patterns;
  const storage = new Map([
    ['narduh-long-bot-experience-v3', JSON.stringify(patterns)],
  ]);
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => {
    throw new Error('Unseeded Math.random() was used during deterministic simulation');
  };
  const context = {
    window: {
      localStorage: {
        getItem(key) { return storage.get(key) ?? null; },
        setItem(key, value) { storage.set(key, String(value)); },
      },
    },
    console,
    Date,
    Math: deterministicMath,
    setTimeout,
    clearTimeout,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  const runtimeFiles = new Map(runtimeSnapshot.entries);
  for (const file of ['game.js', 'long-bot-engine.js']) {
    vm.runInContext(runtimeFiles.get(file).toString('utf8'), context, { filename: file });
  }
  context.NarduGame = context.window.NarduGame;
  context.NarduLongBotEngine = context.window.NarduLongBotEngine;
  vm.runInContext(runtimeFiles.get('strong-bot.js').toString('utf8'), context, {
    filename: 'strong-bot.js',
  });
  context.window.NarduLongBotEngine.setExperience(patterns, 'simulator');
  return {
    game: context.window.NarduGame,
    engine: context.window.NarduLongBotEngine,
    hardBot: context.window.NarduStrongBot,
    experienceCount: patterns.length,
    experienceFingerprint: experienceSnapshot.fingerprint,
    runtimeFingerprint: runtimeSnapshot.fingerprint,
  };
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
    openingDie() {
      return die(random);
    },
    roll() {
      return roll(random);
    },
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
      .update('nardu-long-bot/dice-stream/v2\0')
      .update(String(seed))
      .update('\0')
      .update(String(pairIndex))
      .update('\0')
      .update(color)
      .update('\0')
      .update(String(counter))
      .digest();
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

function pairedDiceStreams(streamA, streamB) {
  return { white: streamA, dark: streamB };
}

function botColorForLeg(leg) {
  return leg === 0 ? 'white' : 'dark';
}

function createLegAssignment(seed, pairIndex, leg) {
  if (leg !== 0 && leg !== 1) throw new Error(`Invalid paired leg: ${leg}`);
  const seeds = diceStreamSeeds(seed, pairIndex);
  const streams = pairedDiceStreams(
    createDiceStream(seeds.white),
    createDiceStream(seeds.dark),
  );
  const botColor = botColorForLeg(leg);
  return {
    botColor,
    controlColor: botColor === 'white' ? 'dark' : 'white',
    seeds,
    streams,
  };
}

function applyPlan(game, state, plan) {
  for (const move of Array.isArray(plan) ? plan : []) {
    if (!game.applyMove(state, move.from, move.die, { autoEnd: false })) {
      throw new Error(`Illegal plan move ${move.from}/${move.die}`);
    }
    if (state.winner) break;
  }
  if (!state.winner && state.phase === 'move' && game.hasAnyMoves(state)) {
    throw new Error(
      `Bot returned an empty or incomplete plan for ${state.turn}; legal moves remain`,
    );
  }
}

function playGame(pairIndex, leg, runtime, options) {
  const { game, engine } = runtime;
  const {
    botColor,
    controlColor,
    seeds: streamSeeds,
    streams,
  } = createLegAssignment(options.seed, pairIndex, leg);
  const state = game.initialState('long');
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
  let botDoubles = 0;
  let controlDoubles = 0;
  let botRolls = 0;
  let controlRolls = 0;
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
      state.history.unshift({
        color: state.turn,
        roll: `${dice[0]}:${dice[1]}`,
        at: new Date().toISOString(),
      });
    }
    const actingColor = state.turn;
    const actingProfile = actingColor === botColor ? options.botProfile : options.controlProfile;
    const plan = actingColor === botColor
      ? engine.plan(state, {
        maxCandidates: options.botCandidates,
        analysisNodeBudget: options.botNodes,
        strategyProfile: options.botProfile,
      })
      : engine.plan(state, {
        maxCandidates: options.controlCandidates,
        analysisNodeBudget: options.controlNodes,
        strategyProfile: options.controlProfile,
      });
    const decision = engine.consumeLastDecision?.();
    if (actingColor === botColor && decision) {
      state.analysis ||= {};
      state.analysis.botMemory ||= { format: 2, decisions: [] };
      state.analysis.botMemory.decisions.push({ ...decision, actor: 'bot' });
    }
    if (options.trace) {
      decisions.push({
        ply: plies,
        color: actingColor,
        actor: actingColor === botColor ? 'bot' : 'control',
        profile: actingProfile,
        dice: [...(state.dice || [])],
        pips: {
          white: game.pipsFor(state, 'white'),
          dark: game.pipsFor(state, 'dark'),
        },
        off: { ...state.off },
        plan: plan.map(move => ({ ...move })),
        selected: decision?.selected || null,
      });
    }
    applyPlan(game, state, plan);
    if (!state.winner) game.endTurn(state);
  }
  if (!state.winner) {
    throw new Error(`Game ${pairIndex * 2 + leg + 1} exceeded ${options.maxPlies} plies`);
  }
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
    _state: state,
  };
}

function main() {
  const parsed = parseCliTokens(process.argv.slice(2));
  const games = positiveIntegerOption(parsed, 'games', 100);
  if (games < 2 || games % 2 !== 0) {
    throw new Error('--games must be an even number of at least 2 for paired simulation');
  }
  const experience = stringOption(parsed, 'experience');
  const runtimeSnapshot = readRuntimeSnapshot();
  const simulatorHarnessFingerprint = fileFingerprint(__filename);
  const runtime = loadRuntime(experience, runtimeSnapshot);
  const productionOptions = runtime.engine.productionOptions || {};
  const options = {
    games,
    seed: positiveIntegerOption(parsed, 'seed', 0x19a7b019, UINT32_MAX),
    botNodes: positiveIntegerOption(
      parsed,
      'bot-nodes',
      Number(productionOptions.analysisNodeBudget) || 480,
    ),
    controlNodes: positiveIntegerOption(parsed, 'control-nodes', 64),
    botCandidates: positiveIntegerOption(
      parsed,
      'bot-candidates',
      Number(productionOptions.maxCandidates) || 64,
    ),
    controlCandidates: positiveIntegerOption(parsed, 'control-candidates', 24),
    maxPlies: positiveIntegerOption(parsed, 'max-plies', 320),
    minWinRate: ratioOption(parsed, 'min-win-rate', 0.7),
    maxSevereLossRate: ratioOption(parsed, 'max-severe-loss-rate', 0.1),
    botProfile: profileOption(parsed, 'bot-profile', productionOptions.strategyProfile || 'v25'),
    controlProfile: profileOption(parsed, 'control-profile', 'v19'),
    output: stringOption(parsed, 'output'),
    experience,
    trace: parsed.flags.has('trace'),
    learn: parsed.flags.has('learn'),
  };
  validateDerivedStreamSeeds([options.seed], options.games / 2);
  const results = [];
  const pairCount = Math.ceil(options.games / 2);
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    const pairResults = [];
    for (let leg = 0; leg < 2 && results.length < options.games; leg += 1) {
      const result = playGame(pairIndex, leg, runtime, options);
      pairResults.push(result);
      results.push(result);
    }
    if (options.learn) {
      pairResults.forEach(result => {
        runtime.hardBot.learnFromGame(result._state, result.botColor);
      });
    }
    if (results.length % 10 === 0 || results.length === options.games) {
      const wins = results.filter(result => result.botWon).length;
      console.log(`${results.length}/${options.games}: bot ${wins}, control ${results.length - wins}`);
    }
  }
  const completePairs = Array.from({ length: Math.floor(results.length / 2) }, (_, index) => (
    results.filter(result => result.pair === index + 1)
  ));
  const summary = {
    engineVersion: runtime.engine.version,
    runtimeFingerprint: runtime.runtimeFingerprint,
    simulatorHarnessFingerprint,
    experienceFingerprint: runtime.experienceFingerprint,
    experiencePatterns: runtime.experienceCount,
    games: results.length,
    botWins: results.filter(result => result.botWon).length,
    controlWins: results.filter(result => !result.botWon).length,
    severeBotLosses: results.filter(result => !result.botWon && result.resultType !== 'normal').length,
    botRolls: results.reduce((sum, result) => sum + result.botRolls, 0),
    controlRolls: results.reduce((sum, result) => sum + result.controlRolls, 0),
    botDoubles: results.reduce((sum, result) => sum + result.botDoubles, 0),
    controlDoubles: results.reduce((sum, result) => sum + result.controlDoubles, 0),
    pairSweeps: completePairs.filter(pair => pair.every(result => result.botWon)).length,
    pairSplits: completePairs.filter(pair => pair.filter(result => result.botWon).length === 1).length,
    pairLosses: completePairs.filter(pair => pair.every(result => !result.botWon)).length,
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
  const payload = { summary, results };
  results.forEach(result => { delete result._state; });
  if (options.output) fs.writeFileSync(options.output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(summary));
  if (!summary.passed) process.exitCode = 1;
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
  botColorForLeg,
  createDiceStream,
  createLegAssignment,
  deriveStreamSeed,
  diceStreamSeeds,
  fileFingerprint,
  fingerprintNamedBuffers,
  loadRuntime,
  parseCliTokens,
  pairedDiceStreams,
  playGame,
  readRuntimeSnapshot,
  runtimeFingerprint,
  validateDerivedStreamSeeds,
};
