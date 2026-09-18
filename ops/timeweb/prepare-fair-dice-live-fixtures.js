#!/usr/bin/env node
'use strict';

// Root Linux preparation only. This program never contacts the network or DB.
// The operator executes the emitted private SQL and canary separately.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { rules, validateTransition } = require('../../lib/fair-dice-rules.js');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MARKER = 'nardu-fair-dice-v36';
const PUBLIC_ALIAS = 'sb_publishable_kWyPnUGXGMJ0afLvIdRNNr_j7tZjhXC';
const clone = value => JSON.parse(JSON.stringify(value));
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
function fail(code) { throw Object.assign(new Error('Private fair-dice fixture preparation failed.'), { code }); }
function check(value, code) { if (!value) fail(code); }
function safeError(error) { return /^FIXTURE_[A-Z_]{1,64}$/.test(error?.code || '') ? error.code : 'FIXTURE_PREPARATION_FAILED'; }

function absoluteFile(value) {
  check(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value
    && !/[\r\n\0]/.test(value), 'FIXTURE_PATH_INVALID');
  return value;
}

function readAnonKey(envFile) {
  absoluteFile(envFile);
  const metadata = fs.lstatSync(envFile);
  check(metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === process.getuid?.()
    && (metadata.mode & 0o077) === 0 && metadata.size > 0 && metadata.size <= 131072
    && fs.realpathSync(envFile) === envFile, 'FIXTURE_ENV_INVALID');
  const descriptor = fs.openSync(envFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let source;
  try {
    const opened = fs.fstatSync(descriptor);
    check(opened.ino === metadata.ino && opened.dev === metadata.dev && opened.isFile()
      && opened.uid === process.getuid?.() && (opened.mode & 0o077) === 0 && opened.size <= 131072, 'FIXTURE_ENV_INVALID');
    source = fs.readFileSync(descriptor, 'utf8');
  } finally { fs.closeSync(descriptor); }
  const matches = source.split(/\r?\n/).map(line => line.match(/^(?:export[ \t]+)?ANON_KEY[ \t]*=[ \t]*(.*)$/)).filter(Boolean);
  check(matches.length === 1, 'FIXTURE_ANON_KEY_INVALID');
  let key = matches[0][1].trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  check(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)
    && key.length >= 64 && key.length <= 8192, 'FIXTURE_ANON_KEY_INVALID');
  let role;
  try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')).role; } catch { /* Fail closed below. */ }
  check(role === 'anon', 'FIXTURE_ANON_KEY_INVALID');
  return key;
}

function backendUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail('FIXTURE_BACKEND_INVALID'); }
  check(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    && parsed.pathname === '/', 'FIXTURE_BACKEND_INVALID');
  return parsed.href.replace(/\/$/, '');
}

function newCode(seen) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const letters = [...randomBytes(8)].map(byte => ALPHABET[byte % ALPHABET.length]).join('');
    const code = letters.slice(0, 4) + '-' + letters.slice(4);
    if (!seen.has(code)) { seen.add(code); return code; }
  }
  fail('FIXTURE_RANDOM_CODE_FAILED');
}

function guestHeaders(anonKey) {
  const proof = 'gproof:' + randomBytes(32).toString('hex');
  const identity = 'guest:sha256:' + createHash('sha256').update('nardu/guest/v1:' + proof, 'utf8').digest('hex');
  return { authorization: `Bearer ${anonKey}`, 'x-guest-id': identity, 'x-guest-proof': proof };
}

function callerSql(headers) {
  const metadata = { 'x-guest-id': headers['x-guest-id'], 'x-guest-proof': headers['x-guest-proof'],
    'x-client-info': 'supabase-js-web/live-canary ' + MARKER };
  return [
    "SET LOCAL request.jwt.claims = '{\"role\":\"anon\"}';",
    "SET LOCAL request.jwt.claim.role = 'anon';",
    "SET LOCAL request.jwt.claim.sub = '';",
    'SET LOCAL request.headers = ' + quote(JSON.stringify(metadata)) + ';',
    'SET LOCAL ROLE anon;',
  ].join('\n');
}

