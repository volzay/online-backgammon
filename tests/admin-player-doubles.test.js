const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const roomData = require("../admin-room-data.js");
const source = fs.readFileSync(path.join(__dirname, "../homegate.js"), "utf8");

function runtime() {
  const context = vm.createContext({
    document: { querySelector: () => ({}), documentElement: { setAttribute() {} } },
    localStorage: { getItem: () => null, setItem() {} },
    window: { NarduAdminRoomData: roomData },
  });
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener("submit"')), context);
  return context;
}

// A synthetic20+20 trace with the same totals as the checked PJ66-KUTE game.
function history() {
  return ["white", "dark"].flatMap(color => Array.from({ length: 20 }, (_, i) => ({
    color, roll: i < (color === "white" ? 3 : 8) ? "6:6" : "2:3",
  })));
}

test("each participant's doubles count physical rolls once, not moves or expanded dice", () => {
  const stats = roomData.rollStats({ history: [
    ...history(),
    { color: "dark", opening: true, roll: "6:6" },
    { color: "white", roll: "1:1", fairDiceProof: { request: { label: "opening" } } },
    { color: "white", roll: "0:0" }, { color: "dark", roll: "6:6:6:6" },
    { color: "none", roll: "6:6" },
    ...Array.from({ length: 4 }, () => ({ color: "dark", from: 12, to: 6, die: 6 })),
  ] });
  assert.deepEqual(stats.byColor, {
    white: { rolls: 20, doubles: 3, doubleRate: 0.15 },
    dark: { rolls: 20, doubles: 8, doubleRate: 0.4 },
  });
  assert.equal(stats.rolls, 40);
  assert.equal(stats.doubles, 11);
});

test("a duplicated signed request is counted once; legitimate repeated doubles are separate rolls", () => {
  const event = { color: "dark", roll: "4:4", fairDiceProof: { request: { id: "same-request" } } };
  const stats = roomData.rollStats({ history: [event, { ...event },
    { color: "white", roll: "5:5" }, { color: "white", roll: "5:5" }] });
  assert.equal(stats.byColor.dark.doubles, 1);
  assert.equal(stats.byColor.white.doubles, 2);
});

test("missing or compacted finished history is unavailable, while an empty new game has zero rolls", () => {
  assert.equal(roomData.rollStats(null).historyAvailable, false);
  assert.equal(roomData.rollStats({ winner: "dark", history: [] }).historyAvailable, false);
  assert.equal(roomData.rollStats({ history: [] }).historyAvailable, true);
  const context = runtime();
  assert.equal(context.doubleText({ historyAvailable: false }), "Нет данных о бросках");
  assert.match(context.playerDoubleRows({}), /Нет данных о бросках/);
});

test("a compact training copy does not hide the full archive of the same game or mix in a rematch", () => {
  const final = { winner: "white", finishedAt: "2026-11-18T10:00:00Z", history: history() };
  const room = {
    game_state: { history: [{ color: "dark", roll: "1:1" }] },
    room_game_archives: [{ winner: "white", final_state: final, completed_at: final.finishedAt }],
    bot_training_games: [{ winner: "white", final_state: { ...final, history: [] }, completed_at: "2026-11-18T10:00:01Z" }],
  };
  const selected = roomData.displayedGame(room);
  assert.equal(selected.archived, true);
  assert.deepEqual(roomData.rollStats(selected.game).byColor.dark, { rolls: 20, doubles: 8, doubleRate: 0.4 });
  room.bot_training_games.push({ winner: "dark", final_state: { winner: "dark", finishedAt: "2026-11-18T11:00:00Z", history: [] }, completed_at: "2026-11-18T11:00:01Z" });
  assert.equal(roomData.displayedGame(room).game.winner, "dark");
  assert.equal(roomData.rollStats(roomData.displayedGame(room).game).historyAvailable, false);
});

test("archive, monitor, detail and copied report show a named line for each color", () => {
  const context = runtime();
  const room = { id: "synthetic-room", archiveId: "synthetic-room", code: "DEMO-ABCD", source: "archive", status: "over", variant: "short",
    players: [{ name: "Игрок", color: "white" }, { name: "Бот сложный", color: "dark" }],
    ...roomData.rollStats({ history: history() }) };
  context.room = room;
  vm.runInContext('state.archive = [room]; state.watch = ["archive:synthetic-room"]; state.detail = { summary: room, session: { game: { history: [] } } };', context);
  for (const html of [context.roomCard(room), context.monitorCard("archive:synthetic-room"), context.detailHtml()]) {
    assert.match(html, /Дубли — Игрок \(белые\)/);
    assert.match(html, /3\/20 \(15%\)/);
    assert.match(html, /Дубли — Бот сложный \(тёмные\)/);
    assert.match(html, /8\/20 \(40%\)/);
  }
  assert.match(context.gameProtocolText(), /Дубли — Бот сложный \(тёмные\): 8\/20 \(40%\)/);
  const unsafe = { ...room, players: [{ name: '<img src=x onerror="bad()">', color: "white" }] };
  assert.ok(!context.playerDoubleRows(unsafe).includes("<img"));
});

test("bot games assign totals to actual colors including a dark human", () => {
  const context = runtime();
  const raw = { id: "synthetic", host_name: "Игрок", guest_name: "Бот сложный", game_state: {
    mode: "bot", analysis: { playerColor: "dark" }, history: history(), winner: "dark",
  } };
  const summary = context.supabaseRoomSummary(raw);
  assert.equal(summary.players.find(p => p.name === "Игрок").color, "dark");
  assert.match(context.playerDoubleRows(summary), /Дубли — Игрок \(тёмные\).*8\/20 \(40%\)/);
  const humanMatch = context.supabasePlayersForRoom({ host_name: "Хозяин", guest_name: "Гость" }, {});
  assert.equal(humanMatch[0].color, "white");
  assert.equal(humanMatch[1].color, "dark");
  delete raw.game_state.analysis.playerColor;
  raw.game_state.analysis.botMemory = { outcome: { botColor: "white" } };
  assert.equal(context.supabaseRoomSummary(raw).players[0].color, "dark");
  delete raw.game_state.analysis.botMemory;
  assert.equal(context.supabasePlayersForRoom(raw, raw.game_state, {}, "white")[0].color, "dark");
});

test("collection polling gets per-room counts in bounded batches, never full histories", async () => {
  const context = runtime();
  const rooms = Array.from({ length: 501 }, (_, i) => ({ id: `room-${i}` }));
  const calls = [];
  const decorate = await context.loadRoomRollStats({ rpc: async (name, args) => {
    calls.push({ name, ids: args.p_room_ids });
    return { data: args.p_room_ids.map(roomId => ({ roomId, historyAvailable: true,
      ...roomData.rollStats({ history: history() }), playerColor: "dark" })) };
  } }, [...rooms, rooms[0]]);
  assert.deepEqual(calls.map(call => call.ids.length), [500, 1]);
  assert.equal(calls[0].name, "admin_room_roll_stats");
  const room = decorate({ ...rooms[0], host_name: "Игрок", guest_name: "Бот сложный" });
  const summary = context.supabaseRoomSummary(room);
  assert.equal(summary.rolls, 40);
  assert.equal(summary.byColor.dark.doubles, 8);
  assert.equal(summary.players[0].color, "dark");
  let cachedCalls = 0;
  const cachedClient = { rpc: async () => { cachedCalls++; return { data: [] }; } };
  await context.loadRoomRollStats(cachedClient, rooms);
  assert.equal(cachedCalls, 0, "unchanged archives do not get rescanned every five seconds");
  await context.loadRoomRollStats(cachedClient, [{ ...rooms[0], game_version: 2 }]);
  assert.equal(cachedCalls, 1, "a new game version refreshes its counters");
});

test("a missing aggregate RPC keeps the archive usable and shows unknown counts", async () => {
  const context = runtime();
  const raw = { id: "synthetic-room", host_name: "Игрок", guest_name: "Бот сложный" };
  const decorate = await context.loadRoomRollStats({ rpc: async () => ({ error: { message: "missing" } }) }, [raw]);
  const summary = context.supabaseRoomSummary(decorate(raw));
  assert.match(context.playerDoubleRows(summary), /Нет данных о бросках/);
});
