const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

test("lobby atomically closes every active room owned by the authenticated player", async () => {
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
      is(column, value) {
        operation.filters.push(["is", column, value]);
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
    rpc: async name => {
      assert.equal(name, "close_own_lobby_rooms");
      return { data: ["ABCD-EFGH", "JKLM-NPQR"], error: null };
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

  const result = await context.window.NarduRooms.closeOwnLobbyRooms();
  assert.deepEqual(Array.from(result.closedCodes), ["ABCD-EFGH", "JKLM-NPQR"]);
  assert.equal(operations.some(item => item.table === "rooms" && item.update), false);
});

test("room creation has client and database duplicate protection", () => {
  const lobby = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const schema = fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8");

  assert.match(lobby, /if \(createRequestPending\) return;/);
  assert.match(lobby, /createSubmit\.disabled = true;/);
  assert.match(lobby, /lobbyCleanupPromise = closeOwnRoomsOnLobbyEntry\(\)/);
  assert.match(lobby, /runLobbyCleanup\(\);/);
  assert.match(lobby, /const cleanup = await lobbyCleanupPromise;/);
  assert.match(lobby, /if \(e\.target\.closest\('\[data-room-password-input\]'\)\) return;\s+const cleanup = await lobbyCleanupPromise;/);
  assert.match(lobby, /if \(a === 'quick'\) \{\s+const cleanup = await lobbyCleanupPromise;/);
  assert.match(lobby, /if \(joinRequestPending\) return/);
  assert.match(lobby, /joinRequestPending = false;/);
  assert.match(lobby, /window\.addEventListener\('pageshow', event => \{/);
  assert.match(lobby, /if \(!event\.persisted\) return;/);
  assert.match(lobby, /redirectForRoomAuthError\(err\)/);
  assert.match(schema, /rooms_one_waiting_room_per_host_idx/);
  assert.match(schema, /create or replace function public\.close_own_lobby_rooms\(\)/);
  assert.match(schema, /status in \('waiting', 'joined'\)/);
  assert.match(schema, /where host_user_id is not null\s+and guest_user_id is null\s+and status = 'waiting'/);
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
