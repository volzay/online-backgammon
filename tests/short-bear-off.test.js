const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadGame() {
  const context = { window: {}, console, Date, Math };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "game.js"), "utf8"),
    context,
    { filename: "game.js" },
  );
  return context.window.NarduGame;
}

test("7LNV-945H move 184 permits bearing off points 3 and 1 with 4:1", () => {
  const game = loadGame();
  const state = {
    variant: "short",
    phase: "move",
    turn: "white",
    dice: [1, 4],
    rolled: [1, 4],
    points: {
      1: { color: "white", count: 4 },
      2: { color: "white", count: 2 },
      3: { color: "white", count: 1 },
      19: { color: "dark", count: 1 },
      20: { color: "dark", count: 3 },
      21: { color: "dark", count: 3 },
      22: { color: "dark", count: 2 },
    },
    off: { white: 8, dark: 6 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    history: [],
    turnMoves: [],
    firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false },
  };

  const direct = game.bestMoveSequences(state, "white").find(sequence => (
    sequence.length === 2
    && sequence[0].from === 3
    && sequence[0].die === 4
    && sequence[0].bearOff
    && sequence[1].from === 1
    && sequence[1].die === 1
    && sequence[1].bearOff
  ));

  assert.ok(direct);
});
