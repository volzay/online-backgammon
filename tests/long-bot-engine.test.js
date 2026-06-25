const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
let cachedBrowserEngine = null;

function loadBrowserEngine() {
  if (cachedBrowserEngine) return cachedBrowserEngine;
  require("../scripts/build-long-bot-engine")();
  const context = {
    window: {},
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), context, { filename: "game.js" });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "long-bot-engine.js"), "utf8"), context, { filename: "long-bot-engine.js" });
  cachedBrowserEngine = {
    game: context.window.NarduGame,
    engine: context.window.NarduLongBotEngine,
  };
  return cachedBrowserEngine;
}

function longState(points, overrides = {}) {
  return {
    variant: "long",
    phase: "move",
    turn: "dark",
    dice: [2, 3],
    rolled: [2, 3],
    points,
    off: { white: 0, dark: 0 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [],
    history: [],
    headPlayedThisTurn: { white: false, dark: false },
    firstMoveDone: { white: true, dark: true },
    ...overrides,
  };
}

test("hard long engine is installed in browser bundle", () => {
  const { engine } = loadBrowserEngine();
  assert.equal(typeof engine.plan, "function");
  assert.equal(typeof engine.rank, "function");
  assert.equal(typeof engine.evaluateState, "function");
});

test("endgame plan prioritizes bearing off instead of shuffling home points", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    13: { color: "dark", count: 4 },
    14: { color: "dark", count: 3 },
    15: { color: "dark", count: 2 },
    16: { color: "dark", count: 2 },
    17: { color: "dark", count: 2 },
    18: { color: "dark", count: 2 },
  });

  const legal = game.bestMoveSequences(state, "dark").filter(sequence => sequence.length);
  const maxOff = Math.max(...legal.map(sequence => {
    const next = JSON.parse(JSON.stringify(state));
    sequence.forEach(move => game.applyMove(next, move.from, move.die, { autoEnd: false }));
    return next.off.dark;
  }));
  const plan = engine.plan(state);
  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));

  assert.equal(after.off.dark, maxOff);
});

test("evaluation rewards head support and penalizes trapped checkers", () => {
  const { engine } = loadBrowserEngine();
  const supported = longState({
    12: { color: "dark", count: 8 },
    11: { color: "dark", count: 2 },
    9: { color: "dark", count: 2 },
    7: { color: "dark", count: 2 },
    6: { color: "dark", count: 1 },
    24: { color: "white", count: 15 },
  });
  const trapped = longState({
    12: { color: "dark", count: 8 },
    11: { color: "white", count: 2 },
    10: { color: "white", count: 2 },
    9: { color: "white", count: 2 },
    8: { color: "white", count: 2 },
    7: { color: "white", count: 2 },
    6: { color: "white", count: 2 },
    5: { color: "dark", count: 7 },
  });

  assert.ok(engine.evaluateState(supported, "dark") > engine.evaluateState(trapped, "dark"));
});

test("evaluation prefers distributed checkers over home towers before the race", () => {
  const { engine } = loadBrowserEngine();
  const balanced = longState({
    12: { color: "dark", count: 5 },
    11: { color: "dark", count: 2 },
    9: { color: "dark", count: 2 },
    7: { color: "dark", count: 2 },
    4: { color: "dark", count: 2 },
    2: { color: "dark", count: 2 },
    24: { color: "white", count: 15 },
  });
  const rushed = longState({
    12: { color: "dark", count: 9 },
    17: { color: "dark", count: 1 },
    16: { color: "dark", count: 1 },
    15: { color: "dark", count: 4 },
    24: { color: "white", count: 15 },
  });

  assert.ok(engine.evaluateState(balanced, "dark") > engine.evaluateState(rushed, "dark"));
});
