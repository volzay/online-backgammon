const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('v33 runtime advances every long-bot experience generation', () => {
  const browser = read('bot-engine/long/browser.ts');
  const strongBot = read('strong-bot.js');
  const roomsClient = read('rooms-client.js');
  const supabaseClient = read('supabase-client.js');

  assert.match(browser, /ENGINE_VERSION = 'long-analytic-v33'/);
  assert.match(browser, /frozen-experience-v33:/);
  assert.match(browser, /frozen-experience-v32:/);
  assert.match(browser, /fingerprint: `lbe8-/);
  assert.match(strongBot, /EXPERIENCE_KEY = 'narduh-long-bot-experience-v8'/);
  assert.match(strongBot, /LONG_EXPERIENCE_CREDIT_VERSION = 8/);
  assert.match(strongBot, /LEGACY_LONG_EXPERIENCE_KEYS = \[\s*'narduh-long-bot-experience-v7'/);
  assert.match(roomsClient, /server-experience-v15/);
  assert.match(roomsClient, /LONG_BOT_EXPERIENCE_CREDIT_VERSION = 8/);
  assert.match(roomsClient, /LONG_BOT_EXPERIENCE_CACHE_MAX_AGE_MS = 60 \* 60 \* 1000/);
  assert.match(supabaseClient, /server-experience-v15/);
  assert.match(supabaseClient, /long-bot-experience-v8/);
});

test('v33 decision records retain distribution and prospective-fence telemetry', () => {
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

test('v33 aggregate keeps compatible v29-v32 evidence and matches the schema', () => {
  const migration = read('supabase/long-bot-strategy-v33.sql');
  const schema = read('supabase/schema.sql');
  const rpcDefinition = /create or replace function public\.get_long_bot_experience_patterns\([\s\S]*?\n\$\$;/;
  const rpc = migration.match(rpcDefinition)?.[0] || '';

  assert.equal(rpc, schema.match(rpcDefinition)?.[0]);
  assert.ok((migration.match(/long-analytic-v33/g) || []).length >= 4);
  assert.match(rpc, /g\.engine_version in \('long-analytic-v29', 'long-analytic-v30', 'long-analytic-v31', 'long-analytic-v32', 'long-analytic-v33'\)/);
  assert.match(rpc, /decision->>'engineVersion' = g\.engine_version/);
  assert.match(rpc, /when engine_generation = 33 then 7\.0/);
  assert.match(rpc, /when engine_generation = 32 then 6\.0/);
  assert.match(rpc, /when engine_generation = 31 then 5\.0/);
  assert.match(rpc, /when engine_generation = 30 then 4\.0/);
  assert.match(rpc, /when engine_generation = 29 then 3\.0/);
  assert.match(rpc, /engine_generation in \(29, 30, 31, 32, 33\)/);
  assert.match(rpc, /features->'avoidableProspectiveFenceInterruptionBreak'/);
  assert.match(
    rpc,
    /features->'avoidableProspectiveFenceAnchorMiss'\), 0\) \/ 18/,
  );
  assert.doesNotMatch(rpc, /features->'prospectiveFenceInterruptionBreak'/);
  assert.doesNotMatch(rpc, /features->'prospectiveFenceExtensionDelta'/);
  assert.match(rpc, /descriptor->'behaviorActionKeys'->>2/);
  assert.match(rpc, /'creditVersion', 8/);
  assert.match(rpc, /outcome-weighted evidence, not causal per-move attribution/);
});
