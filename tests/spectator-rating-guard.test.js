const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
const migration = fs.readFileSync(path.join(ROOT, 'supabase/spectator-rating-guard-v40.sql'), 'utf8');
const repair = fs.readFileSync(path.join(ROOT, 'supabase/repair-q3pl-jf26-spectator-rating.sql'), 'utf8');

function functionBody(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is missing`);
  const bodyStart = sql.indexOf('as $$', start);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  assert.ok(bodyStart > start && bodyEnd > bodyStart, `${name} has no SQL body`);
  return sql.slice(start, bodyEnd + 3)
    .replace(/^\s*--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

test('standalone migration and clean schema have identical spectator rating guards', () => {
  for (const name of [
    'guard_rating_event_participant',
    'guard_profile_rating_write',
    'touch_room_spectator',
  ]) {
    assert.equal(functionBody(schema, name), functionBody(migration, name));
  }
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  assert.match(migration, /before insert on public\.rating_events/);
  assert.match(migration, /drop policy if exists "users can insert own rating events"/);
  assert.match(migration, /revoke insert on public\.rating_events from authenticated/);
  assert.match(migration, /before insert or update on public\.profiles/);
});

test('a rating award requires the correct player seat and a saved matching result', () => {
  const guard = functionBody(schema, 'guard_rating_event_participant');
  assert.match(guard, /rating_room\.host_user_id = new\.user_id[\s\S]*player_color := 'white'/);
  assert.match(guard, /rating_room\.guest_user_id = new\.user_id[\s\S]*player_color := 'dark'/);
  assert.match(guard, /if player_color is null then[\s\S]*Only room players can receive a rating result/);
  assert.match(guard, /new\.did_win is distinct from \(new\.winner = player_color\)/);
  assert.match(guard, /rating_room\.game_state->>'finishedAt' = game_finished_at/);
  assert.match(guard, /archive\.final_state->>'finishedAt' = game_finished_at/);
  assert.match(guard, /new\.result_key <> concat\(game_finished_at, ':', new\.winner, ':'/);
  assert.match(guard, /The completed game has not been saved/);
});

test('profile rating is server-owned, but spectator removal works after game over', () => {
  const profile = functionBody(schema, 'guard_profile_rating_write');
  assert.match(profile, /if current_user = 'authenticated' then/);
  assert.match(profile, /new\.rating := 1000/);
  assert.match(profile, /new\.rating, new\.tier, new\.rating_eligible/);
  const spectator = functionBody(schema, 'touch_room_spectator');
  assert.match(spectator, /if not p_leave and \(not room_allow or room_status <> 'joined'\) then/);
  assert.match(spectator, /if p_leave then[\s\S]*active_spectators - safe_key/);
});

test('specific spectator correction is audited and aborts on intervening results', () => {
  assert.match(repair, /^begin;/m);
  assert.match(repair, /^commit;/m);
  assert.match(repair, /result_key = '1791008478186:white:normal'/);
  assert.match(repair, /later\.created_at >= erroneous\.created_at/);
  assert.match(repair, /game_room\.host_user_id = spectator\.id/);
  assert.match(repair, /game_room\.guest_user_id = spectator\.id/);
  assert.match(repair, /'correct-spectator-rating'/);
  assert.match(repair, /'originalEvent', to_jsonb\(erroneous\)/);
  assert.match(repair, /delete from public\.rating_events[\s\S]*where id = erroneous\.id and user_id = spectator\.id/);
  assert.match(repair, /set rating = 1548, tier = 'Gold'/);
});
