'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../homegate.js'), 'utf8');

function runtime(prune, library = async () => ({ data: { summary: { total: 439 } }, error: null })) {
  const calls = [], warnings = [];
  const state = { backend: 'supabase', admin: { id: 'existing-admin' }, watch: [],
    active: [], archive: [], users: [], detailKey: '', adminTab: 'rooms', archiveCleanupWarning: '' };
  const client = {
    rpc: async name => {
      calls.push(name);
      if (name === 'admin_prune_room_archive') return prune();
      if (name === 'admin_player_stats') return { data: [], error: null };
      if (name === 'admin_long_bot_training_library') return library();
      throw Error('Unexpected RPC ' + name);
    },
    from(table) {
      calls.push(table);
      let status;
      const query = {
        select() { return this; },
        neq(key, value) { status = 'active'; return this; },
        eq(key, value) { if (key === 'status') status = value; return this; },
        gte() { return this; }, order() { return this; }, is() { return this; }, limit() { return this; },
        then(resolve, reject) {
          const data = table === 'rooms' ? [{ id: status === 'closed' ? 'archived-room' : 'active-room', presence: {} }]
            : table === 'profiles' ? [{ id: 'existing-player', nickname: 'Player', created_at: '2026-11-23T00:00:00Z' }]
              : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const context = { state, setTimeout, clearTimeout, console: { warn: (...args) => warnings.push(args) },
    ROOM_ARCHIVE_RETENTION_HOURS: 96, SUPABASE_ROOM_LIST_SELECT: '', SUPABASE_ROOM_MONITOR_SELECT: '',
    supabaseClient: async () => client, scrollSnapshot: () => ({}), restoreScrollSnapshot() {},
    loadRoomRollStats: async () => room => room,
    supabaseRoomSummary: room => ({ id: room.id, players: [] }),
    playerNameKey: value => String(value || '').toLowerCase(), isRecentActivity: () => false,
    setUnreadAdminMessages() {}, saveWatch() {}, render() { calls.push('render'); },
    adminAuthErrorMessage: error => error.message, t: key => 'translated:' + key };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function pruneRoomArchive('), source.indexOf('async function openRoom(')), context);
  return { context, state, calls, warnings };
}

for (const [name, prune] of [
  ['foreign-key response', () => ({ error: { code: '23503', message: 'room_game_archives violates long_bot_board_reviews_archive_id_fkey' } })],
  ['rejected cleanup request', () => { throw Error('Failed to fetch'); }],
]) test('admin refresh still loads rooms and players after a ' + name, async () => {
  const r = runtime(prune);
  await r.context.refresh();
  assert.equal(r.state.admin.id, 'existing-admin');
  assert.equal(r.state.active[0].id, 'active-room');
  assert.equal(r.state.archive[0].id, 'archived-room');
  assert.equal(r.state.users[0].id, 'existing-player');
  assert.equal(r.state.usersError, '');
  assert.equal(r.state.archiveCleanupWarning, 'translated:archive_cleanup_unavailable');
  assert.equal(r.calls.filter(name => name === 'render').length, 1);
  assert.equal(r.warnings.length, 1);
});

test('a subsequent successful cleanup clears its warning while keeping the dashboard loaded', async () => {
  let failed = true;
  const r = runtime(() => ({ error: failed ? { message: 'retention failure' } : null }));
  await r.context.refresh();
  failed = false;
  await r.context.refresh();
  assert.equal(r.state.archiveCleanupWarning, '');
  assert.equal(r.state.users.length, 1);
  assert.equal(r.state.archive.length, 1);
});

test('an older server without optional cleanup does not prevent dashboard reads', async () => {
  const r = runtime(() => ({ error: { message: 'Could not find the function public.admin_prune_room_archive' } }));
  await r.context.refresh();
  assert.equal(r.state.archiveCleanupWarning, '');
  assert.equal(r.state.users.length, 1);
  assert.equal(r.warnings.length, 0);
});

test('base schema and deploy migration contain the same archive-retention functions', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/admin-archive-training-retention-v1.sql'), 'utf8');
  const functions = migration.slice(migration.indexOf('-- Training sources'), migration.indexOf('notify pgrst')).trim();
  assert.ok(schema.includes(functions));
});

test('an unavailable training catalogue cannot hide rooms or players', async () => {
  const r = runtime(() => ({ error: null }), async () => { throw Error('library unavailable'); });
  await r.context.refresh();
  assert.equal(r.state.active[0].id, 'active-room');
  assert.equal(r.state.users[0].id, 'existing-player');
  assert.equal(r.warnings.length, 1);
});
