const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    has(key) { return values.has(key); },
  };
}

function controllerContext() {
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const href = "https://example.test/room.html?mode=bot&game=TEST-RM1&variant=long&difficulty=hard";
  const document = {
    hidden: false,
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const window = {
    addEventListener() {},
    setTimeout,
    NarduApp: {
      getUser() { return { name: "Tester" }; },
      paintUser() {},
    },
  };
  const context = {
    window,
    document,
    console,
    Date,
    Math,
    JSON,
    URL,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    localStorage,
    sessionStorage,
    location: {
      href,
      pathname: "/room.html",
      search: "?mode=bot&game=TEST-RM1&variant=long&difficulty=hard",
      hostname: "example.test",
    },
    history: { replaceState() {} },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), context, { filename: "game.js" });
  context.NarduGame = context.window.NarduGame;
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game-controller.js"), "utf8"), context, {
    filename: "game-controller.js",
  });
  return context;
}

test("another bot game ignores the completed room snapshot and keeps match score", async () => {
  const context = controllerContext();
  const controller = context.window.NarduController;
  const signature = `${context.location.pathname}${context.location.search}`;
  const snapshotKey = `narduh-room-state:${signature}`;

  controller.init({
    mode: "bot",
    roomCode: "TEST-RM1",
    variant: "long",
    difficulty: "hard",
    opponent: "Hard bot",
    opponentRating: 1500,
    skipAutoStart: true,
  });
  const finished = controller.getState();
  finished.phase = "over";
  finished.winner = "white";
  finished.finishedAt = Date.now();
  finished.matchScore = { white: 1, dark: 0, target: 5, recordedWinner: "white" };
  context.localStorage.setItem(snapshotKey, JSON.stringify({
    v: 1,
    at: Date.now(),
    signature,
    mode: "bot",
    playerColor: "white",
    roomCode: "TEST-RM1",
    state: finished,
  }));

  controller.startNextGame({ autoStart: false });
  await new Promise(resolve => setTimeout(resolve, 260));

  const next = controller.getState();
  assert.equal(next.winner, null);
  assert.equal(next.phase, "opening");
  assert.deepEqual(
    JSON.parse(JSON.stringify(next.matchScore)),
    { white: 1, dark: 0, target: 5, recordedWinner: null },
  );
  assert.equal(context.localStorage.has(snapshotKey), true);
  const persisted = JSON.parse(context.localStorage.getItem(snapshotKey));
  assert.equal(persisted.state.winner, null);
  assert.equal(persisted.state.phase, "opening");
});

test("saving a new game reopens an archived room", async () => {
  const updates = [];
  const builder = {
    update(value) { updates.push(value); return this; },
    eq() { return this; },
    select() { return this; },
    async maybeSingle() { return { data: { game_version: 8 }, error: null }; },
  };
  const context = {
    window: {
      NarduSupabase: {
        configured() { return true; },
        async client() { return { from() { return builder; } }; },
      },
    },
    console,
    Date,
    Math,
    JSON,
    Map,
    Uint8Array,
    TextEncoder,
    fetch,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "rooms-client.js"), "utf8"), context, {
    filename: "rooms-client.js",
  });

  await context.window.NarduRooms.putGameState("TEST-RM1", { phase: "opening", mode: "bot" }, 7);
  assert.equal(updates[0].status, "joined");
  assert.equal(updates[0].archived_at, null);
  assert.equal(updates[0].closed_reason, null);

  await context.window.NarduRooms.putGameState("TEST-RM1", { phase: "over", winner: "white" }, 8);
  assert.equal(updates[1].status, "over");
  assert.equal(updates[1].closed_reason, "finished");
});

test("bot training archive does not overwrite a live rematch state", () => {
  const schema = fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8");
  const start = schema.indexOf("create or replace function public.archive_bot_training_game");
  const end = schema.indexOf("revoke all on function public.archive_bot_training_game", start);
  const archiveFunction = schema.slice(start, end);

  assert.match(archiveFunction, /target_state := p_final_state;/);
  assert.doesNotMatch(archiveFunction, /game_state\s*=\s*p_final_state/);
});
