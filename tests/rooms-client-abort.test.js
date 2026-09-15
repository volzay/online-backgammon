const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const TEST_GUEST_PROOF = `gproof:${"31".repeat(32)}`;
const TEST_GUEST_ID = `guest:sha256:${createHash("sha256")
  .update(`nardu/guest/v1:${TEST_GUEST_PROOF}`)
  .digest("hex")}`;

function loadRooms({ configured, fetchImpl = fetch, client = null, user = null, dateImpl = Date }) {
  const currentUser = user || ({ id: TEST_GUEST_ID, name: "Guest1234", guest: true });
  const context = {
    window: {
      NarduSupabase: {
        configured: () => configured,
        client: async () => client,
      },
      NarduApp: {
        getUser: () => currentUser,
        guestRequestHeaders: () => currentUser.guest === true ? {
          "X-Guest-Id": TEST_GUEST_ID,
          "X-Guest-Proof": TEST_GUEST_PROOF,
        } : {},
        shouldShowRatingToOthers: () => true,
        ratingTierFor: () => "Bronze",
      },
      crypto: globalThis.crypto,
    },
    AbortController,
    console,
    Date: dateImpl,
    Error,
    Map,
    Promise,
    Set,
    TextEncoder,
    Uint8Array,
    fetch: fetchImpl,
  };
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "rooms-client.js"), "utf8"), context, {
    filename: "rooms-client.js",
  });
  return context.window.NarduRooms;
}

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() { return data; },
  };
}

test("API room reads, joins, presence, and spectator calls forward AbortSignal", async () => {
  const requests = [];
  const rooms = loadRooms({
    configured: false,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return jsonResponse({ ok: true, room: { code: "ABCD-EFGH" } });
    },
  });
  const controller = new AbortController();

  await rooms.getRoom("ABCD-EFGH", { signal: controller.signal });
  await rooms.joinRoom("ABCD-EFGH", { password: "secret" }, { signal: controller.signal });
  await rooms.updatePresence("ABCD-EFGH", { color: "dark" }, { signal: controller.signal });
  await rooms.watchRoom("ABCD-EFGH", { spectatorId: "viewer" }, { signal: controller.signal });
  await rooms.leaveSpectator("ABCD-EFGH", { spectatorId: "viewer" }, { signal: controller.signal });

  assert.equal(requests.length, 5);
  assert.ok(requests.every(request => request.options.signal === controller.signal));
  assert.deepEqual(requests.map(request => request.options.method || "GET"), ["GET", "POST", "POST", "POST", "DELETE"]);
  assert.ok(requests.every(request => request.options.headers["X-Guest-Id"] === TEST_GUEST_ID));
  assert.ok(requests.every(request => request.options.headers["X-Guest-Proof"] === TEST_GUEST_PROOF));
});

test("a pre-aborted join stops before the API mutation", async () => {
  let fetchCalls = 0;
  const rooms = loadRooms({
    configured: false,
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ ok: true });
    },
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    rooms.joinRoom("ABCD-EFGH", {}, { signal: controller.signal }),
    error => error?.name === "AbortError",
  );
  assert.equal(fetchCalls, 0);
});

function createRoomQueryClient({ abortBeforeFirstRead = null } = {}) {
  const operations = [];
  const waitingRoom = {
    id: "room-1",
    code: "ABCD-EFGH",
    status: "waiting",
    access: "open",
    host_name: "Host",
    host_guest_id: `guest:sha256:${"98".repeat(32)}`,
    guest_user_id: null,
    guest_guest_id: null,
    host_registered: false,
    guest_registered: false,
  };

  function from(table) {
    assert.equal(table, "rooms");
    const operation = { kind: "read", signal: null };
    operations.push(operation);
    const chain = {
      select() { return chain; },
      update(values) {
        operation.kind = "update";
        operation.values = values;
        return chain;
      },
      eq() { return chain; },
      neq() { return chain; },
      is() { return chain; },
      or() { return chain; },
      in() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      abortSignal(signal) {
        operation.signal = signal;
        return chain;
      },
      maybeSingle() {
        if (operation.kind === "read" && operations.length === 1 && abortBeforeFirstRead) {
          abortBeforeFirstRead.abort();
        }
        return Promise.resolve({
          data: operation.kind === "update"
            ? { ...waitingRoom, ...operation.values }
            : waitingRoom,
          error: null,
        });
      },
    };
    return chain;
  }

  return {
    client: {
      auth: { signOut: async () => ({ error: null }) },
      from,
    },
    operations,
  };
}

