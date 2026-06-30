const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 42137;
const BASE = `http://127.0.0.1:${PORT}`;

function loadGame() {
  const context = { window: {}, console, Date, Math, JSON };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), context, {
    filename: "game.js",
  });
  return context.window.NarduGame;
}

const game = loadGame();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let dataDir;
let roomCounter = 0;

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/index.html`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(150);
  }
  throw new Error("server did not start in time");
}

async function createRoom() {
  roomCounter += 1;
  const response = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostName: `Tester${roomCounter}`,
      variant: "long",
      access: "open",
    }),
  });
  const body = await response.json();
  return body.room?.code || body.code;
}

function putGame(code, state, version = 0) {
  return fetch(`${BASE}/api/rooms/${code}/game`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, version }),
  });
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nardy-anticheat-"));
  server = spawn("node", [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: "test",
    },
    stdio: "ignore",
  });
  await waitForServer();
});

test.after(() => {
  server?.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("accepts a legitimate state and rejects a stale version", async () => {
  const code = await createRoom();
  const state = game.initialState("long");
  state.phase = "move";
  state.turn = "white";
  assert.equal((await putGame(code, state, 0)).status, 200);
  assert.equal((await putGame(code, state, 0)).status, 409);
});

test("rejects a fabricated win", async () => {
  const code = await createRoom();
  const state = game.initialState("long");
  state.phase = "over";
  state.winner = "white";
  assert.equal((await putGame(code, state)).status, 422);
});

test("rejects a tampered checker count", async () => {
  const code = await createRoom();
  const state = game.initialState("long");
  state.points[Object.keys(state.points)[0]].count -= 1;
  assert.equal((await putGame(code, state)).status, 422);
});

test("accepts a borne-off win and a resignation", async () => {
  const borneOffCode = await createRoom();
  const borneOff = game.initialState("long");
  borneOff.points = { 12: { color: "dark", count: 12 } };
  borneOff.off = { white: 15, dark: 3 };
  borneOff.phase = "over";
  borneOff.winner = "white";
  assert.equal((await putGame(borneOffCode, borneOff)).status, 200);

  const resignationCode = await createRoom();
  const resignation = game.initialState("long");
  resignation.phase = "over";
  resignation.winner = "white";
  resignation.history = [{ resign: true, color: "dark" }];
  assert.equal((await putGame(resignationCode, resignation)).status, 200);
});
