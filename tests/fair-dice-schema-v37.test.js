'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const prototype = require('../experiments/system-dice/protocol.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'fair-dice-v37.sql'), 'utf8');
const V36 = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'fair-dice-v36.sql'), 'utf8');
const SMOKE = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'tests', 'fair-dice-v37-rollback-smoke.sql'), 'utf8');

function definition(name, source = SOURCE) {
  const expression = new RegExp(`create or replace function (?:public|private)\\.${name}\\([\\s\\S]*?\\n\\$\\$;`);
  const found = source.match(expression)?.[0];
  assert.ok(found, `${name} must be defined`);
  return found;
}

test('v37 is additive and leaves the drand policy default unchanged until explicit activation', () => {
  assert.match(SOURCE, /^begin;/);
  assert.match(SOURCE, /notify pgrst, 'reload schema';\ncommit;/);
  assert.match(SOURCE, /fair_dice_settings add column if not exists protocol text not null default 'drand-quicknet-v1'/);
  assert.match(SOURCE, /rooms add column if not exists fair_dice_protocol text not null default 'drand-quicknet-v1'/);
  assert.doesNotMatch(SOURCE, /update public\.rooms set|delete from private\.fair_dice_requests|truncate\s/i);
  assert.doesNotMatch(SOURCE, /set protocol = 'system-csprng-v1'/);
});

test('request shape requires a drand round or a protected system seed/commitment, never a mixed protocol', () => {
  assert.match(SOURCE, /alter column round drop not null/);
  assert.match(SOURCE, /protocol = 'drand-quicknet-v1' and round is not null and private_seed is null/);
  assert.match(SOURCE, /protocol = 'system-csprng-v1' and round is null/);
  assert.match(SOURCE, /client_seed_at is not null and client_seed_at >= created_at/);
  assert.match(SOURCE, /revoke all on private\.fair_dice_requests from public, anon, authenticated, service_role/);
  assert.doesNotMatch(SOURCE, /grant .*private\.fair_dice_requests/i);
});

test('rooms stamp the current protocol and reject downgrade or outdated clients without affecting old policy', () => {
  const guard = definition('guard_authoritative_fair_dice_room');
  assert.match(guard, /select enabled, protocol into new\.fair_dice_required, new\.fair_dice_protocol/);
  assert.match(guard, /new\.fair_dice_protocol is distinct from old\.fair_dice_protocol/);
  assert.match(guard, /new\.fair_dice_protocol = 'drand-quicknet-v1'[\s\S]*nardu-fair-dice-v36/);
  assert.match(guard, /new\.fair_dice_protocol = 'system-csprng-v1'[\s\S]*nardu-fair-dice-v37/);
  for (const field of ['host_user_id','host_guest_id','guest_user_id','guest_guest_id','id','code','variant','created_at','game_state','game_version']) {
    assert.ok(guard.includes(`new.${field} is distinct from old.${field}`), field);
  }
  assert.ok(guard.includes("new.status = 'closed' and old.status = 'joined'"));
});

test('system receipt has exactly the same ten-key public contract and replaces only round with commitment', () => {
  const receipt = definition('fair_dice_request_json');
  for (const field of ['id','roomCode','gameId','nonce','label','color','variant','createdAt','positionHash']) assert.ok(receipt.includes(`'${field}'`));
  assert.match(receipt, /then jsonb_build_object\('commitment', \(p_request\)\.commitment\)/);
  assert.match(receipt, /else jsonb_build_object\('round', \(p_request\)\.round\)/);
  assert.doesNotMatch(receipt, /private_seed|client_seed/);
});

