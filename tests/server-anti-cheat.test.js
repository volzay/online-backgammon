const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");

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
let serverOutput = "";
const roomGuestCredentials = new Map();

function captureServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-16 * 1024);
}

function serverStartDiagnostics() {
  const status = server?.exitCode === null
    ? "still running"
    : `exited with code ${server?.exitCode ?? "unknown"}${server?.signalCode ? ` (${server.signalCode})` : ""}`;
  const output = serverOutput.trim() || "<no child output>";
  return [
    `runtime=${process.execPath}`,
    `address=127.0.0.1:${PORT}`,
    `dataDir=${dataDir}`,
    `child=${status}`,
    `output:\n${output}`,
  ].join("\n");
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`server exited before becoming ready\n${serverStartDiagnostics()}`);
    }
    try {
      const response = await fetch(`${BASE}/index.html`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(150);
  }
  throw new Error(`server did not start in time\n${serverStartDiagnostics()}`);
}

async function createRoom() {
  roomCounter += 1;
  const guestProof = `gproof:${createHash("sha256").update(`anti-cheat:${roomCounter}`).digest("hex")}`;
  const guestId = `guest:sha256:${createHash("sha256")
    .update(`nardu/guest/v1:${guestProof}`)
    .digest("hex")}`;
  const response = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-guest-id": guestId,
      "x-guest-proof": guestProof,
    },
    body: JSON.stringify({
      hostName: `Tester${roomCounter}`,
      hostUserId: guestId,
      hostRatingEligible: false,
      variant: "long",
      access: "open",
    }),
  });
  const body = await response.json();
  const code = body.room?.code || body.code;
  if (code) roomGuestCredentials.set(code, { guestId, guestProof });
  return code;
}

function putGame(code, state, version = 0, ownerToken = '', cookie = '') {
  const guest = roomGuestCredentials.get(code);
  return fetch(`${BASE}/api/rooms/${code}/game`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(guest ? { "x-guest-id": guest.guestId, "x-guest-proof": guest.guestProof } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ state, version, ...(ownerToken ? { ownerToken } : {}) }),
  });
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nardy-anticheat-"));
  serverOutput = "";
  server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", captureServerOutput);
  server.stderr.on("data", captureServerOutput);
  server.on("error", error => captureServerOutput(`${error.stack || error}\n`));
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

test("API fallback hides an active bot game from the lobby and archives its result", async () => {
  const code = "BRTX-2233";
  const ownerToken = "bot-owner-token-for-api-test-1234567890";
  const initial = game.initialState("long");
  initial.phase = "move";
  initial.turn = "white";
  const accountResponse = await fetch(`${BASE}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: "ApiBotTester", email: "api-bot@example.test", password: "secret1" }),
  });
  assert.equal(accountResponse.status, 201);
  const accountCookie = String(accountResponse.headers.get("set-cookie") || "").split(";")[0];
  assert.match(accountCookie, /^nardy_user=/);

  const impersonationResponse = await fetch(`${BASE}/api/rooms/bot-analysis`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, hostName: "ApiBotTester", hostRatingEligible: true, ownerToken, state: initial }),
  });
  assert.equal(impersonationResponse.status, 401);

  const createResponse = await fetch(`${BASE}/api/rooms/bot-analysis`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: accountCookie },
    body: JSON.stringify({
      code,
      variant: "long",
      botName: "Hard bot",
      botRating: 1500,
      difficulty: "hard",
      playerColor: "white",
      hostName: "ApiBotTester",
      hostRatingEligible: true,
      ownerToken,
      state: initial,
    }),
  });
  assert.equal(createResponse.status, 201);
  assert.equal((await createResponse.json()).version, 0);

  const lobby = await (await fetch(`${BASE}/api/rooms`)).json();
  assert.equal(lobby.rooms.some(room => room.code === code), false);

  const finished = structuredClone(initial);
  finished.phase = "over";
  finished.winner = "white";
  finished.resultType = "normal";
  finished.finishedAt = Date.now();
  finished.history = [{ resign: true, color: "dark", at: new Date().toISOString() }];
  finished.analysis = {
    mode: "bot",
    opponent: "bot",
    botMemory: { decisions: [{ id: "api-bot-decision-1" }] },
  };
  assert.equal((await putGame(code, finished, 0)).status, 403);
  assert.equal((await putGame(code, finished, 0, "wrong-owner-token-that-is-long-enough-123")).status, 403);
  assert.equal((await putGame(code, finished, 0, ownerToken)).status, 403);
  const finishResponse = await putGame(code, finished, 0, '', accountCookie);
  assert.equal(finishResponse.status, 200);

  const loginResponse = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: "admin", password: "test" }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = String(loginResponse.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^nardy_admin=/);
  const sessionsResponse = await fetch(`${BASE}/api/admin/sessions`, {
    headers: { cookie },
  });
  assert.equal(sessionsResponse.status, 200);
  const sessions = await sessionsResponse.json();
  assert.equal(sessions.active.some(room => room.code === code), false);
  const archived = sessions.archive.find(room => room.code === code);
  assert.ok(archived);
  assert.equal(archived.archiveReason, "resignation");
  assert.equal(archived.winnerName, "ApiBotTester");

  const detailResponse = await fetch(`${BASE}/api/admin/sessions/${code}`, {
    headers: { cookie },
  });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.session.game.analysis.botMemory.decisions.length, 1);
});

test("preserves a complete voice chat payload beyond the former 1.5 MB limit", async () => {
  const code = await createRoom();
  const guest = roomGuestCredentials.get(code);
  const audioData = `data:audio/webm;base64,${"A".repeat(5 * 1024 * 1024)}`;
  const response = await fetch(`${BASE}/api/rooms/${code}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-guest-id": guest.guestId,
      "x-guest-proof": guest.guestProof,
    },
    body: JSON.stringify({
      senderId: "voice-test",
      senderName: "Voice test",
      color: "white",
      kind: "voice",
      audioData,
      mimeType: "audio/webm",
      duration: 60_000,
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.message.audioData.length, audioData.length);
  assert.equal(body.message.audioData, audioData);
});
