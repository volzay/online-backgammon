const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

test("lobby closes only the active room codes captured before navigation", async () => {
  const operations = [];

  function query(table) {
    const operation = { table, filters: [] };
    operations.push(operation);
    const chain = {
      select(columns) {
        operation.select = columns;
        return chain;
      },
      update(values) {
        operation.update = values;
        return chain;
      },
      eq(column, value) {
        operation.filters.push(["eq", column, value]);
        return chain;
      },
      in(column, value) {
        operation.filters.push(["in", column, value]);
        return chain;
      },
      is(column, value) {
        operation.filters.push(["is", column, value]);
        return chain;
      },
      or(value) {
        operation.filters.push(["or", value]);
        return chain;
      },
      maybeSingle() {
        if (table === "profiles") {
          return Promise.resolve({
            data: {
              id: "user-1",
              nickname: "tester1",
              rating: 1360,
              rating_eligible: true,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve) {
        const result = table === "rooms" && operation.update
          ? { data: [{ code: "ABCD-EFGH" }, { code: "JKLM-NPQR" }], error: null }
          : { data: null, error: null };
        return Promise.resolve(result).then(resolve);
      },
    };
    return chain;
  }

  const client = {
    auth: {
      getSession: async () => ({
        data: { session: null },
        error: null,
      }),
      refreshSession: async () => ({
        data: { session: { user: { id: "user-1" } } },
        error: null,
      }),
      getUser: async () => ({
        data: {
          user: {
            id: "user-1",
            email: "tester@example.com",
            user_metadata: { nickname: "tester1" },
          },
        },
        error: null,
      }),
    },
    from: query,
    rpc(name, args) {
      const operation = { rpc: name, args };
      operations.push(operation);
      const result = {
        data: {
          ok: true,
          removed: true,
          closed: true,
          code: args.p_room_code,
        },
        error: null,
      };
      return {
        abortSignal(signal) { operation.signal = signal; return this; },
        then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
      };
    },
  };
  const context = {
    window: {
      NarduSupabase: {
        configured: () => true,
        client: async () => client,
      },
      NarduApp: {
        getUser: () => ({
          id: "user-1",
          name: "tester1",
          rating: 1360,
          ratingEligible: true,
          guest: false,
        }),
        shouldShowRatingToOthers: () => true,
        ratingTierFor: () => "Silver",
      },
      crypto: globalThis.crypto,
    },
    console,
    Date,
    Map,
    Set,
    TextEncoder,
    Uint8Array,
    fetch,
  };
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "rooms-client.js"), "utf8"), context, {
    filename: "rooms-client.js",
  });

  const result = await context.window.NarduRooms.closeOwnLobbyRooms({
    codes: ["ABCD-EFGH", "JKLM-NPQR"],
  });
  assert.deepEqual(Array.from(result.closedCodes), ["ABCD-EFGH", "JKLM-NPQR"]);
  const closeOperations = operations.filter(item => item.rpc === "close_own_waiting_room");
  assert.deepEqual(closeOperations.map(item => ({ ...item.args })), [
    { p_room_code: "ABCD-EFGH" },
    { p_room_code: "JKLM-NPQR" },
  ]);
  assert.equal(
    operations.some(item => item.table === "rooms" && item.update),
    false,
    "lobby cleanup must not use the RLS-rejected terminal update",
  );
});

test("room creation has client and database duplicate protection", () => {
  const lobby = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const schema = fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8");

  assert.match(lobby, /if \(createRequestPending \|\| joinRequestPending\) return;/);
  assert.match(lobby, /createSubmit\.disabled = true;/);
  assert.match(lobby, /lobbyCleanupPromise = closeOwnRoomsOnLobbyEntry\(\)/);
  assert.match(lobby, /runLobbyCleanup\(\);/);
  assert.match(lobby, /async function ensureLobbyCleanup\(\)/);
  assert.match(lobby, /const cleanup = await ensureLobbyCleanup\(\);/);
  const tableClickStart = lobby.indexOf("document.getElementById('tables-list').addEventListener('click'");
  const participantReturn = lobby.indexOf('if (room && isRoomParticipant(room))', tableClickStart);
  const joinCleanup = lobby.indexOf('const cleanup = await ensureLobbyCleanup();', participantReturn);
  assert.ok(tableClickStart >= 0 && participantReturn > tableClickStart);
  assert.ok(joinCleanup > participantReturn, 'returning to an owned room must bypass destructive cleanup');
  assert.match(lobby, /data-close-room=/);
  assert.match(lobby, /closeWaitingRoomWithTimeout\(code\)/);
  assert.match(lobby, /if \(a === 'browse'\) \{\s+await ensureLobbyCleanup\(\);/);
  assert.match(lobby, /a === 'bot'[\s\S]*createState\.opponent = 'bot';[\s\S]*showCreatePanel\(\)/);
  assert.match(lobby, /if \(joinRequestPending \|\| createRequestPending\) return/);
  assert.match(lobby, /joinRequestPending = false;/);
  assert.match(lobby, /window\.addEventListener\('pageshow', event => \{/);
  assert.match(lobby, /if \(!event\.persisted\) return;/);
  assert.match(lobby, /redirectForRoomAuthError\(err\)/);
  assert.match(schema, /rooms_one_waiting_room_per_host_idx/);
  assert.match(schema, /rooms_one_active_room_per_host_idx/);
  assert.match(schema, /rooms_one_active_room_per_guest_idx/);
  assert.match(schema, /private\.active_room_players/);
  assert.match(schema, /rooms_enforce_single_active_room_per_player_trg/);
  assert.match(schema, /create or replace function public\.close_own_waiting_room\(p_room_code text\)/);
  assert.match(schema, /create or replace function public\.close_own_lobby_rooms\(\)/);
  assert.match(schema, /closed_reason = 'lobby_exit_unfinished'/);
  assert.doesNotMatch(schema, /closed_reason = 'lobby_exit_forfeit'/);
  assert.match(schema, /status in \('waiting', 'joined'\)/);
  assert.match(schema, /where host_user_id is not null\s+and guest_user_id is null\s+and status = 'waiting'/);
});

test("leaving joined or finished rooms never falls back to an unsafe generic delete", async () => {
  const roomPage = fs.readFileSync(path.join(ROOT, "room.html"), "utf8");
  const removeStart = roomPage.indexOf("async function removeCurrentWaitingRoom()");
  const removeEnd = roomPage.indexOf("function isActiveRemoteRoom()", removeStart);
  const removeCurrentRoom = roomPage.slice(removeStart, removeEnd);
  assert.match(removeCurrentRoom, /const mode = roomUrl\.searchParams\.get\('mode'\)[\s\S]*mode === 'bot'[\s\S]*NarduRooms\.closeBotRoom\(targetRoomCode\)/);
  assert.doesNotMatch(removeCurrentRoom, /NarduRooms\.deleteRoom\(roomCode\)/);
  assert.match(removeCurrentRoom, /clearCurrentRoomStorage\(targetRoomCode\);[\s\S]*return true/);

  let fetchCalls = 0;
  const context = {
    window: {
      NarduSupabase: { configured: () => false },
      NarduApp: {
        getUser: () => ({ id: "user-1", name: "Tester", guest: false }),
        guestRequestHeaders: () => ({}),
        shouldShowRatingToOthers: () => true,
        ratingTierFor: () => "Bronze",
      },
      crypto: globalThis.crypto,
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
    Date,
    Map,
    Set,
    TextEncoder,
    Uint8Array,
    AbortController,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("generic delete reached transport");
    },
  };
  context.window.window = context.window;
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "rooms-client.js"), "utf8"), context, {
    filename: "rooms-client.js",
  });

  await assert.rejects(
    context.window.NarduRooms.deleteRoom("ABCD-EFGH"),
    error => error?.status === 400,
  );
  assert.equal(fetchCalls, 0);
});

test("join-by-code accepts the complete current room code", () => {
  const lobby = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const roomsClient = fs.readFileSync(path.join(ROOT, "rooms-client.js"), "utf8");

  assert.match(
    lobby,
    /id="join-code"[^>]*maxlength="9"[^>]*placeholder="Например: ABCD-EFGH"/,
  );
  assert.match(app, /room_code_ph: 'Например: ABCD-EFGH'/);
  assert.match(app, /room_code_ph: 'For example: ABCD-EFGH'/);
  assert.match(roomsClient, /new Uint8Array\(8\)/);
  assert.match(roomsClient, /return `\$\{code\.slice\(0, 4\)\}-\$\{code\.slice\(4\)\}`/);
});

test("a registered profile without a Supabase session receives a normalized re-login error", async () => {
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      refreshSession: async () => ({ data: { session: null }, error: { message: "Auth session missing!" } }),
      getUser: async () => ({ data: { user: null }, error: { message: "Auth session missing!" } }),
    },
  };
  const context = {
    window: {
      NarduSupabase: { configured: () => true, client: async () => client },
      NarduApp: {
        getUser: () => ({ id: "user-1", name: "warlord", guest: false }),
        shouldShowRatingToOthers: () => true,
        ratingTierFor: () => "Gold",
      },
      crypto: globalThis.crypto,
    },
    console,
    Date,
    Map,
    Set,
    TextEncoder,
    Uint8Array,
    fetch,
  };
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "rooms-client.js"), "utf8"), context, { filename: "rooms-client.js" });

  await assert.rejects(
    context.window.NarduRooms.createRoom({ variant: "long" }),
    error => error.code === "AUTH_SESSION_MISSING" && error.status === 401 && /Войдите/.test(error.message),
  );
});

