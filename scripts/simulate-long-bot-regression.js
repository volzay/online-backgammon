const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function numericArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function stringArg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

function ratioArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function loadRuntime(experienceFile) {
  const experience = experienceFile
    ? JSON.parse(fs.readFileSync(experienceFile, 'utf8'))
    : [];
  const patterns = Array.isArray(experience) ? experience : experience.patterns || [];
  const storage = new Map([
    ['narduh-long-bot-experience-v1', JSON.stringify(patterns)],
  ]);
  const context = {
    window: {
      localStorage: {
        getItem(key) { return storage.get(key) ?? null; },
        setItem(key, value) { storage.set(key, String(value)); },
      },
    },
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  for (const file of ['game.js', 'long-bot-engine.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  context.NarduGame = context.window.NarduGame;
  context.NarduLongBotEngine = context.window.NarduLongBotEngine;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'strong-bot.js'), 'utf8'), context, {
    filename: 'strong-bot.js',
  });
  return {
    game: context.window.NarduGame,
    engine: context.window.NarduLongBotEngine,
    hardBot: context.window.NarduStrongBot,
    experienceCount: patterns.length,
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

function applyPlan(game, state, plan) {
  for (const move of plan || []) {
    if (!game.applyMove(state, move.from, move.die, { autoEnd: false })) {
      throw new Error(`Illegal plan move ${move.from}/${move.die}`);
    }
    if (state.winner) break;
  }
}

function playGame(index, runtime, options) {
  const { game, engine, hardBot } = runtime;
  const random = xorshift32((options.seed + index * 0x9e3779b9) >>> 0);
  const botColor = index % 2 === 0 ? 'dark' : 'white';
  const state = game.initialState('long');
  let whiteDie = die(random);
  let darkDie = die(random);
  while (whiteDie === darkDie) {
    whiteDie = die(random);
    darkDie = die(random);
  }
  game.decideOpeningRoll(state, {
    id: 'white', name: 'White', color: 'white', die: whiteDie,
  }, {
    id: 'dark', name: 'Dark', color: 'dark', die: darkDie,
  });
  game.startOpeningTurn(state);

  let plies = 0;
  while (!state.winner && plies < options.maxPlies) {
    plies += 1;
    if (state.phase === 'roll') game.applyRoll(state, roll(random));
    const plan = state.turn === botColor
      ? hardBot.plan(state, {
        maxCandidates: options.botCandidates,
        analysisNodeBudget: options.botNodes,
      })
      : engine.plan(state, {
        maxCandidates: options.controlCandidates,
        analysisNodeBudget: options.controlNodes,
      });
    applyPlan(game, state, plan);
    if (!state.winner) game.endTurn(state);
  }
  if (!state.winner) throw new Error(`Game ${index + 1} exceeded ${options.maxPlies} plies`);
  return {
    game: index + 1,
    botColor,
    winner: state.winner,
    botWon: state.winner === botColor,
    resultType: state.resultType || 'normal',
    plies,
    off: { ...state.off },
  };
}

function main() {
  const options = {
    games: numericArg('games', 100),
    seed: numericArg('seed', 0x19a7b019),
    botNodes: numericArg('bot-nodes', 64),
    controlNodes: numericArg('control-nodes', 32),
    botCandidates: numericArg('bot-candidates', 24),
    controlCandidates: numericArg('control-candidates', 16),
    maxPlies: numericArg('max-plies', 320),
    minWinRate: ratioArg('min-win-rate', 0.4),
    maxSevereLossRate: ratioArg('max-severe-loss-rate', 0.1),
    output: stringArg('output'),
    experience: stringArg('experience'),
  };
  const runtime = loadRuntime(options.experience);
  const results = [];
  for (let index = 0; index < options.games; index += 1) {
    results.push(playGame(index, runtime, options));
    if ((index + 1) % 10 === 0 || index + 1 === options.games) {
      const wins = results.filter(result => result.botWon).length;
      console.log(`${index + 1}/${options.games}: bot ${wins}, control ${results.length - wins}`);
    }
  }
  const summary = {
    engineVersion: runtime.engine.version,
    experiencePatterns: runtime.experienceCount,
    games: results.length,
    botWins: results.filter(result => result.botWon).length,
    controlWins: results.filter(result => !result.botWon).length,
    severeBotLosses: results.filter(result => !result.botWon && result.resultType !== 'normal').length,
    averagePlies: results.reduce((sum, result) => sum + result.plies, 0) / results.length,
    options,
  };
  summary.winRate = summary.botWins / summary.games;
  summary.severeLossRate = summary.severeBotLosses / summary.games;
  summary.passed = summary.winRate >= options.minWinRate
    && summary.severeLossRate <= options.maxSevereLossRate;
  const payload = { summary, results };
  if (options.output) fs.writeFileSync(options.output, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(summary));
  if (!summary.passed) process.exitCode = 1;
}

main();
