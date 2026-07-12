const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const roomData = require(path.join(ROOT, "admin-room-data.js"));

test("admin preview uses the latest completed game without losing the live rematch", () => {
  const finishedHistory = Array.from({ length: 306 }, (_, index) => ({
    color: index % 2 ? "white" : "dark",
    from: 1,
    to: index < 15 ? "снято" : 2,
    die: 1,
  }));
  const room = {
    game_state: {
      phase: "move",
      winner: null,
      off: { white: 0, dark: 0 },
      history: [{ color: "white", roll: "2:6" }],
    },
    room_game_archives: [
      {
        completed_at: "2026-07-10T17:00:00Z",
        winner: "white",
        result_type: "mars",
        borne_off: { white: 15, dark: 0 },
        final_state: { winner: "white", resultType: "mars", off: { white: 15, dark: 0 }, history: [] },
      },
      {
        completed_at: "2026-07-10T19:15:00Z",
        winner: "dark",
        result_type: "normal",
        borne_off: { white: 7, dark: 15 },
        final_state: { winner: "dark", resultType: "normal", off: { white: 7, dark: 15 }, history: finishedHistory },
      },
    ],
  };

  const selected = roomData.displayedGame(room);
  assert.equal(selected.archived, true);
  assert.equal(selected.game.winner, "dark");
  assert.equal(selected.game.history.length, 306);
  assert.equal(selected.liveGame.history.length, 1);
  assert.deepEqual(roomData.borneOff(selected.game), { white: 7, dark: 15 });
});

test("borne-off totals can be reconstructed from the complete move history", () => {
  const game = {
    history: [
      { color: "white", to: "снято" },
      { color: "white", to: "borne-off" },
      { color: "dark", to: "снято" },
      { color: "dark", to: 4 },
    ],
  };
  assert.deepEqual(roomData.borneOff(game), { white: 2, dark: 1 });
});

test("admin preview recovers a finished bot game when the live room stopped at 14 checkers", () => {
  const history = Array.from({ length: 283 }, (_, index) => ({
    color: index === 282 ? "white" : (index % 2 ? "dark" : "white"),
    to: index === 282 ? "снято" : 4,
  }));
  const room = {
    game_state: {
      phase: "move",
      winner: null,
      off: { white: 14, dark: 0 },
      history: history.slice(0, -1),
    },
    room_game_archives: [],
    bot_training_games: [{
      id: "training-game",
      winner: "white",
      result_type: "koks",
      completed_at: "2026-07-11T18:28:08Z",
      final_state: {
        phase: "over",
        winner: "white",
        resultType: "koks",
        off: { white: 15, dark: 0 },
        history,
      },
    }],
  };

  const selected = roomData.displayedGame(room);
  assert.equal(selected.archived, true);
  assert.equal(selected.game.winner, "white");
  assert.equal(selected.game.resultType, "koks");
  assert.equal(selected.game.history.length, 283);
  assert.deepEqual(roomData.borneOff(selected.game), { white: 15, dark: 0 });
});

test("database schema archives every finished room state", () => {
  const schema = fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8");
  assert.match(schema, /create table if not exists public\.room_game_archives/);
  assert.match(schema, /create trigger on_room_game_finished/);
  assert.match(schema, /after insert or update of game_state on public\.rooms/);
  assert.match(schema, /'history', event\.history/);
  assert.match(schema, /create or replace function public\.record_rating_result/);
  assert.match(schema, /resolved_room_code text := upper/);
  assert.match(schema, /game_state = resolved_final_state/);
  assert.match(schema, /status = 'over'/);
  assert.match(schema, /game_state = target_state/);
  assert.match(schema, /target_room\.game_state->>'startedAt' = target_state->>'startedAt'/);
  assert.match(schema, /resolved_result_key := concat\(/);
});

test("admin history auto-refresh pauses while the operator is scrolling", () => {
  const source = fs.readFileSync(path.join(ROOT, "homegate.js"), "utf8");
  assert.match(source, /adminScrollInteractionUntil = Date\.now\(\) \+ 8000/);
  assert.match(source, /Date\.now\(\) < adminScrollInteractionUntil/);
  assert.match(source, /autoRefreshInFlight/);
  assert.match(source, /Timeweb мониторинг/);
});

test("rating client persists a result through the atomic server RPC", () => {
  const source = fs.readFileSync(path.join(ROOT, "rating.js"), "utf8");
  assert.match(source, /client\.rpc\('record_rating_result'/);
  assert.match(source, /syncPromise/);
  assert.match(source, /delta:\s*Number\(result\?\.delta/);
  assert.match(source, /rating:\s*user\.rating/);
});

test("game-over modal refreshes from the authoritative Timeweb rating result", () => {
  const source = fs.readFileSync(path.join(ROOT, "game-controller.js"), "utf8");
  assert.match(source, /if \(r\) \{[\s\S]*localRatingRecordedKey = resultKey/);
  assert.match(source, /Promise\.resolve\(r\.syncPromise\)[\s\S]*authoritative/);
  assert.match(source, /lastRatingResult = \{[\s\S]*authoritative\.delta[\s\S]*authoritative\.rating/);
  assert.match(source, /renderGameOverModal\(\)/);
  assert.match(source, /ratingRetryCount < 3/);
  assert.match(source, /ensureBotFinalStatePublished/);
  assert.match(source, /archiveBotTrainingGame\(botFinalPayload\)/);
  assert.match(source, /waitForFinalPersistence/);
  assert.match(source, /setTimeout\(\(\) => resolve\(false\), 15000\)/);
});
