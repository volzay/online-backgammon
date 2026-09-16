const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase', 'long-bot-strategy-v35.sql'),
  'utf8',
);
const V34_MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase', 'long-bot-strategy-v34.sql'),
  'utf8',
);
const CONTROLLER = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8');

function definition(pattern, label) {
  const match = SCHEMA.match(pattern);
  assert.ok(match, `${label} definition must exist in the canonical schema`);
  return match[0];
}

const completeCoverageAssertions = (source) => {
  assert.match(source, /'long-analytic-v34'[\s\S]*?'long-analytic-v35'/);
  assert.match(source, /coverage'?->'complete'/);
  assert.match(source, /coverage'?->>'expectedBotDecisions'/);
  assert.match(source, /coverage'?->>'recordedBotDecisions'/);
  assert.match(source, /coverage'?->>'recoveredBotDecisions'/);
  assert.match(source, /expectedBotDecisions'[\s\S]*?(?:<=|>) 0/);
  assert.match(
    source,
    /expectedBotDecisions'[\s\S]*?recordedBotDecisions'[\s\S]*?recoveredBotDecisions'/,
  );
};

const homogeneousV35Assertions = (source) => {
  assert.match(source, /private\.long_bot_v35_training_memory_is_complete/);
};

test('migration uses ordinary strpos calls rather than schema-qualified POSITION syntax', () => {
  assert.doesNotMatch(MIGRATION, /pg_catalog\.position\s*\(/i);
  assert.match(MIGRATION, /pg_catalog\.strpos\(patched_definition, '''long-analytic-v35'''\)/);
});

test('every server archive path applies complete decision coverage to long bot v35', () => {
  const atomicFinalizer = definition(
    /create or replace function public\.finish_room_game\(\s*p_room_code text,\s*p_final_state jsonb,\s*p_training_state jsonb\s*\)[\s\S]*?\n\$\$;/,
    'three-argument finish_room_game',
  );
  const automaticArchive = definition(
    /create or replace function public\.archive_finished_bot_training_game\(\)[\s\S]*?\n\$\$;/,
    'archive_finished_bot_training_game',
  );
  const explicitArchive = definition(
    /create or replace function public\.archive_bot_training_game\(\s*p_room_code text,\s*p_final_state jsonb default null\s*\)[\s\S]*?\n\$\$;/,
    'archive_bot_training_game',
  );

  [atomicFinalizer, automaticArchive, explicitArchive].forEach(source => {
    completeCoverageAssertions(source);
    homogeneousV35Assertions(source);
  });

  const backfillStart = SCHEMA.indexOf(
    'insert into public.bot_training_games (',
    SCHEMA.indexOf('create trigger rooms_archive_finished_bot_training'),
  );
  const backfillEnd = SCHEMA.indexOf(
    'create table if not exists public.room_game_archives',
    backfillStart,
  );
  assert.ok(backfillStart > 0 && backfillEnd > backfillStart, 'training backfill must exist');
  const backfill = SCHEMA.slice(backfillStart, backfillEnd);
  completeCoverageAssertions(backfill);
  homogeneousV35Assertions(backfill);
});

test('v35 integrity helper rejects a numerically complete mixed v34/v35 bot ledger', () => {
  const helper = definition(
    /create or replace function private\.long_bot_v35_training_memory_is_complete\([\s\S]*?\n\$\$;/,
    'long_bot_v35_training_memory_is_complete',
  );
  assert.match(helper, /coalesce\(p_memory->>'engineVersion', ''\) <> 'long-analytic-v35'/);
  assert.match(helper, /select count\(\*\)[\s\S]*?actor[\s\S]*?= 'bot'[\s\S]*?expectedBotDecisions/);
  assert.match(helper, /not exists[\s\S]*?decision->>'engineVersion'[\s\S]*?<> 'long-analytic-v35'/);

  const negativeSql = MIGRATION.match(
    /do \$v35_mixed_ledger_test\$[\s\S]*?\$v35_mixed_ledger_test\$;/,
  )?.[0] || '';
  assert.match(negativeSql, /mixed_memory/);
  assert.match(negativeSql, /"engineVersion":"long-analytic-v34"/);
  assert.match(negativeSql, /"engineVersion":"long-analytic-v35"/);
  assert.match(
    negativeSql,
    /if private\.long_bot_v35_training_memory_is_complete\(mixed_memory\)[\s\S]*?raise exception/,
  );
  assert.match(
    negativeSql,
    /if not private\.long_bot_v35_training_memory_is_complete\(homogeneous_memory\)[\s\S]*?raise exception/,
  );
});

test('mixed-generation completion quarantines archives only after exact identity and numeric coverage gates', () => {
  const finish = definition(
    /create or replace function public\.finish_room_game\(\s*p_room_code text,\s*p_final_state jsonb,\s*p_training_state jsonb\s*\)[\s\S]*?\n\$\$;/,
    'three-argument finish_room_game',
  );
  const quarantine = finish.indexOf('training_quarantined := true;');
  const archiveGuard = finish.indexOf('    if not training_quarantined then');
  const archiveInsert = finish.indexOf('    insert into public.bot_training_games');
  const returnBoundary = finish.indexOf('  return jsonb_build_object');
  assert.ok(finish.indexOf('    update public.rooms') < quarantine);
  for (const gate of [
    'Training state does not match the finished game.',
    'Bot training payload contains no decisions.',
    'Long bot v29+ training payload has incomplete decision coverage.',
  ]) assert.ok(finish.indexOf(gate) >= 0 && finish.indexOf(gate) < quarantine, gate);
  for (const field of ['points', 'off', 'bar', 'score']) {
    assert.ok(finish.indexOf(`p_training_state->'${field}'`) < quarantine, field);
  }
  assert.match(finish, /select count\(\*\)[\s\S]*?training_coverage->>'expectedBotDecisions'[\s\S]*?and exists/);
  assert.match(finish, /if coalesce\(p_training_state->>'variant', target\.variant\) = 'long'\n      and \(\n        select count\(\*\)/);
  assert.match(finish, /decision->>'engineVersion' = 'long-analytic-v35'/);
  assert.match(finish, /~ '\^long-analytic-v\(29\|30\|31\|32\|33\|34\)\$'/);
  assert.match(finish, /!~ '\^long-analytic-v\(29\|30\|31\|32\|33\|34\|35\)\$'/);
  assert.ok(quarantine < archiveGuard && archiveGuard < archiveInsert && archiveInsert < returnBoundary);
  assert.match(finish, /training_archived := true;\n    end if;\n  end if;\n\n  return/);
  assert.match(finish, /'trainingArchived', training_archived,[\s\S]*?'trainingQuarantined', training_quarantined/);
  assert.doesNotMatch(finish.slice(quarantine, archiveGuard), /return /);
});

test('completion-quarantine migration upgrades original v34 and previously installed v35 idempotently', () => {
  const v34Finish = V34_MIGRATION.match(
    /create or replace function public\.finish_room_game\(\s*p_room_code text,\s*p_final_state jsonb,\s*p_training_state jsonb\s*\)[\s\S]*?\n\$\$;/,
  )?.[0];
  assert.ok(v34Finish);
  const dollarLiteral = name => {
    const delimiter = `$${name}$`;
    const start = MIGRATION.indexOf(delimiter);
    const end = MIGRATION.indexOf(delimiter, start + delimiter.length);
    assert.ok(start >= 0 && end > start, name);
    return MIGRATION.slice(start + delimiter.length, end);
  };
  const oldGate = dollarLiteral('old_finish_gate');
  const newGate = dollarLiteral('quarantine_finish_gate');
  const previousV35 = v34Finish.replaceAll("'long-analytic-v34'", "'long-analytic-v34', 'long-analytic-v35'")
    .replace('    training_outcome :=', () => dollarLiteral('finish_gate'));
  const patch = input => {
    let output = input;
    if (!output.includes('training_quarantined boolean := false;')) {
      output = output.replace('  training_archived boolean := false;', '  training_archived boolean := false;\n  training_quarantined boolean := false;');
    }
    if (!output.includes('training_quarantined := true;')) output = output.replace(oldGate, () => newGate);
    if (!output.includes('    if not training_quarantined then')) {
      output = output.replace('    training_outcome :=', '    if not training_quarantined then\n    training_outcome :=')
        .replace('    training_archived := true;', '    training_archived := true;\n    end if;');
    }
    if (!output.includes("'trainingQuarantined', training_quarantined")) {
      output = output.replace("'trainingArchived', training_archived,", "'trainingArchived', training_archived,\n    'trainingQuarantined', training_quarantined,");
    }
    return output;
  };
  assert.equal(previousV35.split(oldGate).length - 1, 1, 'earlier v35 gate is an exact unique upgrade anchor');
  const upgraded = patch(previousV35);
  assert.ok(upgraded.includes(newGate));
  assert.equal(patch(upgraded), upgraded);
  const current = definition(
    /create or replace function public\.finish_room_game\(\s*p_room_code text,\s*p_final_state jsonb,\s*p_training_state jsonb\s*\)[\s\S]*?\n\$\$;/,
    'three-argument finish_room_game',
  );
  assert.equal(patch(current), current, 'canonical current v35 is also idempotent');
  assert.ok(current.includes(newGate), 'standalone and canonical quarantine logic agree byte-for-byte');
  assert.match(MIGRATION, /Could not install the v35 mixed-ledger completion quarantine/);
});

test('client omits a mixed v34/v35 ledger so final room persistence can still succeed', () => {
  const validator = CONTROLLER.match(
    /function validBotTrainingStatePayload\(payload\) \{[\s\S]*?\n  \}/,
  )?.[0] || '';
  assert.match(validator, /engineVersion === 'long-analytic-v35'/);
  assert.match(validator, /v35BotDecisions\.length === expected/);
  assert.match(
    validator,
    /v35BotDecisions\.every\(decision => String\(decision\?\.engineVersion \|\| ''\) === engineVersion\)/,
  );
  assert.match(
    CONTROLLER,
    /const trainingState = validBotTrainingStatePayload\(trainingPayload\)\s*\? trainingPayload\s*:\s*null/,
  );

  const validate = Function(
    'mode',
    'botDifficulty',
    `${validator}; return validBotTrainingStatePayload;`,
  )('bot', 'hard');
  const payload = engineVersions => ({
    variant: 'long',
    analysis: {
      botMemory: {
        engineVersion: 'long-analytic-v35',
        coverage: {
          complete: true,
          expectedBotDecisions: engineVersions.length,
          recordedBotDecisions: engineVersions.length,
          recoveredBotDecisions: 0,
        },
        decisions: engineVersions.map(engineVersion => ({
          actor: 'bot',
          engineVersion,
        })),
      },
    },
  });
  assert.equal(validate(payload(['long-analytic-v34', 'long-analytic-v35'])), false);
  assert.equal(validate(payload(['long-analytic-v35', 'long-analytic-v35'])), true);
});

test('v35 migration patches all live archive functions and replays only the gated backfill', () => {
  [
    'public.finish_room_game(text,jsonb,jsonb)',
    'public.archive_finished_bot_training_game()',
    'public.archive_bot_training_game(text,jsonb)',
  ].forEach(signature => assert.match(MIGRATION, new RegExp(signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));

  assert.match(MIGRATION, /pg_catalog\.pg_get_functiondef/);
  assert.match(MIGRATION, /'long-analytic-v34'', ''long-analytic-v35'/);
  assert.match(MIGRATION, /Could not install the v35 integrity gate/);
  assert.match(MIGRATION, /insert into public\.bot_training_games/);
  completeCoverageAssertions(MIGRATION);
  homogeneousV35Assertions(MIGRATION);
  assert.doesNotMatch(MIGRATION, /compute_long_bot_experience_patterns/);
});

test('v35 migration anchors match every v34 function definition it upgrades', () => {
  const v34AtomicFinalizer = V34_MIGRATION.match(
    /create or replace function public\.finish_room_game\(\s*p_room_code text,\s*p_final_state jsonb,\s*p_training_state jsonb\s*\)[\s\S]*?\n\$\$;/,
  )?.[0] || '';
  const v34AutomaticArchive = V34_MIGRATION.match(
    /create or replace function public\.archive_finished_bot_training_game\(\)[\s\S]*?\n\$\$;/,
  )?.[0] || '';
  const v34ExplicitArchive = V34_MIGRATION.match(
    /create or replace function public\.archive_bot_training_game\(\s*p_room_code text,\s*p_final_state jsonb default null\s*\)[\s\S]*?\n\$\$;/,
  )?.[0] || '';

  [
    [v34AtomicFinalizer, '    training_outcome :='],
    [v34AutomaticArchive, '  resolved_bot_color :='],
    [v34ExplicitArchive, '  outcome :='],
  ].forEach(([source, anchor]) => {
    assert.ok(source, 'v34 function definition must exist');
    assert.equal(source.split(anchor).length - 1, 1, `${anchor.trim()} anchor must be unique`);
    assert.match(source, /'long-analytic-v34'/);
    assert.doesNotMatch(source, /long_bot_v35_training_memory_is_complete/);
  });
});

test('v35 archives stay outside the outcome-labelled experience aggregate', () => {
  const aggregate = definition(
    /create or replace function private\.compute_long_bot_experience_patterns\([\s\S]*?\n\$\$;/,
    'compute_long_bot_experience_patterns',
  );
  assert.match(aggregate, /long-analytic-v34/);
  assert.doesNotMatch(aggregate, /long-analytic-v35/);

  const outcomePipelineStart = SCHEMA.indexOf(
    'create or replace function private.compute_long_bot_experience_patterns',
  );
  const outcomePipelineEnd = SCHEMA.indexOf(
    'drop function if exists public.get_short_bot_experience_patterns',
    outcomePipelineStart,
  );
  assert.ok(
    outcomePipelineStart > 0 && outcomePipelineEnd > outcomePipelineStart,
    'outcome-learning pipeline must exist',
  );
  assert.doesNotMatch(
    SCHEMA.slice(outcomePipelineStart, outcomePipelineEnd),
    /long-analytic-v35/,
  );
});
