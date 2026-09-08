const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('v30 runtime advances every long-bot experience generation', () => {
  const browser = read('bot-engine/long/browser.ts');
  const strongBot = read('strong-bot.js');
  const roomsClient = read('rooms-client.js');
  const supabaseClient = read('supabase-client.js');

  assert.match(browser, /ENGINE_VERSION = 'long-analytic-v30'/);
  assert.match(browser, /frozen-experience-v30:/);
  assert.match(browser, /fingerprint: `lbe7-/);
  assert.match(strongBot, /EXPERIENCE_KEY = 'narduh-long-bot-experience-v7'/);
  assert.match(strongBot, /LONG_EXPERIENCE_CREDIT_VERSION = 7/);
  assert.match(roomsClient, /server-experience-v12/);
  assert.match(roomsClient, /LONG_BOT_EXPERIENCE_CREDIT_VERSION = 7/);
  assert.match(supabaseClient, /server-experience-v12/);
  assert.match(supabaseClient, /long-bot-experience-v7/);
});

test('v30 decision records retain distribution completeness telemetry', () => {
  const browser = read('bot-engine/long/browser.ts');
  [
    'distributionWeight',
    'distributionComplete',
    'recoveryTailRisk',
    'recoveryTailWeight',
    'recoveryWeight',
    'recoveryDistributionComplete',
    'continuationTailRisk',
    'continuationTailWeight',
    'continuationWeight',
    'continuationDistributionComplete',
  ].forEach(field => assert.match(browser, new RegExp(`${field}:`), field));
});

test('v30 aggregate keeps compatible v29 evidence and matches the schema', () => {
  const migration = read('supabase/long-bot-strategy-v30.sql');
  const schema = read('supabase/schema.sql');
  const rpcDefinition = /create or replace function public\.get_long_bot_experience_patterns\([\s\S]*?\n\$\$;/;
  const rpc = migration.match(rpcDefinition)?.[0] || '';

  assert.equal(rpc, schema.match(rpcDefinition)?.[0]);
  assert.match(rpc, /g\.engine_version in \('long-analytic-v29', 'long-analytic-v30'\)/);
  assert.match(rpc, /decision->>'engineVersion' = g\.engine_version/);
  assert.match(rpc, /when engine_generation = 30 then 4\.0/);
  assert.match(rpc, /when engine_generation = 29 then 3\.0/);
  assert.match(rpc, /engine_generation in \(29, 30\)/);
  assert.match(rpc, /'creditVersion', 7/);
});
