const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${signature}`);
}

test('message reads require explicit visible-thread intent in both storage modes', () => {
  const settings = read('settings.html');
  const server = read('server.js');

  assert.match(settings, /async function loadMessages\(friendId, \{ silent = false, markRead = false \} = \{\}\)/);
  assert.match(settings, /if \(markRead && friendThreadCanBeRead\(friendId\)\) \{[\s\S]*?markSupabaseFriendMessagesRead\(friendId, data\.unreadIds \|\| \[\]\)/);
  assert.match(settings, /accountApi\('\/api\/account\/messages\/read', \{[\s\S]*?method: 'POST'/);
  assert.match(server, /method === "POST" && parts\.length === 4 && parts\[2\] === "messages" && parts\[3\] === "read"/);
  assert.match(settings, /threadWasNearBottom\(thread\)/);
});

test('message windows merge recent context with every paged unread message', () => {
  const settings = read('settings.html');

  assert.match(settings, /from\('admin_player_messages'\)[\s\S]*?order\('created_at', \{ ascending: false \}\)[\s\S]*?limit\(200\)/);
  assert.match(settings, /collectSupabasePages\(\(from, to\) => client[\s\S]*?from\('admin_player_messages'\)[\s\S]*?eq\('direction', 'admin'\)[\s\S]*?is\('read_at', null\)[\s\S]*?range\(from, to\)/);
  assert.match(settings, /accountState\.adminMessages = mergeMessageRows\(recentMessages, unreadMessages\)/);
  assert.match(settings, /from\('friend_messages'\)[\s\S]*?order\('created_at', \{ ascending: false \}\)[\s\S]*?limit\(100\)/);
  assert.match(settings, /collectSupabasePages\(\(from, to\) => client[\s\S]*?from\('friend_messages'\)[\s\S]*?eq\('to_user_id', profile\.id\)[\s\S]*?is\('read_at', null\)[\s\S]*?range\(from, to\)/);
  assert.match(settings, /const orderedMessages = mergeMessageRows\(recentMessages, unreadMessages\)/);
  assert.match(settings, /updateSupabaseReadBatches\(unreadIds, ids => client[\s\S]*?update\(\{ read_at: readAt \}\)[\s\S]*?in\('id', ids\)/);
  assert.match(settings, /markSupabaseFriendMessagesRead\(friendId, data\.unreadIds \|\| \[\]\)/);
});

test('unread pagination and read updates continue beyond one Supabase page', async () => {
  const settings = read('settings.html');
  const source = [
    extractFunction(settings, 'async function collectSupabasePages'),
    extractFunction(settings, 'async function updateSupabaseReadBatches'),
  ].join('\n');
  const context = vm.createContext({});
  vm.runInContext(`${source}\nthis.collectPages = collectSupabasePages; this.updateBatches = updateSupabaseReadBatches;`, context);

  const allRows = Array.from({ length: 205 }, (_, index) => ({ id: `message-${index}` }));
  const requestedRanges = [];
  const loaded = await context.collectPages(async (from, to) => {
    requestedRanges.push([from, to]);
    return { data: allRows.slice(from, to + 1), error: null };
  });
  assert.equal(loaded.length, 205);
  assert.deepEqual(requestedRanges, [[0, 99], [100, 199], [200, 299]]);

  const updatedBatches = [];
  const updateError = await context.updateBatches(allRows.map(row => row.id), async ids => {
    updatedBatches.push([...ids]);
    return { error: null };
  });
  assert.equal(updateError, null);
  assert.deepEqual(updatedBatches.map(ids => ids.length), [100, 100, 5]);
});

test('the lobby message destination exposes both administration and friend conversations', () => {
  const settings = read('settings.html');
  assert.match(settings, /id="messages"[\s\S]*?href="#admin-messages"[\s\S]*?href="#friend-messages"/);
  assert.match(settings, /id="friend-message-source-count"/);
  assert.match(settings, /id="admin-message-source-count"/);
  assert.match(settings, /function parentSettingsHash\(hash\)[\s\S]*?#admin-messages'[\s\S]*?#friend-messages'[\s\S]*?'#messages'/);
  assert.match(settings, /function activateSettingsHash\(hash = window\.location\.hash\)[\s\S]*?target === '#messages' \|\| target === '#admin-messages'[\s\S]*?loadAdminMessages\(\{ silent: true, markRead: true \}\)/);
  assert.match(settings, /\[\.\.\.navLinks, \.\.\.messageSourceLinks\][\s\S]*?window\.addEventListener\('hashchange'/);
  assert.doesNotMatch(settings, /getElementById\('messages'\)\?\.addEventListener\('pointerdown'/);
  assert.match(settings, /id="admin-message-thread" role="region" tabindex="0"/);
  assert.match(settings, /id="friend-message-thread" role="region" tabindex="0"/);
  assert.doesNotMatch(settings, /class="message-thread"[^>]*(?:role="log"|aria-live="polite")/);
});

test('account does not silently open a friend thread and keeps guest identity visible', () => {
  const settings = read('settings.html');

  assert.doesNotMatch(settings, /selectedFriendId = friends\[0\]\.id/);
  assert.match(settings, /<div class="s-row account-readonly-row">[\s\S]*?id="acc-nick"/);
  assert.match(settings, /<div class="s-row account-readonly-row" data-registered-only>[\s\S]*?id="acc-email"/);
  assert.match(settings, /id="guest-account-cta" hidden/);
  assert.doesNotMatch(settings, /function registeredUser\(\) \{[\s\S]{0,180}isRatedUser/);
  assert.doesNotMatch(settings, /function saveAccountProfile\(/);
});

test('nickname-only accounts do not expose their internal synthetic email', () => {
  const settings = read('settings.html');
  const source = extractFunction(settings, 'function displayAccountEmail');
  const displayAccountEmail = new Function(`${source}\nreturn displayAccountEmail;`)();

  assert.equal(displayAccountEmail('user-123@nickname.local'), '');
  assert.equal(displayAccountEmail('player+abc@local.nardy'), '');
  assert.equal(displayAccountEmail('player@example.test'), 'player@example.test');
  assert.match(settings, /displayAccountEmail\(user\.email\) \|\| '—'/);
});

test('a legacy fallback profile without a server cookie is sent through re-authentication', () => {
  const settings = read('settings.html');
  const app = read('app.js');
  const login = read('login.html');
  assert.match(settings, /response\.status === 401[\s\S]*?AUTH_SESSION_MISSING[\s\S]*?redirectForAuthError/);
  assert.match(app, /function redirectForAuthError\(error, returnTo = 'index\.html'\)/);
  assert.match(login, /function postLoginDestination\(\)[\s\S]*?reauthContext/);
});

test('friend message responses cannot repaint a newly selected conversation', () => {
  const settings = read('settings.html');

  assert.match(settings, /const requestId = \+\+accountState\.messageRequestId/);
  assert.match(settings, /requestId !== accountState\.messageRequestId \|\| accountState\.selectedFriendId !== friendId/);
});

test('account controls expose truthful labels and keyboard focus', () => {
  const settings = read('settings.html');
  const styles = read('styles.css');

  assert.match(settings, /data-i18n="account_cabinet_title">Личный кабинет/);
  assert.doesNotMatch(settings, /id="notify"/);
  assert.match(settings, /id="move-hints-toggle" aria-labelledby="move-hints-label"/);
  assert.doesNotMatch(styles, /\.switch input \{ display: none; \}/);
  assert.match(styles, /\.switch input:focus-visible \+ \.sw/);
});

test('destructive account dialog explains impact and initially focuses cancel', () => {
  const settings = read('settings.html');

  assert.match(settings, /aria-describedby="delete-account-description"/);
  assert.match(settings, /id="delete-account-description"[\s\S]*?data-i18n="delete_account_irreversible"/);
  assert.match(settings, /function openDeleteAccountModal\(\)[\s\S]*?getElementById\('delete-account-cancel'\)\?\.focus\(\)/);
});