test("API fallback creates the bot analysis room before publishing moves", async () => {
  const requests = [];
  const context = {
    window: {
      NarduSupabase: { configured: () => false },
      NarduApp: {
        getUser: () => ({
          id: "api-user-1",
          name: "ApiPlayer",
          rating: 1440,
          ratingEligible: true,
          guest: false,
        }),
        shouldShowRatingToOthers: () => true,
        ratingTierFor: () => "Silver",
      },
      crypto: globalThis.crypto,
    },
    console,
    Date,
    Map,
    Set,
    TextEncoder,
    Uint8Array,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return {
        ok: true,
        async json() { return { ok: true, version: 0 }; },
      };
    },
  };
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "rooms-client.js"), "utf8"), context, {
    filename: "rooms-client.js",
  });

  const result = await context.window.NarduRooms.ensureBotAnalysisRoom({
    code: "BRTX-2233",
    variant: "long",
    botName: "Hard bot",
    botRating: 1500,
    difficulty: "hard",
    playerColor: "white",
    state: { phase: "opening", points: {} },
  });

  assert.equal(result.version, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/rooms/bot-analysis");
  assert.equal(requests[0].options.method, "POST");
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.code, "BRTX-2233");
  assert.equal(body.hostName, "ApiPlayer");
  assert.equal(body.hostUserId, "api-user-1");
  assert.match(body.ownerToken, /^[a-f0-9]{64}$/);
  assert.equal(body.state.mode, "bot");
  assert.equal(body.state.analysis.difficulty, "hard");
});
