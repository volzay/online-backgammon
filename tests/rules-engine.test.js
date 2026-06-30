const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadGame() {
  const context = { window: {}, console, Date, Math, JSON };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), context, {
    filename: "game.js",
  });
  return context.window.NarduGame;
}

function checkerCount(state, color) {
  let total = 0;
  for (const stack of Object.values(state.points || {})) {
    if (stack?.color === color) total += Number(stack.count) || 0;
  }
  return total + (Number(state.off?.[color]) || 0) + (Number(state.bar?.[color]) || 0);
}

test("initial positions contain 15 checkers per side", () => {
  const game = loadGame();
  for (const variant of ["long", "short"]) {
    const state = game.initialState(variant);
    assert.equal(checkerCount(state, "white"), 15);
    assert.equal(checkerCount(state, "dark"), 15);
  }
});

test("legal play preserves checker totals", () => {
  const game = loadGame();
  for (const variant of ["long", "short"]) {
    const state = game.initialState(variant);
    state.turn = "white";
    state.phase = "move";
    state.firstMoveDone = { white: true, dark: true };
    for (let turn = 0; turn < 40 && !state.winner; turn += 1) {
      game.applyRoll(state, game.rollDice());
      let guard = 0;
      while (state.phase === "move" && state.dice.length && game.hasAnyMoves(state) && guard < 10) {
        guard += 1;
        const moves = game.legalNextMoves(state);
        if (!moves.length) break;
        const move = moves[(turn + guard) % moves.length];
        game.applyMove(state, move.from, move.die, { autoEnd: false });
        assert.equal(checkerCount(state, "white"), 15);
        assert.equal(checkerCount(state, "dark"), 15);
      }
      if (state.phase === "move") game.endTurn(state);
    }
  }
});

test("normal long turn releases at most one checker from the head", () => {
  const game = loadGame();
  const state = game.initialState("long");
  state.turn = "white";
  state.phase = "move";
  state.firstMoveDone = { white: true, dark: true };
  game.applyRoll(state, [3, 1]);
  const head = game.headPoint("white", state);
  const sequences = game.bestMoveSequences(state, "white");
  assert.ok(sequences.length > 0);
  for (const sequence of sequences) {
    assert.ok(sequence.filter(move => move.from === head).length <= 1);
  }
});

test("bearing off requires every checker to be in the home board", () => {
  const game = loadGame();
  const state = game.initialState("long");
  state.points = {
    6: { color: "white", count: 14 },
    10: { color: "white", count: 1 },
    12: { color: "dark", count: 15 },
  };
  state.off = { white: 0, dark: 0 };
  state.bar = { white: 0, dark: 0 };
  assert.equal(game.homeReady(state, "white"), false);
});

test("result type recognizes a special win against a zero-off loser", () => {
  const game = loadGame();
  const state = game.initialState("long");
  state.points = { 12: { color: "dark", count: 15 } };
  state.off = { white: 15, dark: 0 };
  state.winner = "white";
  assert.ok(["mars", "koks"].includes(game.resultTypeFor(state, "white")));
});
