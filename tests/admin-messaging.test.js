const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('admin messaging is durable, private, and idempotent', () => {
  const schema = read('supabase/schema.sql');
  assert.match(schema, /create table if not exists public\.admin_message_campaigns/);
  assert.match(schema, /create table if not exists public\.admin_player_messages/);
  assert.match(schema, /admins and recipients can read admin messages/);
  assert.match(schema, /create or replace function public\.admin_send_player_message/);
  assert.match(schema, /create or replace function public\.player_reply_to_admin/);
  assert.match(schema, /admin_player_messages_admin_client_unique/);
  assert.match(schema, /admin_player_messages_player_client_unique/);
});

test('broadcasts are filtered by rating on the server', () => {
  const schema = read('supabase/schema.sql');
  assert.match(schema, /create or replace function public\.admin_send_broadcast/);
  assert.match(schema, /p_min_rating is null or p\.rating >= p_min_rating/);
  assert.match(schema, /p_max_rating is null or p\.rating <= p_max_rating/);
  assert.match(schema, /p\.rating_eligible is true/);
  assert.match(schema, /recipient_count = delivered/);
});

test('admin and player interfaces expose the conversation workflow', () => {
  const admin = read('homegate.js');
  const settings = read('settings.html');
  assert.match(admin, /data-admin-tab="messages"/);
  assert.match(admin, /data-form="admin-broadcast"/);
  assert.match(admin, /data-broadcast-rating/);
  assert.match(admin, /admin_send_player_message/);
  assert.match(admin, /admin_send_broadcast/);
  assert.match(admin, /unreadAdminMessagesByPlayer/);
  assert.match(admin, /admin-tab-unread/);
  assert.match(admin, /\.eq\("direction", "player"\)[\s\S]*\.is\("read_at", null\)/);
  assert.match(admin, /delete state\.unreadAdminMessagesByPlayer\[state\.selectedMessagePlayerId\]/);
  assert.match(admin, /adminMessageDrafts/);
  assert.match(admin, /adminMessageEditorActive\(\)/);
  assert.match(admin, /state\.adminMessageDrafts\[draftName\]\[event\.target\.name\] = event\.target\.value/);
  assert.match(settings, /id="admin-message-thread"/);
  assert.match(settings, /id="admin-message-form"/);
  assert.match(settings, /player_reply_to_admin/);
  const styles = read('styles.css');
  assert.match(styles, /#admin-message-form\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
});
