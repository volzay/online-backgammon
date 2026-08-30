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

function finishedGameContext({
  failFinalState = false,
  failArchive = false,
  mode = "bot",
  deferFinalState = false,
  autoFinish = true,
  guest = false,
} = {}) {
  const elements = new Map();
  const makeElement = initialId => {
    const listeners = new Map();
    let id = initialId || "";
    let innerHTML = "";
    const element = {
      disabled: false,
      textContent: "",
      className: "",
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener(type, handler) { listeners.set(type, handler); },
      setAttribute(name) { if (name === "disabled") element.disabled = true; },
      async click() { return listeners.get("click")?.({ target: element }); },
      remove() { if (id) elements.delete(id); },
      set id(value) { id = value; elements.set(value, element); },
      get id() { return id; },
      set innerHTML(value) {
        innerHTML = value;
        for (const buttonId of ["go-again", "go-lobby", "rematch-yes", "rematch-no"]) {
          if (value.includes(`id="${buttonId}"`)) elements.set(buttonId, makeElement(buttonId));
          else elements.delete(buttonId);
        }
      },
      get innerHTML() { return innerHTML; },
    };
    if (id) elements.set(id, element);
    return element;
  };
  const document = {
    hidden: false,
    body: { appendChild(element) { if (element.id) elements.set(element.id, element); } },
    createElement() { return makeElement(); },
    getElementById(id) { return elements.get(id) || null; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const search = mode === "remote"
    ? "?mode=remote&room=TEST-RM1&host=1&variant=long"
    : "?mode=bot&game=TEST-RM1&variant=long&difficulty=hard";
  const location = {
    href: `https://example.test/room.html${search}`,
    pathname: "/room.html",
    search,
    hostname: "example.test",
  };
  const roomCalls = { finalStates: 0, finishCalls: 0, putCalls: 0, archives: 0, lobby: 0 };
  const never = new Promise(() => {});
  let releaseFinalState = () => {};
  const finalStateGate = deferFinalState
    ? new Promise(resolve => { releaseFinalState = resolve; })
    : Promise.resolve();
  const window = {
    addEventListener() {},
    setTimeout(callback, ms) { return setTimeout(callback, Math.min(Number(ms) || 0, 5)); },
    requestAnimationFrame(callback) { callback(); },
    NarduApp: {
      getUser() {
        return guest
          ? { id: "guest:test", name: "Наблюдатель", guest: true }
          : { id: "user-1", name: "Tester", guest: false };
      },
      paintUser() {},
    },
    NarduRooms: {
      configured() { return true; },
      async ensureBotAnalysisRoom() { return { version: 0 }; },
      async getGameState() { const error = new Error("not found"); error.status = 404; throw error; },
      async putGameState() {
        roomCalls.finalStates += 1;
        roomCalls.putCalls += 1;
        if (failFinalState) throw new Error("final state unavailable");
        return { version: roomCalls.finalStates };
      },
      async finishRoomGame(_code, payload) {
        roomCalls.finalStates += 1;
        roomCalls.finishCalls += 1;
        roomCalls.finalStatePayload = payload;
        if (failFinalState) throw new Error("final state unavailable");
        await finalStateGate;
        return { ok: true, version: roomCalls.finalStates };
      },
      async archiveBotTrainingGame(_code, payload) {
        roomCalls.archives += 1;
        roomCalls.archivePayload = payload;
        if (failArchive) throw new Error("archive unavailable");
        return {
          ok: true,
          decisionCount: payload?.analysis?.botMemory?.decisions?.length || 0,
        };
      },
    },
    NarduRoom: {
      leaveToLobby(options) {
        roomCalls.lobby += 1;
        roomCalls.lobbyOptions = options;
        location.href = "index.html";
      },
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
    Uint8Array,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    requestAnimationFrame: window.requestAnimationFrame,
    localStorage,
    sessionStorage,
    location,
    history: { replaceState() {} },
    NarduSound: { prime() {}, win() {}, lose() {}, move() {}, bearOff() {} },
    NarduRating: {
      record(_name, _rating, _won, _mode, _key, details) {
        roomCalls.ratingDetails = details;
        return { delta: 19, rating: 1268, syncPromise: never };
      },
    },
  };
  window.window = window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), context, { filename: "game.js" });
  context.NarduGame = window.NarduGame;
  const source = fs.readFileSync(path.join(ROOT, "game-controller.js"), "utf8")
    .replace("    preferredMoveAction,\n  };", "    preferredMoveAction,\n    __test: { onGameOver, resignGame },\n  };");
  vm.runInContext(source, context, { filename: "game-controller.js" });

  const controller = window.NarduController;
  controller.init({
    mode,
    roomCode: "TEST-RM1",
    variant: "long",
    difficulty: "hard",
    opponent: mode === "remote" ? "Opponent" : "Hard bot",
    opponentRating: 1500,
    skipAutoStart: true,
  });
  const state = controller.getState();
  state.phase = autoFinish ? "over" : "move";
  state.winner = autoFinish ? "white" : null;
  state.off = autoFinish ? { white: 15, dark: 5 } : { white: 0, dark: 0 };
  state.finishedAt = autoFinish ? Date.now() : null;
  state.history = [{ color: "white", roll: "6:6", at: new Date().toISOString() }];
  state.analysis = {
    botMemory: {
      engineVersion: "long-analytic-v13",
      decisions: [{ id: "lb4-test", experience: { actionKey: "route:test" } }],
    },
  };
  if (autoFinish) controller.__test.onGameOver();
  return { context, controller, document, location, roomCalls, releaseFinalState };
}

test("an internal round restart ignores the completed room snapshot and keeps match score", async () => {
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

test("another bot game opens a new room code", () => {
  const context = controllerContext();
  const controller = context.window.NarduController;
  controller.init({
    mode: "bot",
    roomCode: "TEST-RM1",
    variant: "long",
    difficulty: "hard",
    opponent: "Hard bot",
    opponentRating: 1500,
    skipAutoStart: true,
  });

  const nextCode = controller.startBotGameInNewRoom();
  const nextUrl = new URL(context.location.href);
  assert.match(nextCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.notEqual(nextCode, "TEST-RM1");
  assert.equal(nextUrl.searchParams.get("game"), nextCode);
  assert.equal(nextUrl.searchParams.get("mode"), "bot");
  assert.equal(nextUrl.searchParams.get("difficulty"), "hard");

  const saved = JSON.parse(context.localStorage.getItem(`narduh-bot-game:${nextCode}`));
  assert.equal(saved.game, nextCode);
  assert.equal(saved.variant, "long");
  assert.equal(saved.difficulty, "hard");
});

test("lobby exit is immediate and shows no saving state while rating never settles", async () => {
  const { document, location, roomCalls } = finishedGameContext();

  await document.getElementById("go-lobby").click();

  assert.equal(roomCalls.lobby, 1);
  assert.equal(roomCalls.lobbyOptions?.immediate, true);
  assert.equal(location.href, "index.html");
  assert.doesNotMatch(document.getElementById("game-over").innerHTML, /Сохраняем результат/);
});

test("bot lobby navigation gives the atomic finalizer a short invisible window", async () => {
  const { document, location, roomCalls, releaseFinalState } = finishedGameContext({
    deferFinalState: true,
  });
  const modal = document.getElementById("game-over");
  const navigation = document.getElementById("go-lobby").click();
  await Promise.resolve();

  assert.equal(roomCalls.finishCalls, 1);
  assert.equal(roomCalls.lobby, 0);
  assert.doesNotMatch(modal.innerHTML, /Сохраняем результат/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(roomCalls.lobby, 0);

  releaseFinalState();
  await navigation;
  assert.equal(roomCalls.lobby, 1);
  assert.equal(location.href, "index.html");
});

test("remote resignation is persisted through the atomic room finalizer", async () => {
  const { controller, roomCalls } = finishedGameContext({ mode: "remote", autoFinish: false });

  controller.__test.resignGame();
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(roomCalls.finalStates, 1);
  assert.equal(roomCalls.finalStatePayload.phase, "over");
  assert.equal(roomCalls.finalStatePayload.winner, "dark");
  assert.equal(roomCalls.finalStatePayload.history[0].resign, true);
  assert.equal(roomCalls.finalStatePayload.history[0].color, "white");
});

test("remote lobby navigation waits for the atomic final state without showing saving text", async () => {
  const { document, location, roomCalls, releaseFinalState } = finishedGameContext({
    mode: "remote",
    deferFinalState: true,
  });
  const modal = document.getElementById("game-over");
  const navigation = document.getElementById("go-lobby").click();
  await Promise.resolve();

  assert.equal(roomCalls.lobby, 0);
  assert.doesNotMatch(modal.innerHTML, /Сохраняем результат/);

  releaseFinalState();
  await navigation;
  assert.equal(roomCalls.lobby, 1);
  assert.equal(location.href, "index.html");
});

test("another bot game starts immediately and shows no saving state while rating never settles", async () => {
  const { document, location, roomCalls } = finishedGameContext();

  await document.getElementById("go-again").click();

  assert.match(location.href, /[?&]game=[A-Z2-9]{4}-[A-Z2-9]{4}/);
  assert.notEqual(new URL(location.href).searchParams.get("game"), "TEST-RM1");
  assert.doesNotMatch(document.getElementById("game-over").innerHTML, /Сохраняем результат/);
});

test("another bot game waits for the atomic final snapshot without showing saving text", async () => {
  const { document, location, roomCalls, releaseFinalState } = finishedGameContext({
    deferFinalState: true,
  });
  const originalUrl = location.href;
  const navigation = document.getElementById("go-again").click();
  await Promise.resolve();

  assert.equal(roomCalls.finishCalls, 1);
  assert.equal(location.href, originalUrl);
  assert.doesNotMatch(document.getElementById("game-over").innerHTML, /Сохраняем результат/);

  releaseFinalState();
  await navigation;
  assert.match(location.href, /[?&]game=[A-Z2-9]{4}-[A-Z2-9]{4}/);
});

test("finished bot analysis reaches both rating finalization and the training archive", async () => {
  const { roomCalls } = finishedGameContext();
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(roomCalls.finishCalls, 1);
  assert.equal(roomCalls.finalStatePayload.analysis.botMemory.decisions.length, 0);
  assert.equal(roomCalls.ratingDetails.score.finalState.analysis.botMemory.decisions.length, 1);
  assert.equal(roomCalls.archivePayload.analysis.botMemory.decisions.length, 1);
  assert.equal(roomCalls.archives, 1);
});

test("guest training archive waits for the full authoritative decision log", async () => {
  const { roomCalls, releaseFinalState } = finishedGameContext({
    guest: true,
    deferFinalState: true,
  });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(roomCalls.finishCalls, 1);
  assert.equal(roomCalls.archives, 0);
  assert.equal(roomCalls.finalStatePayload.analysis.botMemory.decisions.length, 1);

  releaseFinalState();
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(roomCalls.archives, 1);
  assert.deepEqual(
    roomCalls.finalStatePayload.analysis.botMemory.decisions,
    roomCalls.archivePayload.analysis.botMemory.decisions,
  );
});

test("the first game-over action wins when lobby and another game are clicked", async () => {
  const { document, location, roomCalls } = finishedGameContext();
  const lobbyButton = document.getElementById("go-lobby");
  const againButton = document.getElementById("go-again");

  await lobbyButton.click();
  await againButton.click();

  assert.equal(roomCalls.lobby, 1);
  assert.equal(location.href, "index.html");
  assert.equal(lobbyButton.disabled, true);
  assert.equal(againButton.disabled, true);
});

test("immediate lobby exit does not depend on either persistence channel", async () => {
  const { document, location, roomCalls } = finishedGameContext({ failFinalState: true, failArchive: true });

  await document.getElementById("go-lobby").click();

  assert.equal(roomCalls.lobby, 1);
  assert.equal(location.href, "index.html");
});

test("finished-game lobby navigation bypasses room cleanup network waits", () => {
  const source = fs.readFileSync(path.join(ROOT, "room.html"), "utf8");
  assert.match(source, /async function leaveToLobby\(\{ immediate = false \} = \{\}\)/);
  assert.match(source, /if \(immediate\) \{\s*location\.href = 'index\.html';\s*return;/);
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

test("guest hard-bot finalization uses the versioned room update", async () => {
  const updates = [];
  const filters = [];
  let rpcCalls = 0;
  let signOutCalls = 0;
  const builder = {
    update(value) { updates.push(value); return this; },
    eq(column, value) { filters.push([column, value]); return this; },
    select() { return this; },
    async maybeSingle() { return { data: { game_version: 4 }, error: null }; },
  };
  const client = {
    auth: {
      async signOut() { signOutCalls += 1; },
    },
    from(table) {
      assert.equal(table, "rooms");
      return builder;
    },
    async rpc() {
      rpcCalls += 1;
      return { data: null, error: new Error("guest must not call authenticated finalizer") };
    },
  };
  const context = {
    window: {
      NarduApp: {
        getUser() { return { name: "Наблюдатель", guest: true }; },
      },
      NarduSupabase: {
        configured() { return true; },
        async client() { return client; },
      },
    },
    localStorage: memoryStorage(),
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
  const decisions = [{ id: "guest-hard-1", experience: { actionKey: "route:safe" } }];
  const finalState = {
    phase: "over",
    winner: "white",
    analysis: { botMemory: { decisions } },
  };

  const result = await context.window.NarduRooms.finishRoomGame("TEST-RM1", finalState, 3);

  assert.equal(result.version, 4);
  assert.equal(signOutCalls, 1);
  assert.equal(rpcCalls, 0);
  assert.equal(updates[0].status, "over");
  assert.deepEqual(updates[0].game_state.analysis.botMemory.decisions, decisions);
  assert.deepEqual(filters, [["code", "TEST-RM1"], ["game_version", 3]]);
});

test("bot training archive does not overwrite a live rematch state", () => {
  const schema = fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8");
  const start = schema.indexOf("create or replace function public.archive_bot_training_game");
  const end = schema.indexOf("revoke all on function public.archive_bot_training_game", start);
  const archiveFunction = schema.slice(start, end);

  assert.match(archiveFunction, /target_state := p_final_state;/);
  assert.doesNotMatch(archiveFunction, /game_state\s*=\s*p_final_state/);
});

test("guest bot archive keeps exact-state protection and archives final-state decisions", () => {
  const schema = fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8");
  const archiveStart = schema.indexOf("create or replace function public.archive_bot_training_game");
  const archiveEnd = schema.indexOf("revoke all on function public.archive_bot_training_game", archiveStart);
  const archiveFunction = schema.slice(archiveStart, archiveEnd);
  const triggerStart = schema.indexOf("create or replace function public.archive_finished_bot_training_game");
  const triggerEnd = schema.indexOf("drop trigger if exists rooms_archive_finished_bot_training", triggerStart);
  const triggerFunction = schema.slice(triggerStart, triggerEnd);

  assert.match(archiveFunction, /jsonb_array_length\(coalesce\(target_state->'analysis'->'botMemory'->'decisions'/);
  assert.match(
    archiveFunction,
    /coalesce\(p_final_state->'analysis'->'botMemory'->'decisions',[\s\S]*<> coalesce\(target_state->'analysis'->'botMemory'->'decisions'/,
  );
  assert.match(triggerFunction, /jsonb_array_length\(decisions\) = 0 then/);
  assert.match(triggerFunction, /decision_count, decisions, final_state/);
  assert.match(triggerFunction, /jsonb_array_length\(decisions\),\s*decisions,\s*target_state/);
});

test("anonymous room updates cannot mutate a registered hard-bot room", () => {
  const schema = fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8");
  const policyStart = schema.indexOf('create policy "anonymous guests can update guest rooms"');
  const policyEnd = schema.indexOf('drop policy if exists "authenticated users can join waiting rooms"', policyStart);
  const policy = schema.slice(policyStart, policyEnd);

  assert.match(policy, /host_user_id is not null/);
  assert.match(policy, /coalesce\(game_state->>'mode', game_state->'analysis'->>'mode', ''\) = 'bot'/);
  assert.match(policy, /host_user_id is null or guest_user_id is null/);
});

test("cached server experience is applied before a slow refresh RPC finishes", async () => {
  const localStorage = memoryStorage();
  const pattern = {
    creditVersion: 5,
    contextKey: "late-entry|h0|o1|po0|tr4|pd3",
    actionKey: "head:flat|entry:flat|trap:flat|freedom:flat|distribution:gain|support:keep|home:shuffle|off:no",
    samples: 5,
    losses: 5,
    severeLosses: 2,
    signalWeight: 20,
  };
  localStorage.setItem("narduh-long-bot-server-experience-v8", JSON.stringify({
    savedAt: Date.now(),
    playerKey: "warlord",
    creditVersion: 5,
    patterns: [pattern],
  }));
  const applied = [];
  const rpcCalls = [];
  const context = {
    window: {
      NarduApp: {
        getUser() { return { nickname: "warlord" }; },
      },
      NarduSupabase: {
        configured() { return true; },
        async client() {
          return {
            rpc(name, args) {
              rpcCalls.push({ name, args });
              return new Promise(() => {});
            },
          };
        },
      },
      NarduLongBotEngine: {
        setExperience(patterns, source) { applied.push({ patterns, source }); },
      },
    },
    localStorage,
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

  const loaded = await context.window.NarduRooms.loadLongBotExperience();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].contextKey, pattern.contextKey);
  const cachedApplication = applied.find(item => item.source === "server-cache" && item.patterns.length);
  assert.equal(cachedApplication.patterns[0].actionKey, pattern.actionKey);
  assert.ok(applied.some(item => item.source === "server" && item.patterns.length === 0));
  assert.equal(rpcCalls[0].name, "get_long_bot_experience_patterns");
  assert.equal(rpcCalls[0].args.p_player_name, "warlord");
});

test("long-bot experience rejects old RPC generations and caches only v26 data", async () => {
  async function loadWith(data) {
    const localStorage = memoryStorage();
    const applied = [];
    const context = {
      window: {
        NarduApp: { getUser() { return { nickname: "warlord" }; } },
        NarduSupabase: {
          configured() { return true; },
          async client() {
            return { async rpc() { return { data, error: null }; } };
          },
        },
        NarduLongBotEngine: {
          setExperience(patterns, source) { applied.push({ patterns, source }); },
        },
      },
      localStorage,
      console: { warn() {} },
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
    const loaded = await context.window.NarduRooms.loadLongBotExperience();
    return { localStorage, applied, loaded };
  }

  const oldPattern = {
    creditVersion: 4,
    contextKey: "route|old",
    actionKey: "route:0>0",
  };
  const oldResult = await loadWith([oldPattern]);
  assert.equal(oldResult.loaded.length, 0);
  assert.ok(oldResult.applied.some(item => item.source === "server" && item.patterns.length === 0));
  assert.ok(oldResult.applied.some(item => item.source === "server-cache" && item.patterns.length === 0));
  assert.equal(oldResult.applied.some(item => item.patterns.length > 0), false);
  assert.equal(oldResult.localStorage.getItem("narduh-long-bot-server-experience-v8"), null);

  const currentPattern = {
    creditVersion: 5,
    contextKey: "route|current",
    actionKey: "route:12>8",
  };
  const currentResult = await loadWith([currentPattern]);
  assert.equal(currentResult.loaded[0].actionKey, currentPattern.actionKey);
  assert.equal(currentResult.applied.at(-1).source, "server");
  const cached = JSON.parse(
    currentResult.localStorage.getItem("narduh-long-bot-server-experience-v8"),
  );
  assert.equal(cached.creditVersion, 5);
  assert.equal(cached.patterns[0].creditVersion, 5);
});

test("resolved long-bot experience is reapplied when browser storage is unavailable", async () => {
  const pattern = {
    creditVersion: 5,
    contextKey: "route|storage-unavailable",
    actionKey: "route:12>8",
  };
  const applied = [];
  let rpcCalls = 0;
  const context = {
    window: {
      NarduApp: { getUser() { return { nickname: "warlord" }; } },
      NarduSupabase: {
        configured() { return true; },
        async client() {
          return {
            async rpc() {
              rpcCalls += 1;
              return { data: [pattern], error: null };
            },
          };
        },
      },
      NarduLongBotEngine: {
        setExperience(patterns, source) { applied.push({ patterns, source }); },
      },
    },
    localStorage: {
      getItem() { throw new Error("storage unavailable"); },
      setItem() { throw new Error("storage unavailable"); },
      removeItem() { throw new Error("storage unavailable"); },
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

  await context.window.NarduRooms.loadLongBotExperience();
  await context.window.NarduRooms.loadLongBotExperience();

  assert.equal(rpcCalls, 1);
  const lastServerApplication = applied.filter(item => item.source === "server").at(-1);
  assert.equal(lastServerApplication.patterns[0].actionKey, pattern.actionKey);
});
