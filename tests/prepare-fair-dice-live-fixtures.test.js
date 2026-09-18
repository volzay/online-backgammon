'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readAnonKey, buildFixtures, prepareFixtures, safeError } = require('../ops/timeweb/prepare-fair-dice-live-fixtures.js');
const { rules, validateTransition } = require('../lib/fair-dice-rules.js');
const { readFixtureFile } = require('../scripts/fair-dice-live-canary.js');

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const ANON = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ role: 'anon', exp: 9999999999 }) + '.' + 'a'.repeat(43);
const SERVICE = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ role: 'service_role' }) + '.' + 'b'.repeat(43);
const BACKEND = 'https://api.example.test';
const PUBLIC_ALIAS = 'sb_publishable_kWyPnUGXGMJ0afLvIdRNNr_j7tZjhXC';

function sandbox(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fair36-fixture-test-'));
  fs.chmodSync(parent, 0o700);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const envFile = path.join(parent, '.env');
  fs.writeFileSync(envFile, 'POSTGRES_PASSWORD=never-export-this\nSERVICE_ROLE_KEY=' + SERVICE + '\nANON_KEY=' + ANON + '\n', { mode: 0o600 });
  return { parent, envFile, outputDir: path.join(parent, 'new-private-fixtures') };
}

test('matrix uses actual initial rules and unique proven synthetic guests for both long colors, short and remote', () => {
  const artifacts = buildFixtures({ anonKey: ANON, backend: BACKEND, nowMs: 1789689600000 });
  assert.deepEqual(artifacts.specs.map(spec => [spec.variant, spec.kind, spec.color]), [
    ['long', 'bot', 'white'], ['long', 'bot', 'dark'], ['short', 'bot', 'white'], ['long', 'remote', 'white'],
  ]);
  assert.deepEqual(Object.keys(artifacts.fixture), ['backendUrl', 'anonKey', 'fixtures']);
  assert.equal(artifacts.fixture.backendUrl, BACKEND);
  assert.equal(new Set(artifacts.specs.map(spec => spec.code)).size, 4);
  const guests = [];
  for (const spec of artifacts.specs) {
    assert.match(spec.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.deepEqual(spec.state.points, JSON.parse(JSON.stringify(rules.initialState(spec.variant).points)));
    assert.equal(validateTransition(null, spec.state, { actorColor: spec.color, botOwner: spec.kind === 'bot', allowInitial: true }), true);
    assert.equal(spec.state.startedAt, 1789689600000);
    assert.deepEqual(spec.state.history, []);
    assert.deepEqual(spec.state.dice, []);
    assert.equal(spec.state.openingRoll, null);
    if (spec.kind === 'bot') assert.equal(spec.state.analysis.playerColor, spec.color);
    else assert.equal(spec.state.analysis, undefined);
    const fixture = artifacts.fixture.fixtures.find(fixture => fixture.code === spec.code);
    assert.deepEqual(Object.keys(fixture).sort(), (spec.kind === 'bot' ? ['code','headers','kind'] : ['code','headers','kind','opponentHeaders']).sort());
    for (const headers of [spec.headers, ...(spec.opponentHeaders ? [spec.opponentHeaders] : [])]) {
      assert.match(headers['x-guest-proof'], /^gproof:[0-9a-f]{64}$/);
      assert.equal(headers['x-guest-id'], 'guest:sha256:' + createHash('sha256').update('nardu/guest/v1:' + headers['x-guest-proof'], 'utf8').digest('hex'));
      assert.equal(headers.authorization, 'Bearer ' + (spec.variant === 'short' ? PUBLIC_ALIAS : ANON));
      guests.push(headers['x-guest-id']);
    }
  }
  assert.equal(new Set(guests).size, 5);
  assert.equal(artifacts.fixture.fixtures.filter(fixture => fixture.headers.authorization === 'Bearer ' + PUBLIC_ALIAS).length, 1);
});

test('seed keeps temporary enabled policy inside one locked transaction and restores OFF before COMMIT', () => {
  const { sql, specs } = buildFixtures({ anonKey: ANON, backend: BACKEND });
  assert.equal((sql.match(/^BEGIN;$/gm) || []).length, 1);
  assert.equal((sql.match(/^COMMIT;$/gm) || []).length, 1);
  assert.match(sql, /FROM private\.fair_dice_settings WHERE singleton FOR UPDATE/);
  assert.match(sql, /enabled_now IS DISTINCT FROM false/);
  assert.match(sql, /END; \$fixture_policy\$;/);
  assert.match(sql, /END; \$fixture_check\$;/);
  assert.ok(sql.indexOf('configure_fair_dice_policy(true)') < sql.indexOf('INSERT INTO public.rooms'));
  assert.ok(sql.lastIndexOf('configure_fair_dice_policy(false)') > sql.lastIndexOf('INSERT INTO public.rooms'));
  assert.ok(sql.lastIndexOf('configure_fair_dice_policy(false)') < sql.lastIndexOf('COMMIT;'));
  assert.match(sql, /Policy OFF restoration failed/);
  assert.equal((sql.match(/INSERT INTO public\.rooms/g) || []).length, 4);
  assert.equal((sql.match(/SET LOCAL ROLE anon;/g) || []).length, 5);
  assert.match(sql, /SET LOCAL ROLE service_role;/);
  assert.equal((sql.match(/nardu-fair-dice-v36/g) || []).length, 5);
  assert.match(sql, /UPDATE public\.rooms SET status='joined',guest_guest_id=/);
  assert.ok(sql.includes("'waiting'"));
  assert.doesNotMatch(sql, /auth\.users|public\.profiles|DELETE FROM|TRUNCATE|SERVICE_ROLE_KEY|POSTGRES_PASSWORD/i);
  assert.equal(sql.includes(ANON), false, 'no bearer key is needed in SQL header metadata');
  assert.equal(sql.includes(SERVICE), false);
  for (const spec of specs) {
    assert.ok(sql.includes(spec.code));
    assert.ok(sql.includes(spec.headers['x-guest-proof']));
    assert.ok(sql.includes(JSON.stringify(spec.state)));
  }
});

test('private preparation creates a fresh 0700 directory and 0600 files and returns only safe paths/codes', t => {
  const files = sandbox(t);
  const result = prepareFixtures({ ...files, backend: BACKEND });
  assert.equal(fs.statSync(files.outputDir).mode & 0o777, 0o700);
  for (const file of [result.fixtureFile, result.seedFile]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const payload = JSON.parse(fs.readFileSync(result.fixtureFile, 'utf8'));
  assert.equal(payload.anonKey, ANON);
  assert.equal(payload.fixtures.length, 4);
  assert.equal(JSON.stringify(payload).includes(SERVICE), false);
  assert.equal(JSON.stringify(result).includes(ANON), false);
  assert.equal(JSON.stringify(result).includes(SERVICE), false);
  assert.equal(JSON.stringify(result).includes('gproof:'), false);
  const verified = readFixtureFile(result.fixtureFile);
  assert.equal(verified.fixtures.length, 4, 'live runner must accept the complete requested controlled matrix');
  assert.equal(verified.backendUrl, BACKEND);
  assert.throws(() => prepareFixtures({ ...files, backend: BACKEND }));
  assert.equal(fs.readFileSync(result.fixtureFile, 'utf8'), JSON.stringify(payload, null, 2) + '\n');
});

test('dotenv reads only a single safe anonymous JWT and rejects accidental service authority or interpolation', t => {
  const files = sandbox(t);
  assert.equal(readAnonKey(files.envFile), ANON);
  fs.writeFileSync(files.envFile, 'export ANON_KEY="' + ANON + '"\nSERVICE_ROLE_KEY=' + SERVICE + '\n');
  assert.equal(readAnonKey(files.envFile), ANON);
  for (const text of ['ANON_KEY=' + SERVICE, 'ANON_KEY=${SERVICE_ROLE_KEY}', 'ANON_KEY=' + ANON + '\nANON_KEY=' + ANON, 'ANON_KEY=evil\r\nINJECTED=value']) {
    fs.writeFileSync(files.envFile, text);
    assert.throws(() => readAnonKey(files.envFile), error => error.code === 'FIXTURE_ANON_KEY_INVALID' && !error.message.includes(SERVICE));
  }
});

test('environment and output paths fail closed on symlinks, broad permissions and pre-existing directories', t => {
  const files = sandbox(t);
  const linkedEnv = path.join(files.parent, 'linked.env');
  fs.symlinkSync(files.envFile, linkedEnv);
  assert.throws(() => readAnonKey(linkedEnv), error => error.code === 'FIXTURE_ENV_INVALID');
  fs.chmodSync(files.envFile, 0o644);
  assert.throws(() => readAnonKey(files.envFile), error => error.code === 'FIXTURE_ENV_INVALID');
  fs.chmodSync(files.envFile, 0o600);
  fs.mkdirSync(files.outputDir, { mode: 0o700 });
  assert.throws(() => prepareFixtures({ ...files, backend: BACKEND }));
  const linkDir = path.join(files.parent, 'link-directory');
  fs.symlinkSync(files.outputDir, linkDir);
  assert.throws(() => prepareFixtures({ envFile: files.envFile, outputDir: linkDir, backend: BACKEND }));
  assert.equal(fs.readdirSync(files.outputDir).length, 0);
});

test('invalid backend URL cannot produce artifacts and error reporting cannot echo secrets', () => {
  for (const backend of ['http://api.example.test', 'https://name:password@api.example.test', BACKEND + '?key=' + ANON, BACKEND + '/rest/v1', BACKEND + '#secret']) {
    assert.throws(() => buildFixtures({ anonKey: ANON, backend }), error => error.code === 'FIXTURE_BACKEND_INVALID');
  }
  assert.equal(safeError({ code: SERVICE, message: ANON }), 'FIXTURE_PREPARATION_FAILED');
  assert.equal(safeError(new Error(SERVICE)), 'FIXTURE_PREPARATION_FAILED');
  assert.equal(safeError({ code: 'FIXTURE_ANON_KEY_INVALID' }), 'FIXTURE_ANON_KEY_INVALID');
});