function serviceSql() {
  return [
    "SET LOCAL request.jwt.claims = '{\"role\":\"service_role\"}';",
    "SET LOCAL request.jwt.claim.role = 'service_role';",
    "SET LOCAL request.jwt.claim.sub = '';",
    "SET LOCAL request.headers = '{}';",
    'SET LOCAL ROLE service_role;',
  ].join('\n');
}

function buildFixtures({ anonKey, backend, nowMs = Date.now() }) {
  check(typeof anonKey === 'string' && /^[A-Za-z0-9._-]{64,8192}$/.test(anonKey), 'FIXTURE_ANON_KEY_INVALID');
  check(Number.isSafeInteger(nowMs) && nowMs > 0, 'FIXTURE_TIME_INVALID');
  const url = backendUrl(backend);
  const seen = new Set();
  const specs = [
    { variant: 'long', kind: 'bot', color: 'white' },
    { variant: 'long', kind: 'bot', color: 'dark' },
    { variant: 'short', kind: 'bot', color: 'white' },
    { variant: 'long', kind: 'remote', color: 'white' },
  ].map(spec => {
    const code = newCode(seen);
    // Exercise the actual browser's public-key-to-anon translation on exactly
    // the short fixture. The live reader must configure this same known alias.
    const headers = guestHeaders(spec.variant === 'short' ? PUBLIC_ALIAS : anonKey);
    const opponentHeaders = spec.kind === 'remote' ? guestHeaders(anonKey) : null;
    const state = Object.assign(clone(rules.initialState(spec.variant)), { mode: spec.kind, roomCode: code, startedAt: nowMs,
      ...(spec.kind === 'bot' ? { analysis: { playerColor: spec.color } } : {}) });
    validateTransition(null, state, { actorColor: spec.color, botOwner: spec.kind === 'bot', allowInitial: true });
    return { ...spec, code, headers, opponentHeaders, state };
  });
  const fixtures = specs.map(spec => ({ code: spec.code, kind: spec.kind, headers: spec.headers,
    ...(spec.opponentHeaders ? { opponentHeaders: spec.opponentHeaders } : {}) }));
  const statements = [
    '-- PRIVATE controlled guest fixtures. Execute with psql -v ON_ERROR_STOP=1 as the DB owner.',
    '-- No real accounts. Any failure must roll back this transaction, never resume it.',
    'BEGIN;',
    'SET LOCAL search_path = pg_catalog, public, extensions;',
    "SET LOCAL statement_timeout = '45s';",
    "SET LOCAL lock_timeout = '5s';",
    'DO $fixture_policy$ DECLARE enabled_now boolean; BEGIN',
    '  SELECT enabled INTO enabled_now FROM private.fair_dice_settings WHERE singleton FOR UPDATE;',
    "  IF enabled_now IS DISTINCT FROM false THEN RAISE EXCEPTION 'Controlled fixtures require policy OFF before seeding.'; END IF;",
    'END; $fixture_policy$;',
    serviceSql(),
    'SELECT public.configure_fair_dice_policy(true);',
  ];
  for (const spec of specs) {
    statements.push(callerSql(spec.headers));
    const hostName = 'Canary36 ' + (spec.kind === 'bot' ? spec.variant + ' ' + spec.color : 'remote') + ' ' + spec.code;
    check(hostName.length <= 32, 'FIXTURE_NAME_INVALID');
    statements.push('INSERT INTO public.rooms(code,variant,status,host_name,host_guest_id,host_registered,guest_name,game_state)',
      'VALUES(' + [quote(spec.code), quote(spec.variant), quote(spec.kind === 'bot' ? 'joined' : 'waiting'), quote(hostName),
        quote(spec.headers['x-guest-id']), 'false', spec.kind === 'bot' ? quote('Бот сложный') : 'NULL', quote(JSON.stringify(spec.state)) + '::jsonb'].join(',') + ');');
    if (spec.opponentHeaders) {
      statements.push(callerSql(spec.opponentHeaders),
        'UPDATE public.rooms SET status=\'joined\',guest_guest_id=' + quote(spec.opponentHeaders['x-guest-id'])
          + ',guest_name=' + quote('Canary36 peer ' + spec.code) + ',guest_registered=false WHERE code=' + quote(spec.code) + ';');
    }
  }
  statements.push(serviceSql(), 'SELECT public.configure_fair_dice_policy(false);', 'RESET ROLE;',
    'DO $fixture_check$ BEGIN',
    "  IF (SELECT enabled FROM private.fair_dice_settings WHERE singleton) IS DISTINCT FROM false THEN RAISE EXCEPTION 'Policy OFF restoration failed.'; END IF;",
    '  IF (SELECT count(*) FROM public.rooms WHERE code IN (' + specs.map(spec => quote(spec.code)).join(',')
      + ") AND fair_dice_required AND status='joined' AND game_version=0 AND game_state->>'phase'='opening') <> 4 THEN RAISE EXCEPTION 'Controlled room seeding was incomplete.'; END IF;",
    'END; $fixture_check$;', 'COMMIT;', '');
  return { fixture: { backendUrl: url, anonKey, fixtures }, sql: statements.join('\n'), specs };
}

