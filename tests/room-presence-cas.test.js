const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('concurrent room heartbeats retry with CAS and preserve both player slots', async () => {
  const now = Date.now();
  let room = {
    id: 'room-1',
    code: 'CAS1-ROOM',
    presence: {
      white: { color: 'white', name: 'White', lastSeen: now - 1000 },
      dark: { color: 'dark', name: 'Dark', lastSeen: now - 1000 },
    },
    game_state: { phase: 'move', turn: 'white', history: [] },
    game_version: 4,
    status: 'joined',
    updated_at: '2026-09-14T10:00:00.000Z',
  };
  const updateFilters = [];
  let loads = 0;
  let policyLoads = 0;
  let updates = 0;

  function query() {
    let updatePayload = null;
    let policyRead = false;
    const filters = [];
    const chain = {
      select(columns) { policyRead = Boolean(columns?.includes('fair_dice_required')); return chain; },
      update(payload) { updatePayload = payload; return chain; },
      eq(column, value) { filters.push(['eq', column, value]); return chain; },
      neq(column, value) { filters.push(['neq', column, value]); return chain; },
      in(column, value) { filters.push(['in', column, value]); return chain; },
      maybeSingle() {
        if (!updatePayload) {
          if (policyRead) {
            policyLoads += 1;
            assert.deepEqual(filters, [['eq', 'code', 'CAS1-ROOM'], ['neq', 'status', 'closed']]);
            return Promise.resolve({ data: { ...JSON.parse(JSON.stringify(room)), fair_dice_required: false }, error: null });
          }
          loads += 1;
          return Promise.resolve({ data: JSON.parse(JSON.stringify(room)), error: null });
        }
        updates += 1;
        updateFilters.push(filters.map(item => [...item]));
        if (updates === 1) {
          // Dark commits after White's SELECT but before White's PATCH.
          room = {
            ...room,
            presence: {
              ...room.presence,
              dark: { color: 'dark', name: 'Dark', lastSeen: now + 50 },
            },
            updated_at: '2026-09-14T10:00:01.000Z',
          };
          return Promise.resolve({ data: null, error: null });
        }
        const expectedUpdatedAt = filters.find(item => item[1] === 'updated_at')?.[2];
        const expectedVersion = filters.find(item => item[1] === 'game_version')?.[2];
        assert.equal(expectedUpdatedAt, room.updated_at);
        assert.equal(expectedVersion, room.game_version);
        room = {
          ...room,
          ...JSON.parse(JSON.stringify(updatePayload)),
          updated_at: '2026-09-14T10:00:02.000Z',
        };
        return Promise.resolve({ data: JSON.parse(JSON.stringify(room)), error: null });
      },
    };
    return chain;
  }

  const window = {
    NarduSupabase: {
      configured: () => true,
      client: async () => ({ from: query }),
    },
  };
  window.window = window;
  const context = {
    window,
    localStorage: memoryStorage(),
    console,
    Date,
    Math,
    JSON,
    Map,
    Uint8Array,
    TextEncoder,
    fetch,
  };
  context.globalThis = window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'rooms-client.js'), 'utf8'), context, {
    filename: 'rooms-client.js',
  });

  const result = await window.NarduRooms.updatePresence('CAS1-ROOM', {
    color: 'white',
    name: 'White',
  });

  assert.equal(result.ok, true);
  assert.equal(loads, 2);
  assert.equal(policyLoads, 1);
  assert.equal(updates, 2);
  assert.equal(room.presence.dark.lastSeen, now + 50);
  assert.ok(room.presence.white.lastSeen >= now);
  assert.deepEqual(updateFilters[0].slice(-4).map(item => item[1]), [
    'id',
    'updated_at',
    'game_version',
    'status',
  ]);

  room = {
    ...room,
    status: 'over',
    game_state: { ...room.game_state, phase: 'over', winner: 'dark' },
  };
  const final = await window.NarduRooms.updatePresence('CAS1-ROOM', {
    color: 'white',
    name: 'White',
  });
  assert.equal(final.state.winner, 'dark');
  assert.equal(final.version, 4);
  assert.equal(updates, 2, 'a final room is returned without an RLS-blocked presence PATCH');
  assert.equal(policyLoads, 1, 'cached legacy policy reads do not alter heartbeat retry counts');
});

test('spectator-only updates do not invalidate the player presence lock', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
  assert.match(schema, /function public\.set_room_updated_at\(\)[\s\S]*to_jsonb\(new\) - 'updated_at' - 'spectators'[\s\S]*new\.updated_at = old\.updated_at/);
  assert.match(schema, /create trigger rooms_set_updated_at[\s\S]*execute function public\.set_room_updated_at\(\)/);
  assert.match(schema, /function public\.archive_finished_room_game\(\)[\s\S]*security definer[\s\S]*set search_path = ''/);
  assert.match(schema, /revoke all on function public\.archive_finished_room_game\(\) from public/);
});
