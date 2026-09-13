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
  assert.match(roomsClient, /LONG_BOT_EXPERIENCE_CACHE_MAX_AGE_MS = 10 \* 60 \* 1000/);
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
  const builderDefinition = /create or replace function private\.compute_long_bot_experience_patterns\([\s\S]*?\n\$\$;/;
  const builder = migration.match(builderDefinition)?.[0] || '';

  assert.equal(builder, schema.match(builderDefinition)?.[0]);
  assert.ok((migration.match(/long-analytic-v33/g) || []).length >= 4);
  assert.match(builder, /g\.engine_version in \('long-analytic-v29', 'long-analytic-v30', 'long-analytic-v31', 'long-analytic-v32', 'long-analytic-v33'\)/);
  assert.match(builder, /decision->>'engineVersion' = g\.engine_version/);
  assert.match(builder, /when engine_generation = 33 then 7\.0/);
  assert.match(builder, /when engine_generation = 32 then 6\.0/);
  assert.match(builder, /when engine_generation = 31 then 5\.0/);
  assert.match(builder, /when engine_generation = 30 then 4\.0/);
  assert.match(builder, /when engine_generation = 29 then 3\.0/);
  assert.match(builder, /engine_generation in \(29, 30, 31, 32, 33\)/);
  assert.match(builder, /features->'avoidableProspectiveFenceInterruptionBreak'/);
  assert.match(
    builder,
    /features->'avoidableProspectiveFenceAnchorMiss'\), 0\) \/ 18/,
  );
  assert.doesNotMatch(builder, /features->'prospectiveFenceInterruptionBreak'/);
  assert.doesNotMatch(builder, /features->'prospectiveFenceExtensionDelta'/);
  assert.match(builder, /descriptor->'behaviorActionKeys'->>2/);
  assert.match(builder, /'creditVersion', 8/);
  assert.match(builder, /outcome-weighted evidence, not causal per-move attribution/);
});

test('v33 background builder combines integrity checks before its scoring expansion', () => {
  const migration = read('supabase/long-bot-strategy-v33.sql');
  const builderDefinition = /create or replace function private\.compute_long_bot_experience_patterns\([\s\S]*?\n\$\$;/;
  const builder = migration.match(builderDefinition)?.[0] || '';

  assert.equal((builder.match(/jsonb_array_elements\(/g) || []).length, 2);
  assert.match(builder, /with valid_games as \(/);
  assert.doesNotMatch(builder, /materialized|windowed/);
  assert.match(builder, /cross join lateral \(\s*select[\s\S]*?as covered_bot_decisions/);
  assert.match(builder, /as incompatible_decisions/);
  assert.match(builder, /as engine_fingerprints/);
  assert.match(builder, /integrity\.incompatible_decisions = 0/);
  assert.match(builder, /integrity\.engine_fingerprints <= 1/);
  assert.match(builder, /from valid_games g\s+cross join lateral jsonb_array_elements/);
});

test('v33 serves a private stale-while-refresh cache outside the game-finalization path', () => {
  const migration = read('supabase/long-bot-strategy-v33.sql');
  const schema = read('supabase/schema.sql');
  const getterDefinition = /create or replace function public\.get_long_bot_experience_patterns\([\s\S]*?\n\$\$;/;
  const workerDefinition = /create or replace function private\.refresh_long_bot_experience_cache\([\s\S]*?\n\$\$;/;
  const triggerDefinition = /create or replace function private\.note_long_bot_experience_change\(\)[\s\S]*?\n\$\$;/;
  const cronDefinition = /do \$cron_jobs\$[\s\S]*?\n\$cron_jobs\$;/;
  const getter = migration.match(getterDefinition)?.[0] || '';
  const worker = migration.match(workerDefinition)?.[0] || '';
  const changeTrigger = migration.match(triggerDefinition)?.[0] || '';
  const cronJobs = migration.match(cronDefinition)?.[0] || '';

  assert.equal(getter, schema.match(getterDefinition)?.[0]);
  assert.equal(worker, schema.match(workerDefinition)?.[0]);
  assert.equal(changeTrigger, schema.match(triggerDefinition)?.[0]);
  assert.equal(cronJobs, schema.match(cronDefinition)?.[0]);
  assert.match(migration, /create extension if not exists pg_cron/);
  assert.match(migration, /create table if not exists private\.long_bot_experience_cache_keys/);
  assert.match(migration, /create table if not exists private\.long_bot_experience_cache \(/);
  assert.match(migration, /create table if not exists private\.long_bot_experience_changes/);
  assert.match(migration, /alter table private\.long_bot_experience_cache enable row level security/);
  assert.match(migration, /revoke all on private\.long_bot_experience_cache from public, anon, authenticated, service_role/);
  assert.match(migration, /revoke all on function private\.compute_long_bot_experience_patterns\(text\)[\s\S]*?service_role/);
  assert.doesNotMatch(getter, /bot_training_games|jsonb_array_elements|compute_long_bot/);
  assert.match(getter, /from private\.long_bot_experience_cache cached/);
  assert.match(getter, /pg_catalog\.lower\([\s\S]*?pg_catalog\.btrim/);
  assert.match(getter, /where cached\.player_key = ''/);
  assert.match(worker, /pg_try_advisory_xact_lock\(20151, 3308\)/);
  assert.match(worker, /delete from private\.long_bot_experience_changes[\s\S]*?returning old_player_key, new_player_key/);
  assert.match(worker, /select ''::text\s+where exists \(select 1 from consumed_changes\)/);
  assert.match(
    worker,
    /select cache_key\.player_key[\s\S]*?where exists \(\s*select 1\s+from consumed_changes\s+where old_player_key is null\s+and new_player_key is null/,
  );
  assert.match(worker, /select old_player_key\s+from consumed_changes\s+where old_player_key is not null/);
  assert.match(worker, /select new_player_key\s+from consumed_changes\s+where new_player_key is not null/);
  assert.match(worker, /set dirty = true/);
  assert.match(worker, /refreshed_at < pg_catalog\.clock_timestamp\(\) - interval '1 hour'/);
  assert.match(worker, /limit effective_batch_size/);
  assert.match(worker, /private\.compute_long_bot_experience_patterns/);
  assert.match(changeTrigger, /insert into private\.long_bot_experience_changes/);
  assert.match(changeTrigger, /old_key := pg_catalog\.lower\(pg_catalog\.btrim\(old\.player_name\)\)/);
  assert.match(changeTrigger, /new_key := pg_catalog\.lower\(pg_catalog\.btrim\(new\.player_name\)\)/);
  assert.doesNotMatch(changeTrigger, /compute_long_bot|refresh_long_bot/);
  assert.match(migration, /after insert or update or delete on public\.bot_training_games/);
  assert.match(migration, /perform pg_catalog\.pg_advisory_xact_lock\(20151, 3308\)/);
  assert.match(migration, /refreshed_count := private\.refresh_long_bot_experience_cache\(8\)/);
  assert.match(cronJobs, /perform cron\.unschedule\(old_job\.jobid\)/);
  assert.equal((cronJobs.match(/perform cron\.schedule\(/g) || []).length, 2);
  assert.match(cronJobs, /'refresh-long-bot-experience-v33',[\s\S]*?'\* \* \* \* \*'/);
  assert.match(cronJobs, /'cleanup-long-bot-experience-v33-job-history',[\s\S]*?'17 3 \* \* \*'/);
  assert.match(cronJobs, /delete from cron\.job_run_details details[\s\S]*?details\.jobid in \(/);
  assert.match(cronJobs, /details\.end_time < pg_catalog\.now\(\) - interval '7 days'/);
});