test('system seeds are obtained once under the room lock and pending reservations reuse all committed context', () => {
  const reserve = definition('reserve_fair_dice');
  assert.match(reserve, /public\.rooms where code = upper\(trim\(p_room_code\)\) for update/);
  assert.match(reserve, /actor := private\.fair_dice_actor\(target\)/);
  assert.ok(reserve.indexOf('if found then') < reserve.indexOf('extensions.gen_random_bytes(32)'));
  assert.match(reserve, /pending\.private_seed := encode\(extensions\.gen_random_bytes\(32\), 'hex'\)/);
  assert.match(reserve, /pending\.commitment := private\.system_fair_dice_commitment\(pending\)/);
  assert.match(reserve, /extract\(epoch from now_at\) \+ 6 - 1692803367\) \/ 3/);
  assert.match(reserve, /p_label is distinct from expected_label or p_color is distinct from expected_color/);
  assert.match(reserve, /actor->>'actorColor' is distinct from expected_color/);
  assert.doesNotMatch(reserve, /private_seed\s*:=\s*p_|commitment\s*:=\s*p_|locked_hash\s*:=\s*p_/);
});

test('client challenge acceptance is service-only and rechecks epoch, locked state, intent and first seed', () => {
  const accept = definition('accept_system_fair_dice_client_seed');
  assert.match(accept, /p_request_id uuid, p_client_seed text, p_room_code text, p_game_id uuid, p_position_hash text/);
  assert.match(accept, /auth\.role\(\), ''\) <> 'service_role'/);
  assert.ok(accept.indexOf('for update of r') < accept.indexOf('where id = p_request_id for update'));
  assert.match(accept, /room\.status <> 'joined'/);
  assert.match(accept, /room\.fair_dice_game_id is distinct from target\.game_id/);
  assert.match(accept, /target\.game_id is distinct from p_game_id/);
  assert.match(accept, /target\.position_hash is distinct from p_position_hash/);
  assert.match(accept, /private\.fair_dice_position_hash\(room\.game_state\) is distinct from target\.position_hash/);
  assert.match(accept, /target\.cancelled_at is not null or target\.consumed_at is not null/);
  assert.match(accept, /target\.client_seed is distinct from p_client_seed/);
  assert.match(accept, /client_seed = p_client_seed, client_seed_at = clock_timestamp\(\)/);
  assert.match(SOURCE, /grant execute on function public\.accept_system_fair_dice_client_seed\(uuid, text, text, uuid, text\) to service_role/);
});

test('public room/request recovery never discloses a private seed before completed proof disclosure', () => {
  const request = definition('get_fair_dice_request');
  assert.match(request, /if coalesce\(auth\.role\(\), ''\) = 'service_role' and target\.protocol = 'system-csprng-v1' then/);
  assert.match(request, /jsonb_build_object\('privateSeed', target\.private_seed\)/);
  const room = definition('get_fair_dice_room');
  assert.match(room, /'fairDiceProtocol', target\.fair_dice_protocol/);
  assert.match(room, /'clientSeed', pending\.client_seed/);
  assert.doesNotMatch(room, /private_seed|privateSeed/);
});

test('context, commitment and request hashes use compact escaped JSON rather than JSONB whitespace', () => {
  for (const name of ['system_fair_dice_context','system_fair_dice_commitment','system_fair_dice_request_hash']) {
    const body = definition(name);
    assert.ok(body.includes('to_json('));
    assert.doesNotMatch(body, /jsonb_build_array|::jsonb::text/);
  }
  assert.ok(definition('system_fair_dice_context').includes("'nardu/system-dice/v1'"));
  assert.ok(definition('system_fair_dice_commitment').includes("'nardu/system-dice-commitment/v1'"));
  assert.ok(definition('system_fair_dice_request_hash').includes("'nardu/system-csprng/v1'"));
});