test("Supabase getRoom and joinRoom attach the signal to every room query", async () => {
  const { client, operations } = createRoomQueryClient();
  const rooms = loadRooms({ configured: true, client });
  const controller = new AbortController();

  await rooms.getRoom("ABCD-EFGH", { signal: controller.signal });
  await rooms.joinRoom("ABCD-EFGH", {}, { signal: controller.signal });

  assert.equal(operations.length, 4);
  assert.deepEqual(operations.map(operation => operation.kind), ["read", "read", "read", "update"]);
  assert.ok(operations.every(operation => operation.signal === controller.signal));
});

test("an abort after the Supabase room read prevents the join mutation", async () => {
  const controller = new AbortController();
  const { client, operations } = createRoomQueryClient({ abortBeforeFirstRead: controller });
  const rooms = loadRooms({ configured: true, client });

  await assert.rejects(
    rooms.joinRoom("ABCD-EFGH", {}, { signal: controller.signal }),
    error => error?.name === "AbortError",
  );
  assert.deepEqual(operations.map(operation => operation.kind), ["read"]);
});

test("profile heartbeats remain monotonic when an older request completes last", async () => {
  let nowMs = 1_000_000;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  }

  let storedLastSeen = null;
  let heartbeatCalls = 0;
  let releaseOlderHeartbeat;
  let markOlderHeartbeatStarted;
  const olderHeartbeatStarted = new Promise(resolve => { markOlderHeartbeatStarted = resolve; });
  const heartbeatFilters = [];

  const client = {
    auth: {
      getUser: async () => ({
        data: { user: { id: "player-1", email: "player@example.test", user_metadata: {} } },
        error: null,
      }),
    },
    from(table) {
      if (table === "profiles") {
        let operation = "read";
        let timestamp = null;
        let filter = null;
        const chain = {
          select() { return chain; },
          update(payload) {
            operation = "heartbeat";
            timestamp = payload.last_seen_at;
            return chain;
          },
          or(value) {
            filter = value;
            heartbeatFilters.push(value);
            return chain;
          },
          eq() {
            if (operation === "read") return chain;
            heartbeatCalls += 1;
            const applyConditionalUpdate = () => {
              const expectedFilter = `last_seen_at.is.null,last_seen_at.lt.${timestamp}`;
              assert.equal(filter, expectedFilter);
              if (!storedLastSeen || storedLastSeen < timestamp) storedLastSeen = timestamp;
              return { error: null };
            };
            if (heartbeatCalls === 1) {
              markOlderHeartbeatStarted();
              return new Promise(resolve => {
                releaseOlderHeartbeat = () => resolve(applyConditionalUpdate());
              });
            }
            return Promise.resolve(applyConditionalUpdate());
          },
          maybeSingle: async () => ({
            data: {
              id: "player-1",
              nickname: "ВащеППЦ",
              email: "player@example.test",
              rating: 1225,
              tier: "Silver",
              rating_eligible: true,
              banned_at: null,
              banned_reason: null,
            },
            error: null,
          }),
        };
        return chain;
      }

      assert.equal(table, "rooms");
      let operation = "find";
      let insertedRow = null;
      const chain = {
        select() { return chain; },
        or() { return chain; },
        in() { return chain; },
        order() { return chain; },
        limit: async () => ({ data: [], error: null }),
        insert(row) {
          operation = "insert";
          insertedRow = row;
          return chain;
        },
        single: async () => ({
          data: operation === "insert"
            ? { id: `room-${heartbeatCalls}`, created_at: new TestDate().toISOString(), ...insertedRow }
            : null,
          error: null,
        }),
      };
      return chain;
    },
  };
  const rooms = loadRooms({
    configured: true,
    client,
    dateImpl: TestDate,
    user: { id: "player-1", name: "ВащеППЦ", guest: false, rating: 1225 },
  });

  const olderRequest = rooms.createRoom({ variant: "long" });
  await olderHeartbeatStarted;

  nowMs += 31_000;
  await rooms.createRoom({ variant: "long" });
  const newestTimestamp = new TestDate(nowMs).toISOString();
  assert.equal(storedLastSeen, newestTimestamp);

  releaseOlderHeartbeat();
  await olderRequest;

  assert.equal(heartbeatCalls, 2);
  assert.equal(heartbeatFilters.length, 2);
  assert.equal(storedLastSeen, newestTimestamp, "the delayed older heartbeat must not roll presence back");
});