function writePrivateFile(file, data) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, data); fs.fchmodSync(descriptor, 0o600); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function prepareFixtures({ envFile, outputDir, backend }) {
  const key = readAnonKey(envFile);
  absoluteFile(outputDir);
  const parent = path.dirname(outputDir);
  const parentMetadata = fs.lstatSync(parent);
  check(parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink() && parentMetadata.uid === process.getuid?.()
    && (parentMetadata.mode & 0o022) === 0 && fs.realpathSync(parent) === parent
    && /^[A-Za-z0-9._-]+$/.test(path.basename(outputDir)), 'FIXTURE_OUTPUT_INVALID');
  const artifacts = buildFixtures({ anonKey: key, backend });
  fs.mkdirSync(outputDir, { mode: 0o700 }); // EEXIST is a hard failure, never reuse.
  const directory = fs.lstatSync(outputDir);
  check(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid?.()
    && (directory.mode & 0o777) === 0o700 && fs.realpathSync(outputDir) === outputDir, 'FIXTURE_OUTPUT_INVALID');
  const fixtureFile = path.join(outputDir, 'fixtures.json');
  const seedFile = path.join(outputDir, 'seed.sql');
  writePrivateFile(fixtureFile, JSON.stringify(artifacts.fixture, null, 2) + '\n');
  writePrivateFile(seedFile, artifacts.sql);
  const descriptor = fs.openSync(outputDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  return { ok: true, fixtureFile, seedFile, rooms: artifacts.specs.map(spec => ({ code: spec.code, kind: spec.kind, variant: spec.variant, color: spec.color })) };
}

function main(argv = process.argv.slice(2)) {
  check(process.platform === 'linux' && process.getuid?.() === 0, 'FIXTURE_ROOT_LINUX_REQUIRED');
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    check(['--env-file', '--output-dir', '--backend-url'].includes(argv[index]) && argv[index + 1]
      && !Object.hasOwn(flags, argv[index]), 'FIXTURE_ARGUMENTS_INVALID');
    flags[argv[index]] = argv[index + 1];
  }
  check(Object.keys(flags).length === 3, 'FIXTURE_ARGUMENTS_INVALID');
  const result = prepareFixtures({ envFile: flags['--env-file'], outputDir: flags['--output-dir'], backend: flags['--backend-url'] });
  process.stdout.write(JSON.stringify(result) + '\n');
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: safeError(error) }) + '\n');
    process.exitCode = 1;
  }
}
module.exports = { readAnonKey, buildFixtures, prepareFixtures, main, safeError };