test('SQL independently reconstructs HMAC with rejection sampling and never rerolls ordinary doubles', () => {
  const derive = definition('system_fair_dice_derived');
  assert.match(derive, /for counter_value in 0\.\.1024 loop/);
  assert.match(derive, /for block_value in 0\.\.15 loop/);
  assert.match(derive, /extensions\.hmac\(convert_to\(message, 'UTF8'\), decode\(p_request\.private_seed, 'hex'\), 'sha256'\)/);
  assert.match(derive, /byte_value < 252/);
  assert.match(derive, /\(byte_value % 6\) \+ 1/);
  assert.match(derive, /if p_request\.label = 'opening' and physical_dice\[1\] = physical_dice\[2\] then continue/);
  assert.match(derive, /'nardu\/system-csprng-result\/v1'/);
  assert.doesNotMatch(derive, /Math\.random|gen_random_bytes|clock_timestamp/);
});

test('dual proof persistence retains drand verification and binds exact system reveal/result fields', () => {
  const proof = definition('commit_fair_dice_proof');
  assert.match(proof, /if target\.protocol = 'drand-quicknet-v1' then/);
  for (const field of ['chainHash','beacon','requestHash','receiptSignature','sha256Input','sha256','dice','rerolls']) assert.ok(proof.includes(`'${field}'`));
  assert.match(proof, /derived := private\.system_fair_dice_derived\(target\)/);
  assert.match(proof, /p_proof->'commitReveal' is distinct from jsonb_build_object/);
  assert.match(proof, /'serverSeed', target\.private_seed, 'clientSeed', target\.client_seed/);
  assert.match(proof, /p_proof->>'requestHash' is distinct from private\.system_fair_dice_request_hash\(target\)/);
  assert.match(proof, /p_proof->'dice' is distinct from derived->'dice'/);
  assert.match(proof, /p_proof->'rerolls' is distinct from derived->'counter'/);
  assert.match(proof, /target\.proof is distinct from p_proof/);
});

test('v36 lifecycle/history/CAS capabilities are not replaced by this migration', () => {
  for (const name of ['commit_fair_dice_state','reset_fair_dice_game','close_fair_dice_waiting_room','guard_fair_dice_room_deletion','touch_fair_dice_presence']) {
    assert.doesNotMatch(SOURCE, new RegExp(`create or replace function public\\.${name}\\(`));
    assert.ok(definition(name,V36));
  }
  const list = definition('list_pending_fair_dice_requests');
  assert.match(list, /room\.fair_dice_game_id = requests\.game_id/);
  assert.match(list, /limit 100/);
});

test('policy activation and rollback only change the new-room setting through a service capability', () => {
  const configure = definition('configure_fair_dice_protocol');
  assert.match(configure, /auth\.role\(\), ''\) <> 'service_role'/);
  assert.match(configure, /update private\.fair_dice_settings set protocol = p_protocol where singleton/);
  assert.doesNotMatch(configure, /update public\.rooms|update private\.fair_dice_requests/);
  assert.match(SOURCE, /grant execute on function public\.configure_fair_dice_protocol\(text\) to service_role/);
});

test('rollback smoke includes negative auth/context cases and real cross-language vectors', () => {
  for (const marker of ['A v36-only client','Unrevealed server entropy escaped','A wrong game epoch','A wrong board position','The accepted challenge was replaced','Injected physical dice','A consumed reservation','A cancelled terminal reservation','Existing system room was downgraded']) assert.ok(SMOKE.includes(marker),marker);
  assert.match(SMOKE, /exception when insufficient_privilege/);
  assert.match(SMOKE, /exception when check_violation/);
  assert.match(SMOKE, /exception when unique_violation/);
  assert.doesNotMatch(SMOKE, /\bcommit;/i);
});

