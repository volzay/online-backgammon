const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const PORT = 42141;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let dataDir;
let serverOutput = "";

function loadGame() {
  const context = { window: {}, console, Date, Math, JSON };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), context, { filename: "game.js" });
  return context.window.NarduGame;
}

const game = loadGame();

function captureServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-16 * 1024);
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`server exited before becoming ready\n${serverOutput || "<no child output>"}`);
    }
    try {
      const response = await fetch(`${BASE}/index.html`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(100);
  }
  throw new Error(`server did not start in time\n${serverOutput || "<no child output>"}`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function register(nickname) {
  const { response, body } = await request("/api/register", {
    method: "POST",
    body: JSON.stringify({
      nickname,
      email: `${nickname.toLowerCase()}@single-active.test`,
      password: "secret1",
    }),
  });
  assert.equal(response.status, 201, body.error);
  const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^nardy_user=/);
  return { user: body.user, cookie };
}

function session(account, extra = {}) {
  return {
    ...extra,
    headers: { ...(extra.headers || {}), cookie: account.cookie },
  };
}

async function createHumanRoom(account, overrides = {}) {
  return request("/api/rooms", session(account, {
    method: "POST",
    body: JSON.stringify({
      hostName: account.user.nickname,
      hostUserId: account.user.id,
      hostRatingEligible: true,
      variant: "long",
      access: "open",
      ...overrides,
    }),
  }));
}

function initialBotState() {
  const state = game.initialState("long");
  state.phase = "move";
  state.turn = "white";
  return state;
}

function createBotRoom(account, code, ownerToken) {
  return request("/api/rooms/bot-analysis", session(account, {
    method: "POST",
    body: JSON.stringify({
      code,
      hostName: account.user.nickname,
      hostUserId: account.user.id,
      hostRatingEligible: true,
      botName: "Hard bot",
      difficulty: "hard",
      variant: "long",
      ownerToken,
      state: initialBotState(),
    }),
  }));
}

function guestPlayer(name, suffix) {
  const proof = `gproof:${createHash("sha256").update(`test-guest-proof:${suffix}`).digest("hex")}`;
  return {
    id: `guest:sha256:${createHash("sha256").update(`nardu/guest/v1:${proof}`).digest("hex")}`,
    proof,
    name,
  };
}

function guestSession(guest, extra = {}) {
  return {
    ...extra,
    headers: {
      ...(extra.headers || {}),
      "x-guest-id": guest.id,
      "x-guest-proof": guest.proof,
    },
  };
}

function createGuestHumanRoom(guest, overrides = {}) {
  return request("/api/rooms", guestSession(guest, {
    method: "POST",
    body: JSON.stringify({
      hostName: guest.name,
      hostUserId: guest.id,
      hostRatingEligible: false,
      variant: "long",
      access: "open",
      ...overrides,
    }),
  }));
}

function createGuestBotRoom(guest, code, ownerToken) {
  return request("/api/rooms/bot-analysis", guestSession(guest, {
    method: "POST",
    body: JSON.stringify({
      code,
      hostName: guest.name,
      hostUserId: guest.id,
      hostRatingEligible: false,
      botName: "Hard bot",
      difficulty: "hard",
      variant: "long",
      ownerToken,
      state: initialBotState(),
    }),
  }));
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nardy-single-active-"));
  server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(PORT),
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

test("a waiting human room blocks every second-room entry point", async () => {
  const observer = await register("InvariantObserver");
  const unauthenticated = await request("/api/rooms/active");
  assert.equal(unauthenticated.response.status, 401);

  const created = await createHumanRoom(observer);
  assert.equal(created.response.status, 201, created.body.error);
  const waitingCode = created.body.room.code;
  assert.equal(created.body.room.hostUserId, observer.user.id);

  const active = await request("/api/rooms/active?nickname=SomeoneElse", session(observer));
  assert.equal(active.response.status, 200, active.body.error);
  assert.equal(active.body.room.code, waitingCode, "the cookie account, not a query parameter, selects the room");

  const secondHuman = await createHumanRoom(observer);
  assert.equal(secondHuman.response.status, 409);
  assert.equal(secondHuman.body.room.code, waitingCode);

  const secondBot = await createBotRoom(observer, "HARD-2233", "observer-owner-token-12345678901234567890");
  assert.equal(secondBot.response.status, 409);
  assert.equal(secondBot.body.room.code, waitingCode);

  const lobby = await request("/api/rooms");
  assert.equal(lobby.body.rooms.filter(room => room.hostName === observer.user.nickname).length, 1);
});

test("an active bot room blocks human creation and joining another room", async () => {
  const botOwner = await register("InvariantBotOwner");
  const ownerToken = "bot-owner-token-123456789012345678901";
  const botCode = "BRTX-2234";
  const createdBot = await createBotRoom(botOwner, botCode, ownerToken);
  assert.equal(createdBot.response.status, 201, createdBot.body.error);

  const active = await request("/api/rooms/active", session(botOwner));
  assert.equal(active.response.status, 200, active.body.error);
  assert.equal(active.body.room.code, botCode);
  assert.equal(active.body.room.opponent, "bot");
  assert.equal(active.body.room.hostUserId, botOwner.user.id);

  const secondHuman = await createHumanRoom(botOwner);
  assert.equal(secondHuman.response.status, 409);
  assert.equal(secondHuman.body.room.code, botCode);

  const repeatedBot = await createBotRoom(botOwner, botCode, ownerToken);
  assert.equal(repeatedBot.response.status, 200, repeatedBot.body.error);
  assert.equal(repeatedBot.body.existing, true, "resuming the same bot room stays idempotent");

  const restartedTab = await createBotRoom(
    botOwner,
    botCode,
    "replacement-token-after-browser-restart-1234567890",
  );
  assert.equal(restartedTab.response.status, 200, restartedTab.body.error);
  assert.equal(restartedTab.body.existing, true, "the account cookie remains authoritative after tab storage is lost");
  const restoredWithoutTabToken = await request(`/api/rooms/${botCode}/game`, session(botOwner));
  assert.equal(restoredWithoutTabToken.response.status, 200, restoredWithoutTabToken.body.error);
  assert.equal(restoredWithoutTabToken.body.state.roomCode, botCode);

  const otherHost = await register("InvariantOtherHost");
  const target = await createHumanRoom(otherHost);
  assert.equal(target.response.status, 201, target.body.error);
  const targetCode = target.body.room.code;

  const join = await request(`/api/rooms/${targetCode}/join`, session(botOwner, {
    method: "POST",
    body: JSON.stringify({
      guestName: botOwner.user.nickname,
      guestUserId: botOwner.user.id,
      guestRatingEligible: true,
    }),
  }));
  assert.equal(join.response.status, 409);
  assert.equal(join.body.room.code, botCode);

  const unchangedTarget = await request(`/api/rooms/${targetCode}`);
  assert.equal(unchangedTarget.response.status, 200);
  assert.equal(unchangedTarget.body.room.status, "waiting");
  assert.equal(unchangedTarget.body.room.guestName, "");
});

test("simultaneous human and bot creation leaves exactly one active room", async () => {
  const racer = await register("InvariantRacer");
  const [human, bot] = await Promise.all([
    createHumanRoom(racer),
    createBotRoom(racer, "RACE-2235", "race-owner-token-123456789012345678901"),
  ]);

  assert.deepEqual([human.response.status, bot.response.status].sort(), [201, 409]);
  const winner = human.response.status === 201 ? human.body.room : bot.body.room;
  const loser = human.response.status === 409 ? human.body : bot.body;
  assert.equal(loser.room.code, winner.code);

  const active = await request("/api/rooms/active", session(racer));
  assert.equal(active.response.status, 200, active.body.error);
  assert.equal(active.body.room.code, winner.code);
});

test("only the waiting-room owner can close a registered room and joined rooms are preserved", async () => {
  const owner = await register("InvariantCloser");
  const stranger = await register("InvariantStranger");
  const guest = await register("InvariantJoiner");

  const first = await createHumanRoom(owner);
  assert.equal(first.response.status, 201, first.body.error);
  const firstCode = first.body.room.code;

  const forbidden = await request(`/api/rooms/${firstCode}?waiting=1`, session(stranger, { method: "DELETE" }));
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.removed, false);
  assert.equal(forbidden.body.room.code, firstCode);

  const closed = await request(`/api/rooms/${firstCode}?waiting=1`, session(owner, { method: "DELETE" }));
  assert.equal(closed.response.status, 200, closed.body.error);
  assert.equal(closed.body.removed, true);

  const second = await createHumanRoom(owner);
  assert.equal(second.response.status, 201, second.body.error);
  const secondCode = second.body.room.code;
  const joined = await request(`/api/rooms/${secondCode}/join`, session(guest, {
    method: "POST",
    body: JSON.stringify({
      guestName: guest.user.nickname,
      guestUserId: guest.user.id,
      guestRatingEligible: true,
    }),
  }));
  assert.equal(joined.response.status, 200, joined.body.error);

  const preserved = await request(`/api/rooms/${secondCode}?waiting=1`, session(owner, { method: "DELETE" }));
  assert.equal(preserved.response.status, 200, preserved.body.error);
  assert.equal(preserved.body.removed, false);
  assert.equal(preserved.body.room.status, "joined");

  const stillThere = await request(`/api/rooms/${secondCode}`);
  assert.equal(stillThere.response.status, 200);
  assert.equal(stillThere.body.room.status, "joined");

  const anonymousOwner = guestPlayer("InvariantGuestCloser", "invariant-guest-closer-0001");
  const guestRoom = await createGuestHumanRoom(anonymousOwner);
  assert.equal(guestRoom.response.status, 201, guestRoom.body.error);
  assert.equal(guestRoom.body.room.hostUserId, anonymousOwner.id);

  const guestWithoutProof = await request(`/api/rooms/${guestRoom.body.room.code}?waiting=1`, { method: "DELETE" });
  assert.equal(guestWithoutProof.response.status, 403);
  assert.equal(guestWithoutProof.body.removed, false);

  const guestClosed = await request(`/api/rooms/${guestRoom.body.room.code}?waiting=1`, guestSession(anonymousOwner, {
    method: "DELETE",
  }));
  assert.equal(guestClosed.response.status, 200, guestClosed.body.error);
  assert.equal(guestClosed.body.removed, true, "the stable guest identity is required as ownership proof");
});

test("registered room identity always comes from the account cookie", async () => {
  const victim = await register("InvariantSpoofVictim");
  const attacker = await register("InvariantCookieOwner");

  const humanSpoof = await request("/api/rooms", {
    method: "POST",
    body: JSON.stringify({
      hostName: victim.user.nickname,
      hostUserId: victim.user.id,
      hostRating: victim.user.rating,
      hostRatingEligible: true,
      variant: "long",
      access: "open",
    }),
  });
  assert.equal(humanSpoof.response.status, 401);

  const botSpoof = await request("/api/rooms/bot-analysis", {
    method: "POST",
    body: JSON.stringify({
      code: "SPFQ-2236",
      hostName: victim.user.nickname,
      hostUserId: victim.user.id,
      hostRatingEligible: true,
      ownerToken: "spoof-owner-token-12345678901234567890",
      state: initialBotState(),
    }),
  });
  assert.equal(botSpoof.response.status, 401);

  const guestNicknameSpoof = await createGuestHumanRoom(
    guestPlayer(victim.user.nickname, "spoofed-registered-name-0001"),
  );
  assert.equal(guestNicknameSpoof.response.status, 401);

  const targetOwner = await register("SpoofTargetOwner");
  const target = await createHumanRoom(targetOwner);
  assert.equal(target.response.status, 201, target.body.error);
  const joinSpoof = await request(`/api/rooms/${target.body.room.code}/join`, {
    method: "POST",
    body: JSON.stringify({
      guestName: victim.user.nickname,
      guestUserId: victim.user.id,
      guestRating: victim.user.rating,
      guestRatingEligible: true,
    }),
  });
  assert.equal(joinSpoof.response.status, 401);
  const targetAfterSpoof = await request(`/api/rooms/${target.body.room.code}`);
  assert.equal(targetAfterSpoof.body.room.status, "waiting");
  assert.equal(targetAfterSpoof.body.room.guestUserId, "");

  const cookieWins = await createHumanRoom(attacker, {
    hostName: victim.user.nickname,
    hostUserId: victim.user.id,
    hostRating: victim.user.rating,
  });
  assert.equal(cookieWins.response.status, 201, cookieWins.body.error);
  assert.equal(cookieWins.body.room.hostUserId, attacker.user.id);
  assert.equal(cookieWins.body.room.hostName, attacker.user.nickname);

  const closedCookieRoom = await request(`/api/rooms/${cookieWins.body.room.code}?waiting=1`, session(attacker, {
    method: "DELETE",
  }));
  assert.equal(closedCookieRoom.response.status, 200, closedCookieRoom.body.error);
  const cookieJoinWins = await request(`/api/rooms/${target.body.room.code}/join`, session(attacker, {
    method: "POST",
    body: JSON.stringify({
      guestName: victim.user.nickname,
      guestUserId: victim.user.id,
      guestRating: victim.user.rating,
      guestRatingEligible: true,
    }),
  }));
  assert.equal(cookieJoinWins.response.status, 200, cookieJoinWins.body.error);
  assert.equal(cookieJoinWins.body.room.guestUserId, attacker.user.id);
  assert.equal(cookieJoinWins.body.room.guestName, attacker.user.nickname);

  const roomsAfterSpoof = await request("/api/rooms");
  assert.equal(
    roomsAfterSpoof.body.rooms.some(room => room.hostUserId === victim.user.id),
    false,
    "no spoof request may create or occupy a room for the victim",
  );
});

test("one stable guest identity cannot create or join a second room", async () => {
  const guest = guestPlayer("InvariantStableGuest", "stable-single-active-guest-0001");
  const first = await createGuestHumanRoom(guest);
  assert.equal(first.response.status, 201, first.body.error);
  assert.equal(first.body.room.hostUserId, guest.id);

  const active = await request("/api/rooms/active", guestSession(guest));
  assert.equal(active.response.status, 200, active.body.error);
  assert.equal(active.body.room.code, first.body.room.code);

  const secondHuman = await createGuestHumanRoom(guest);
  assert.equal(secondHuman.response.status, 409);
  assert.equal(secondHuman.body.room.code, first.body.room.code);

  const ownerToken = "guest-blocked-bot-token-12345678901234567890";
  const secondBot = await createGuestBotRoom(guest, "GSTB-2237", ownerToken);
  assert.equal(secondBot.response.status, 409);
  assert.equal(secondBot.body.room.code, first.body.room.code);

  const targetOwner = await register("GuestJoinTarget");
  const target = await createHumanRoom(targetOwner);
  assert.equal(target.response.status, 201, target.body.error);
  const blockedJoin = await request(`/api/rooms/${target.body.room.code}/join`, guestSession(guest, {
    method: "POST",
    body: JSON.stringify({
      guestName: guest.name,
      guestUserId: guest.id,
      guestRatingEligible: false,
    }),
  }));
  assert.equal(blockedJoin.response.status, 409);
  assert.equal(blockedJoin.body.room.code, first.body.room.code);

  const closed = await request(`/api/rooms/${first.body.room.code}?waiting=1`, guestSession(guest, {
    method: "DELETE",
  }));
  assert.equal(closed.response.status, 200, closed.body.error);
  assert.equal(closed.body.removed, true);

  const joined = await request(`/api/rooms/${target.body.room.code}/join`, guestSession(guest, {
    method: "POST",
    body: JSON.stringify({
      guestName: guest.name,
      guestUserId: guest.id,
      guestRatingEligible: false,
    }),
  }));
  assert.equal(joined.response.status, 200, joined.body.error);
  assert.equal(joined.body.room.guestUserId, guest.id);

  const afterJoinHuman = await createGuestHumanRoom(guest);
  assert.equal(afterJoinHuman.response.status, 409);
  assert.equal(afterJoinHuman.body.room.code, target.body.room.code);
  const afterJoinBot = await createGuestBotRoom(guest, "GSTJ-2238", ownerToken);
  assert.equal(afterJoinBot.response.status, 409);
  assert.equal(afterJoinBot.body.room.code, target.body.room.code);
});

test("bot-only deletion requires the actual owner and never deletes a human room", async () => {
  const registeredOwner = await register("BotCloser");
  const stranger = await register("BotCloseStranger");
  const registeredToken = "registered-bot-close-token-123456789012345";
  const registeredBot = await createBotRoom(registeredOwner, "BCLS-2239", registeredToken);
  assert.equal(registeredBot.response.status, 201, registeredBot.body.error);

  const strangerDelete = await request("/api/rooms/BCLS-2239?bot=1", session(stranger, { method: "DELETE" }));
  assert.equal(strangerDelete.response.status, 403);
  const registeredDelete = await request("/api/rooms/BCLS-2239?bot=1", session(registeredOwner, { method: "DELETE" }));
  assert.equal(registeredDelete.response.status, 200, registeredDelete.body.error);
  assert.equal(registeredDelete.body.removed, true, "the account cookie survives loss of the per-tab bot token");

  const guest = guestPlayer("InvariantGuestBotCloser", "guest-bot-close-owner-0001");
  const guestToken = "guest-bot-close-token-12345678901234567890";
  const guestBot = await createGuestBotRoom(guest, "GBCL-2242", guestToken);
  assert.equal(guestBot.response.status, 201, guestBot.body.error);

  const guestWithoutToken = await request("/api/rooms/GBCL-2242?bot=1", guestSession(guest, {
    method: "DELETE",
  }));
  assert.equal(guestWithoutToken.response.status, 403);
  const guestWithoutIdentity = await request("/api/rooms/GBCL-2242?bot=1", {
    method: "DELETE",
    headers: { "x-bot-owner": guestToken },
  });
  assert.equal(guestWithoutIdentity.response.status, 403);
  const guestDelete = await request("/api/rooms/GBCL-2242?bot=1", guestSession(guest, {
    method: "DELETE",
    headers: { "x-bot-owner": guestToken },
  }));
  assert.equal(guestDelete.response.status, 200, guestDelete.body.error);
  assert.equal(guestDelete.body.removed, true);

  const humanOwner = await register("HumanDeleteGuard");
  const human = await createHumanRoom(humanOwner);
  assert.equal(human.response.status, 201, human.body.error);
  const humanBotDelete = await request(`/api/rooms/${human.body.room.code}?bot=1`, session(humanOwner, {
    method: "DELETE",
    headers: { "x-bot-owner": registeredToken },
  }));
  assert.equal(humanBotDelete.response.status, 200);
  assert.equal(humanBotDelete.body.removed, false);
  const humanStillThere = await request(`/api/rooms/${human.body.room.code}`);
  assert.equal(humanStillThere.response.status, 200);
  assert.equal(humanStillThere.body.room.status, "waiting");
});

test("guest proof is request-bound and never exposed to other lobby readers", async () => {
  const owner = guestPlayer("PrivateGuestOwner", "private-guest-owner-0001");
  const attacker = guestPlayer("PrivateGuestAttacker", "private-guest-attacker-0001");

  const rawLegacy = await request("/api/rooms", {
    method: "POST",
    headers: { "x-guest-id": "guest:legacy-public-bearer" },
    body: JSON.stringify({
      hostName: "LegacyGuest",
      hostUserId: "guest:legacy-public-bearer",
      hostRatingEligible: false,
      variant: "long",
      access: "open",
    }),
  });
  assert.equal(rawLegacy.response.status, 401);

  const publicIdOnly = await request("/api/rooms/active", {
    headers: { "x-guest-id": owner.id },
  });
  assert.equal(publicIdOnly.response.status, 401);

  const mismatchedProof = await request("/api/rooms/active", {
    headers: { "x-guest-id": owner.id, "x-guest-proof": attacker.proof },
  });
  assert.equal(mismatchedProof.response.status, 401);

  const spoofed = await request("/api/rooms", guestSession(attacker, {
    method: "POST",
    body: JSON.stringify({
      hostName: owner.name,
      hostUserId: owner.id,
      hostRatingEligible: false,
      variant: "long",
      access: "open",
    }),
  }));
  assert.equal(spoofed.response.status, 401);

  const created = await createGuestHumanRoom(owner);
  assert.equal(created.response.status, 201, created.body.error);
  assert.equal(created.body.room.hostUserId, owner.id);

  const publicLobby = await request("/api/rooms");
  const publicRoom = publicLobby.body.rooms.find(room => room.code === created.body.room.code);
  assert.ok(publicRoom);
  assert.equal(publicRoom.hostUserId, "");

  const attackerLobby = await request("/api/rooms", guestSession(attacker));
  assert.equal(
    attackerLobby.body.rooms.find(room => room.code === created.body.room.code)?.hostUserId,
    "",
  );
  const ownerLobby = await request("/api/rooms", guestSession(owner));
  assert.equal(
    ownerLobby.body.rooms.find(room => room.code === created.body.room.code)?.hostUserId,
    owner.id,
  );

  const closed = await request(`/api/rooms/${created.body.room.code}?waiting=1`, guestSession(owner, {
    method: "DELETE",
  }));
  assert.equal(closed.response.status, 200, closed.body.error);
});

test("Node fallback archives loaded legacy guest rooms but preserves registered bot rooms", () => {
  const source = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const legacyGuard = source.slice(
    source.indexOf("function hasLegacyGuestIdentity"),
    source.indexOf("function normalizeAdminCloseReason"),
  );
  assert.match(legacyGuard, /\["waiting", "joined"\]\.includes\(room\.status\)/);
  assert.match(legacyGuard, /!room\.hostRegistered[\s\S]*!normalizeGuestUserId\(room\.hostUserId\)/);
  assert.match(legacyGuard, /!isBotAnalysisRoom\(room\)[\s\S]*!room\.guestRegistered/);
  assert.match(legacyGuard, /archiveRoom\(room, "legacy_guest_credential_rotated"\)/);
  assert.match(source, /try \{\s+closeLegacyGuestRooms\(\);/);
});

test("generic deletion and forged leave requests cannot mutate a room", async () => {
  const owner = await register("LeaveGuardOwner");
  const guest = await register("LeaveGuardGuest");
  const stranger = await register("LeaveGuardStranger");
  const created = await createHumanRoom(owner);
  assert.equal(created.response.status, 201, created.body.error);
  const code = created.body.room.code;

  const unsafeDelete = await request(`/api/rooms/${code}`, session(owner, { method: "DELETE" }));
  assert.equal(unsafeDelete.response.status, 400);

  const joined = await request(`/api/rooms/${code}/join`, session(guest, {
    method: "POST",
    body: JSON.stringify({ guestName: guest.user.nickname, guestUserId: guest.user.id }),
  }));
  assert.equal(joined.response.status, 200, joined.body.error);

  const forgedStrangerLeave = await request(`/api/rooms/${code}/leave`, session(stranger, {
    method: "POST",
    body: JSON.stringify({ color: "white", name: owner.user.nickname }),
  }));
  assert.equal(forgedStrangerLeave.response.status, 403);

  const forgedColorLeave = await request(`/api/rooms/${code}/leave`, session(guest, {
    method: "POST",
    body: JSON.stringify({ color: "white" }),
  }));
  assert.equal(forgedColorLeave.response.status, 403);

  const forgedPresence = await request(`/api/rooms/${code}/presence`, session(stranger, {
    method: "POST",
    body: JSON.stringify({ color: "white", name: owner.user.nickname }),
  }));
  assert.equal(forgedPresence.response.status, 403);

  const forgedGameWrite = await request(`/api/rooms/${code}/game`, session(stranger, {
    method: "PUT",
    body: JSON.stringify({ state: initialBotState(), version: 0 }),
  }));
  assert.equal(forgedGameWrite.response.status, 403);

  const guestLeave = await request(`/api/rooms/${code}/leave`, session(guest, {
    method: "POST",
    body: JSON.stringify({ color: "dark" }),
  }));
  assert.equal(guestLeave.response.status, 200, guestLeave.body.error);
  assert.equal(guestLeave.body.removed, false);

  const ownerLeave = await request(`/api/rooms/${code}/leave`, session(owner, {
    method: "POST",
    body: JSON.stringify({ color: "white" }),
  }));
  assert.equal(ownerLeave.response.status, 200, ownerLeave.body.error);
  assert.equal(ownerLeave.body.removed, true);
});
