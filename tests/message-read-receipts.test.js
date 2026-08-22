const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('friend-message recipients can persist read receipts', () => {
  const schema = read('supabase/schema.sql');
  const migration = read('supabase/friend-message-read-receipts-v24.sql');
  for (const sql of [schema, migration]) {
    assert.match(sql, /create policy "recipients can mark friend messages read"/);
    assert.match(sql, /on public\.friend_messages for update/);
    assert.match(sql, /using \(to_user_id = auth\.uid\(\)\)/);
    assert.match(sql, /with check \(to_user_id = auth\.uid\(\)\)/);
    assert.match(sql, /grant update \(read_at\) on public\.friend_messages to authenticated/);
  }
});

test('account UI only clears unread badges after a successful database update', () => {
  const settings = read('settings.html');
  assert.match(settings, /const \{ error: markReadError \} = await client[\s\S]*?from\('friend_messages'\)[\s\S]*?eq\('to_user_id', profile\.id\)[\s\S]*?if \(markReadError\) throw new Error\(markReadError\.message\)/);
  assert.match(settings, /function clearFriendUnread\(friendId\)[\s\S]*?friend\.unread = 0[\s\S]*?querySelector\('\.unread-badge'\)\?\.remove\(\)/);
  assert.match(settings, /from\('admin_player_messages'\)[\s\S]*?eq\('direction', 'admin'\)[\s\S]*?if \(markReadError\) throw markReadError/);
});