test('golden commitment and request vectors equal the Node prototype contract', () => {
  const context={gameId:'11111111-1111-4111-8111-111111111111',nonce:1,roomCode:'V37A-ABCD',variant:'long',label:'opening',color:'none',positionHash:'a'.repeat(64)};
  const seed='1'.repeat(64), clientSeed='2'.repeat(64);
  const commitment=prototype.commitmentFor(context,seed);
  assert.equal(commitment,'03a06d40fd7d8adb5f0521626416a58980e9e69b9ccd6c02b4c76236d59714d5');
  const values=['22222222-2222-4222-8222-222222222222',context.roomCode,context.gameId,context.nonce,context.label,context.color,context.variant,commitment,'2026-09-18T00:00:00.123Z',context.positionHash];
  const requestHash=crypto.createHash('sha256').update(JSON.stringify(['nardu/system-csprng/v1',...values])).digest('hex');
  assert.equal(requestHash,'9e55b0147bf52636f558872ed46e08412978e824c824d7653ccc94b88fe2963d');
  const proof=prototype.deriveProof({context,privateSeed:seed,clientSeed,commitment});
  const input=JSON.stringify(['nardu/system-csprng-result/v1',requestHash,seed,clientSeed,proof.counter,proof.blocks,proof.dice]);
  assert.equal(crypto.createHash('sha256').update(input).digest('hex'),'912d857980db5c061ca3f6198cb42a1aeea07559267bcb8809deb5a95c9922cd');
  for (const hash of [commitment,requestHash,crypto.createHash('sha256').update(input).digest('hex')]) assert.ok(SMOKE.includes(hash));
});

test('migration has no unrelated account credentials, bot strategy or deployment mutations', () => {
  assert.doesNotMatch(SOURCE, /password\s*=|auth\.users|long_bot|bot_experience|strategy_weights|nardy-worker/i);
});

test('each SQL function has one complete body and no duplicated procedural tail', () => {
  const starts = [...SOURCE.matchAll(/^create or replace function (?:public|private)\.([a-z_]+)\(/gm)].map(match => match[1]);
  assert.equal(new Set(starts).size, starts.length);
  assert.equal([...SOURCE.matchAll(/^as \$\$$/gm)].length, starts.length);
  assert.equal([...SOURCE.matchAll(/^\$\$;$/gm)].length, starts.length);
  assert.doesNotMatch(SOURCE, /\n\$\$;\n\s*(?:or\s|if\s|end;)/);
  assert.match(definition('commit_fair_dice_proof'), /!~ '\^\[0-9a-f\]\{128\}\$'[\s\S]*'commitReveal'/);
});

test('v37 smoke harness emits exactly one BEGIN, no COMMIT, and a terminal ROLLBACK', () => {
  const harness = require('../ops/timeweb/emit-system-fair-dice-smoke.js');
  const sql = harness.buildSmoke(SOURCE,[SMOKE]);
  assert.equal([...sql.matchAll(/^BEGIN;$/gm)].length,1);
  assert.equal([...sql.matchAll(/^COMMIT;$/gm)].length,0);
  assert.equal([...sql.matchAll(/^ROLLBACK;$/gm)].length,1);
  assert.ok(sql.endsWith('ROLLBACK;\n'));
  assert.ok(sql.startsWith('\\set ON_ERROR_STOP on\n'));
  assert.ok(sql.includes("SET LOCAL lock_timeout = '5s'"));
});

test('smoke harness refuses nested transactions, psql commands and unrecognized wrappers', () => {
  const {buildSmoke} = require('../ops/timeweb/emit-system-fair-dice-smoke.js');
  assert.throws(()=>buildSmoke('',[SMOKE]));
  assert.throws(()=>buildSmoke(SOURCE,[]));
  assert.throws(()=>buildSmoke(SOURCE,['BEGIN;\n'+SMOKE]));
  assert.throws(()=>buildSmoke(SOURCE,['\\! echo unauthorized\n'+SMOKE]));
  assert.throws(()=>buildSmoke('begin;\nCOMMIT;\nselect 1;\ncommit;\n',[SMOKE]));
});

test('smoke emitter pins the exact reviewed source and fixture hashes used by real PostgreSQL validation', () => {
  const {REVIEWED} = require('../ops/timeweb/emit-system-fair-dice-smoke.js');
  assert.equal(REVIEWED.length,2);
  for (const [filename,expected] of REVIEWED) {
    const bytes=fs.readFileSync(path.join(__dirname,'..','supabase',filename));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),expected);
  }
});
