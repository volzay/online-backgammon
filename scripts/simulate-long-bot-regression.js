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

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
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

function createDiceStream(seed) {
  const random = xorshift32(seed >>> 0);
  return {
    openingDie() {
      return die(random);
    },
    roll() {
      return roll(random);
    },
  };
}

function applyPlan(game, state, plan) {
  for (const move of plan || []) {
    if (!game.applyMove(state, move.from, move.die, { autoEnd: false })) {
      throw new Error(`Illegal plan move ${move.from}/${move.die}`);
    }
    if (state.winner) break;
  }
}

function playGame(pairIndex, leg, runtime, options) {
  const { game, engine } = runtime;
  const streamA = createDiceStream((options.seed + pairIndex * 0x9e3779b9) >>> 0);
  const streamB = createDiceStream((options.seed ^ 0xa511e9b3 ^ pairIndex * 0x85ebca6b) >>> 0);
  const streams = leg === 0
    ? { white: streamA, dark: streamB }
    : { white: streamB, dark: streamA };
  const botColor = leg === 0 ? 'white' : 'dark';
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
  const decisions = [];
  while (!state.winner && plies < options.maxPlies) {
    plies += 1;
    if (state.phase === 'roll') {
      const dice = streams[state.turn].roll();
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
    winner: state.winner,
    botWon: state.winner === botColor,
    resultType: state.resultType || 'normal',
    plies,
    botDoubles,
    controlDoubles,
    off: { ...state.off },
    ...(options.trace ? { decisions } : {}),
    _state: state,
  };
}

function main() {
  const options = {
    games: numericArg('games', 100),
    seed: numericArg('seed', 0x19a7b019),
    botNodes: numericArg('bot-nodes', 64),
    controlNodes: numericArg('control-nodes', 64),
    botCandidates: numericArg('bot-candidates', 24),
    controlCandidates: numericArg('control-candidates', 24),
    maxPlies: numericArg('max-plies', 320),
    minWinRate: ratioArg('min-win-rate', 0.7),
    maxSevereLossRate: ratioArg('max-severe-loss-rate', 0.1),
    botProfile: stringArg('bot-profile', 'v20'),
    controlProfile: stringArg('control-profile', 'v19'),
    output: stringArg('output'),
    experience: stringArg('experience'),
    trace: hasFlag('trace'),
    learn: hasFlag('learn'),
  };
  const runtime = loadRuntime(options.experience);
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
    experiencePatterns: runtime.experienceCount,
    games: results.length,
    botWins: results.filter(result => result.botWon).length,
    controlWins: results.filter(result => !result.botWon).length,
    severeBotLosses: results.filter(result => !result.botWon && result.resultType !== 'normal').length,
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
  summary.passed = summary.winRate >= options.minWinRate
    && summary.severeLossRate <= options.maxSevereLossRate;
  const payload = { summary, results };
  results.forEach(result => { delete result._state; });
  if (options.output) fs.writeFileSync(options.output, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(summary));
  if (!summary.passed) process.exitCode = 1;
}

main();
