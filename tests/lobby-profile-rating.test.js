const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const lobby = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const userKey = 'narduh-user';
const player = {
  id: 'player-1',
  name: 'Player',
  nickname: 'Player',
  rating: 1146,
  tier: 'Bronze',
  ratingEligible: true,
  history: [{ resultKey: 'finished-game', historyCount: 3 }],
};

function profileHarness({ getProfile, initialUser = player, authUserId = player.id, guestCredential = null }) {
  const values = new Map([[userKey, JSON.stringify(initialUser)]]);
  if (guestCredential) values.set('narduh-guest-credential-v1', JSON.stringify(guestCredential));
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const ownRating = { textContent: String(initialUser.rating ?? '—') };
  let authChecks = 0;
  const selects = [];
  const profileQuery = {
    select(columns) {
      assert.deepEqual(columns.split(',').map(column => column.trim()).sort(), ['id', 'rating', 'rating_eligible', 'tier']);
      return profileQuery;
    },
    eq(column, id) {
      assert.equal(column, 'id');
      selects.push(id);
      const response = () => getProfile(id);
      return { maybeSingle: response, single: response };
    },
  };
  const client = {
    auth: { getUser: async () => {
      authChecks += 1;
      return { data: { user: { id: authUserId } }, error: null };
    } },
    from(table) {
      assert.equal(table, 'profiles');
      return profileQuery;
    },
  };
  const window = { NarduSupabase: { configured: () => true, client: async () => client } };
  vm.runInNewContext(app, {
    window,
    document: {
      readyState: 'loading',
      documentElement: { setAttribute() {}, style: { setProperty() {} } },
      addEventListener() {},
      querySelectorAll: selector => selector === '[data-user-rating]' ? [ownRating] : [],
    },
    localStorage: storage,
    console: { warn() {} },
    setTimeout,
    clearTimeout,
  });
  return {
    app: window.NarduApp,
    ownRating,
    selects,
    authChecks: () => authChecks,
    replaceUser: user => storage.setItem(userKey, JSON.stringify(user)),
  };
}

const approvedRating = (value = 1169, id = player.id) => ({
  data: { id, rating: value, tier: 'Bronze', rating_eligible: true },
  error: null,
});

test('the own profile rating is refreshed from the authenticated Supabase row and repainted in the lobby', async () => {
  const { app, ownRating, selects } = profileHarness({ getProfile: async () => approvedRating() });
  await app.refreshProfileRating();

  assert.deepEqual(selects, [player.id]);
  assert.equal(app.getUser().rating, 1169);
  assert.equal(ownRating.textContent, '1169');
  assert.equal(app.getUser().nickname, player.nickname);
  assert.equal(app.getUser().history[0].resultKey, 'finished-game');
});

test('a restored lobby redraws a stale rating even when the browser profile is already current', async () => {
  const { app, ownRating } = profileHarness({
    initialUser: { ...player, rating: 1169 },
    getProfile: async () => approvedRating(),
  });
  // BFCache restores the previous DOM separately from shared localStorage.
  ownRating.textContent = '1146';
  await app.refreshProfileRating();

  assert.equal(app.getUser().rating, 1169);
  assert.equal(ownRating.textContent, '1169');
});

test('a profile response cannot overwrite a rating just confirmed by a match or another active account', async () => {
  for (const change of [{ rating: 1190 }, { id: 'player-2', rating: 1314 }]) {
    let release;
    let requestStarted;
    const didStart = new Promise(resolve => { requestStarted = resolve; });
    const { app, replaceUser } = profileHarness({ getProfile: () => {
      requestStarted();
      return new Promise(resolve => { release = resolve; });
    } });
    const pending = app.refreshProfileRating();
    await didStart;
    replaceUser({ ...player, ...change });
    release(approvedRating());
    await pending;

    assert.equal(app.getUser().id, change.id || player.id);
    assert.equal(app.getUser().rating, change.rating);
  }
});

test('a guest or a mismatched authenticated session does not read a registered profile rating', async () => {
  const proof = `gproof:${'51'.repeat(32)}`;
  const guestId = `guest:sha256:${createHash('sha256').update(`nardu/guest/v1:${proof}`).digest('hex')}`;
  const guest = profileHarness({
    getProfile: async () => approvedRating(),
    initialUser: { id: guestId, name: 'Guest1000', guest: true, rating: null },
    guestCredential: { version: 1, guestId, proof },
  });
  assert.equal(guest.app.getUser().guest, true);
  await guest.app.refreshProfileRating();
  assert.equal(guest.authChecks(), 0);
  assert.deepEqual(guest.selects, []);

  const mismatch = profileHarness({ getProfile: async () => approvedRating(), authUserId: 'another-player' });
  await mismatch.app.refreshProfileRating();
  assert.deepEqual(mismatch.selects, []);
  assert.equal(mismatch.app.getUser().rating, 1146);
});

test('opening or resuming the lobby refreshes the current profile independently of its public rating visibility', () => {
  assert.match(lobby, /data-user-rating/);
  for (const event of ['pageshow', 'focus', 'online', 'visibilitychange']) {
    assert.match(lobby, new RegExp(`addEventListener\\('${event}', refreshLobbyProfileRating\\)`));
  }
  assert.match(lobby, /refreshLobbyProfileRating\(\);/);
});
