const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function quotaStorage(initial = {}, limit = 900) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.get(key) || null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) {
      const next = new Map(values);
      next.set(key, String(value));
      const size = [...next.entries()].reduce((sum, [name, item]) => sum + name.length + item.length, 0);
      if (size > limit) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
      values.set(key, String(value));
    },
  };
}

async function loadClient(storage) {
  let clientOptions = null;
  const context = {
    window: {
      NARDU_ENV: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon' },
      supabase: {
        createClient(url, key, options) {
          clientOptions = options;
          return { url, key, options };
        },
      },
    },
    document: { querySelector() { return null; }, createElement() { return {}; }, head: { appendChild() {} } },
    localStorage: storage,
    console,
    Set,
  };
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'supabase-client.js'), 'utf8'), context, { filename: 'supabase-client.js' });
  await context.window.NarduSupabase.client();
  return { storage: clientOptions.auth.storage, api: context.window.NarduSupabase };
}

test('Supabase auth token storage evicts reproducible game caches before losing a session', async () => {
  const storage = quotaStorage({
    'narduh-long-bot-server-experience-v2': 'x'.repeat(620),
    'narduh-user': JSON.stringify({ id: 'user-1', name: 'warlord', history: [] }),
    'sb-other-auth-token': 'active-session',
  });
  const client = await loadClient(storage);

  assert.doesNotThrow(() => client.storage.setItem('sb-project-auth-token', 'token'.repeat(40)));
  assert.equal(storage.getItem('narduh-long-bot-server-experience-v2'), null);
  assert.equal(storage.getItem('sb-project-auth-token'), 'token'.repeat(40));
  assert.equal(storage.getItem('sb-other-auth-token'), 'active-session');
  assert.match(storage.getItem('narduh-user'), /warlord/);
});
