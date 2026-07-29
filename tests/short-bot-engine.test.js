const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function runtime() {
  require("../scripts/build-short-bot-engine")();
  const context = { console, Date, Math, setTimeout, clearTimeout };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["game.js", "short-bot-engine.js", "strong-bot.js", "bot.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
  }
  return context;
}

function position(game, {
  points,
  bar = { white: 0, dark: 0 },
  off = { white: 0, dark: 0 },
  turn = "white",
  dice = [1],
}) {
  const state = game.initialState("short");
  state.points = JSON.parse(JSON.stringify(points));
  state.bar = { white: 0, dark: 0, ...bar };
  state.off = { white: 0, dark: 0, ...off };
  state.turn = turn;
  state.phase = "move";
  state.dice = [...dice];
  state.rolled = [...dice];
  state.turnMoves = [];
  state.winner = null;
  return state;
}

test("short hard bot installs a dedicated analytical engine", () => {
  const context = runtime();
  assert.equal(context.NarduShortBotEngine.version, "short-analytic-v1");
  assert.equal(typeof context.NarduShortBotEngine.rank, "function");
  assert.equal(typeof context.NarduShortBotEngine.setExperience, "function");
});

test("short hard bot makes the 7 point with opening 6-1", () => {
  const context = runtime();
  const state = position(context.NarduGame, {
    points: context.NarduGame.initialState("short").points,
    dice: [6, 1],
  });
  const plan = context.NarduStrongBot.plan(state);
  const next = JSON.parse(JSON.stringify(state));
  plan.forEach(move => context.NarduGame.applyMove(next, move.from, move.die, { autoEnd: false }));

  assert.deepEqual(
    JSON.parse(JSON.stringify(next.points[7])),
    { color: "white", count: 2 },
    "6-1 should create the strategically valuable 7 point",
  );
  const decision = context.NarduShortBotEngine.consumeLastDecision();
  assert.equal(decision.selected.tactical.rolls, 21);
  assert.equal(decision.engineVersion, "short-analytic-v1");
});

test("short hard bot enters from the bar and hits an exposed checker", () => {
  const context = runtime();
  const state = position(context.NarduGame, {
    points: {
      24: { color: "dark", count: 1 },
      13: { color: "white", count: 14 },
      12: { color: "dark", count: 14 },
    },
    bar: { white: 1 },
    dice: [1],
  });
  const plan = context.NarduShortBotEngine.plan(state);
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), [{ from: 25, die: 1 }]);
  const next = JSON.parse(JSON.stringify(state));
  context.NarduGame.applyMove(next, plan[0].from, plan[0].die, { autoEnd: false });
  assert.equal(next.bar.white, 0);
  assert.equal(next.bar.dark, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(next.points[24])), { color: "white", count: 1 });
});

test("short hard bot bears off both available checkers instead of shuffling at home", () => {
  const context = runtime();
  const state = position(context.NarduGame, {
    points: {
      6: { color: "white", count: 1 },
      1: { color: "white", count: 1 },
      24: { color: "dark", count: 15 },
    },
    off: { white: 13 },
    dice: [6, 1],
  });
  const plan = context.NarduShortBotEngine.plan(state);
  const next = JSON.parse(JSON.stringify(state));
  plan.forEach(move => context.NarduGame.applyMove(next, move.from, move.die, { autoEnd: false }));
  assert.equal(next.off.white, 15);
  assert.equal(next.winner, "white");
});

test("short hard bot records bar-aware decisions for durable learning", () => {
  const context = runtime();
  const state = position(context.NarduGame, {
    points: {
      24: { color: "dark", count: 2 },
      23: { color: "dark", count: 2 },
      13: { color: "white", count: 14 },
      12: { color: "dark", count: 11 },
    },
    bar: { white: 1 },
    dice: [3],
  });
  context.NarduStrongBot.plan(state);
  const decision = context.NarduShortBotEngine.consumeLastDecision();
  assert.equal(decision.position.bar.white, 1);
  assert.match(decision.experience.contextKey, /^bar\|/);
  assert.match(decision.experience.actionKey, /enter:1/);
});

test("short experience keeps local and server knowledge in separate mergeable sources", () => {
  const context = runtime();
  const engine = context.NarduShortBotEngine;
  engine.setExperience([{
    contextKey: "contact|merge",
    actionKey: "hit:1",
    samples: 2,
    wins: 2,
    winWeight: 2,
  }], "local");
  engine.setExperience([{
    contextKey: "contact|merge",
    actionKey: "hit:1",
    samples: 3,
    losses: 1,
    lossWeight: 1,
  }], "server");
  assert.equal(engine.experienceSize(), 1);
  engine.setExperience([], "server");
  assert.equal(engine.experienceSize(), 1, "clearing a stale server cache must preserve local experience");
});

test("short engine is loaded before the shared hard-bot dispatcher", () => {
  const room = fs.readFileSync(path.join(ROOT, "room.html"), "utf8");
  assert.ok(room.indexOf("short-bot-engine.js") < room.indexOf("strong-bot.js"));
  assert.match(room, /short-bot-engine\.js\?v=20260730-short-analytic-v1/);
});

test("short learning has a separate server RPC and archive accepts both variants", () => {
  const schema = fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8");
  const client = fs.readFileSync(path.join(ROOT, "rooms-client.js"), "utf8");
  assert.match(schema, /get_short_bot_experience_patterns\(\s*p_player_name text default null/);
  assert.match(schema, /not in \('long', 'short'\)/);
  assert.ok((schema.match(/not in \('long', 'short'\)/g) || []).length >= 2);
  assert.match(client, /loadShortBotExperience/);
  assert.match(client, /get_short_bot_experience_patterns/);
});
