const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

require("./build-short-bot-engine")();

const ROOT = path.join(__dirname, "..");
const context = { console, Date, Math, setTimeout, clearTimeout };
context.window = context;
context.globalThis = context;
vm.createContext(context);
for (const file of ["game.js", "short-bot-engine.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
}

const game = context.NarduGame;
const analytical = context.NarduShortBotEngine;
const games = Math.max(1, Number(process.env.SHORT_BOT_GAMES) || 5);
const seed = Number(process.env.SHORT_BOT_SEED) || 20260730;

function randomFactory(initialSeed) {
  let value = initialSeed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function roll(random) {
  const first = 1 + Math.floor(random() * 6);
  const second = 1 + Math.floor(random() * 6);
  return first === second ? [first, first, first, first] : [first, second];
}

function play(index) {
  const random = randomFactory(seed + index * 7919);
  const state = game.initialState("short");
  state.turn = index % 2 ? "dark" : "white";
  state.phase = "roll";
  const analyticalColor = index % 2 ? "white" : "dark";
  let turns = 0;
  let analyticalThinkMs = 0;

  while (!state.winner && turns < 500) {
    const color = state.turn;
    const dice = roll(random);
    state.phase = "move";
    state.dice = [...dice];
    state.rolled = [...dice];
    state.turnMoves = [];
    let sequence;
    if (color === analyticalColor) {
      const started = Date.now();
      sequence = analytical.plan(state, {
        maxCandidates: 32,
        analyzeCandidates: 4,
        replyLimit: 8,
      });
      analyticalThinkMs += Date.now() - started;
    } else {
      sequence = game.chooseBotSequence(state, color, { difficulty: "hard" }) || [];
    }
    sequence.forEach(move => game.applyMove(state, move.from, move.die, { autoEnd: false }));
    if (!state.winner) game.endTurn(state);
    turns += 1;
  }

  return {
    game: index + 1,
    analyticalColor,
    winner: state.winner || "timeout",
    analyticalWon: state.winner === analyticalColor,
    resultType: state.resultType || "normal",
    turns,
    analyticalThinkMs,
    off: { ...state.off },
  };
}

const results = Array.from({ length: games }, (_, index) => play(index));
const wins = results.filter(result => result.analyticalWon).length;
console.table(results);
console.log(JSON.stringify({
  engine: analytical.version,
  opponent: "legacy-short-hard",
  games,
  wins,
  winRate: wins / games,
  averageTurns: Math.round(results.reduce((sum, item) => sum + item.turns, 0) / games),
  averageThinkMs: Math.round(results.reduce((sum, item) => sum + item.analyticalThinkMs, 0) / games),
}, null, 2));

