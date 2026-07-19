const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const EXPERIENCE_KEY = "narduh-long-bot-experience-v1";

function learnSingleLoss(resultType) {
  const values = new Map();
  const localStorage = {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
  const context = {
    window: {
      localStorage,
      NarduLongBotEngine: { setExperience() {} },
    },
    console,
    Date,
    Math,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "strong-bot.js"), "utf8"),
    context,
    { filename: "strong-bot.js" },
  );

  context.window.NarduStrongBot.learnFromGame({
    winner: "white",
    resultType,
    analysis: {
      botMemory: {
        decisions: [{
          experience: {
            contextKey: "koks-rescue|test",
            actionKey: "start:stuck",
            mistakeSeverity: 1.25,
          },
        }],
      },
    },
  }, "dark");

  return JSON.parse(values.get(EXPERIENCE_KEY))[0];
}

test("local hard-bot learning prices Koks above Mars", () => {
  const normal = learnSingleLoss("normal");
  const mars = learnSingleLoss("mars");
  const koks = learnSingleLoss("koks");

  assert.equal(normal.losses, 1);
  assert.equal(mars.severeLosses, 1);
  assert.equal(koks.severeLosses, 1);
  assert.ok(normal.lossWeight > 0);
  assert.ok(mars.lossWeight > normal.lossWeight);
  assert.ok(koks.lossWeight > mars.lossWeight);
  assert.ok(Math.abs((koks.lossWeight - mars.lossWeight) - 0.75) < 1e-9);
});

test("the v17 opponent-memory RPC preserves Koks severity ordering", () => {
  const schema = fs.readFileSync(path.join(ROOT, "supabase/schema.sql"), "utf8");
  const severityMigration = fs.readFileSync(
    path.join(ROOT, "supabase/long-bot-result-severity-v15.sql"),
    "utf8",
  );
  const migration = fs.readFileSync(
    path.join(ROOT, "supabase/long-bot-opponent-memory-v17.sql"),
    "utf8",
  );
  const severityOrder = /when result_type = 'koks' then 1\.5\s+when result_type = 'mars' then 0\.75/;
  const rpcDefinition = /create or replace function public\.get_long_bot_experience_patterns\([\s\S]*?\n\$\$;/;

  assert.match(schema, severityOrder);
  assert.match(severityMigration, severityOrder);
  assert.match(migration, severityOrder);
  assert.equal(migration.match(rpcDefinition)?.[0], schema.match(rpcDefinition)?.[0]);
  assert.match(migration, /^begin;/m);
  assert.match(migration, /p_player_name text default null/);
  assert.match(migration, /then 3\s+else 1\s+end as player_weight/);
  assert.match(migration, /^commit;/m);
});

test("production entry points cache-bust every v19 bot dependency", () => {
  const room = fs.readFileSync(path.join(ROOT, "room.html"), "utf8");
  const lobby = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const version = "20260719-deterministic-strategy-v19";

  assert.match(room, new RegExp(`long-bot-engine\\.js\\?v=${version}`));
  assert.match(room, new RegExp(`strong-bot\\.js\\?v=${version}`));
  assert.match(room, new RegExp(`rooms-client\\.js\\?v=${version}`));
  assert.match(room, new RegExp(`supabase-client\\.js\\?v=${version}`));
  assert.match(lobby, new RegExp(`rooms-client\\.js\\?v=${version}`));
  assert.match(lobby, new RegExp(`supabase-client\\.js\\?v=${version}`));
});
