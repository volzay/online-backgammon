const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function controllerContext() {
  const document = {
    addEventListener() {},
    getElementById() { return null; },
  };
  const window = {
    addEventListener() {},
  };
  const context = {
    window,
    document,
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem() { return null; },
      setItem() {},
    },
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    location: { href: "https://example.test/room.html" },
    history: { replaceState() {} },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "game-controller.js"), "utf8"),
    context,
    { filename: "game-controller.js" },
  );
  return context;
}

test("hard bot identity cannot be downgraded by an easy default", () => {
  const context = controllerContext();
  const resolve = context.window.NarduController.resolveBotDifficulty;

  assert.equal(resolve("easy", "hard"), "hard");
  assert.equal(resolve("easy", "Бот сложный"), "hard");
  assert.equal(resolve("easy", 1500), "hard");
  assert.equal(resolve("easy", "medium"), "medium");
});

test("bot planner keeps the strongest difficulty hint from saved state", () => {
  const context = controllerContext();
  context.window.NarduGame = {};
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "bot.js"), "utf8"),
    context,
    { filename: "bot.js" },
  );

  assert.equal(
    context.window.NarduBot.normalizeDifficulty("easy", {
      botDifficulty: "hard",
      analysis: { difficulty: "hard", botName: "Бот сложный" },
    }),
    "hard",
  );
});

test("direct bear-off is preferred over a chained route to the tray", () => {
  const context = controllerContext();
  const choose = context.window.NarduController.preferredMoveAction;
  const chained = {
    to: 0,
    moves: [
      { from: 3, to: 2, die: 1 },
      { from: 2, to: 0, die: 4, bearOff: true },
    ],
  };
  const direct = { from: 3, to: 0, die: 4, bearOff: true };

  assert.deepEqual(
    JSON.parse(JSON.stringify(choose([chained], [direct], 0))),
    { type: "single", dest: direct },
  );
});
