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
  const closeOperation = operations.find(item => item.table === "rooms" && item.update);
  assert.ok(closeOperation);
  assert.deepEqual(closeOperation.filters.map(item => [item[0], item[1], Array.isArray(item[2]) ? Array.from(item[2]) : item[2]]), [
    ["eq", "host_user_id", "user-1"],
    ["in", "code", ["ABCD-EFGH", "JKLM-NPQR"]],
    ["in", "status", ["waiting", "joined"]],
  ]);
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
  assert.match(lobby, /if \(e\.target\.closest\('\[data-room-password-input\]'\)\) return;\s+if \(createRequestPending \|\| joinRequestPending\) return;\s+const actionGeneration = beginLobbyAction\(\);\s+const cleanup = await ensureLobbyCleanup\(\);/);
  assert.match(lobby, /if \(a === 'browse'\) \{\s+await ensureLobbyCleanup\(\);/);
  assert.match(lobby, /a === 'bot'[\s\S]*createState\.opponent = 'bot';[\s\S]*showCreatePanel\(\)/);
  assert.match(lobby, /if \(joinRequestPending \|\| createRequestPending\) return/);
  assert.match(lobby, /joinRequestPending = false;/);
  assert.match(lobby, /window\.addEventListener\('pageshow', event => \{/);
  assert.match(lobby, /if \(!event\.persisted\) return;/);
  assert.match(lobby, /redirectForRoomAuthError\(err\)/);
  assert.match(schema, /rooms_one_waiting_room_per_host_idx/);
  assert.match(schema, /create or replace function public\.close_own_lobby_rooms\(\)/);
  assert.match(schema, /closed_reason = 'lobby_exit_unfinished'/);
  assert.doesNotMatch(schema, /closed_reason = 'lobby_exit_forfeit'/);
  assert.match(schema, /status in \('waiting', 'joined'\)/);
  assert.match(schema, /where host_user_id is not null\s+and guest_user_id is null\s+and status = 'waiting'/);
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
