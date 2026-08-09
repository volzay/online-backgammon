const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('lobby exposes the personal account link and message bell', () => {
  const lobby = read('index.html');
  assert.match(lobby, /href="settings\.html#account" data-i18n="nav_account">Личный кабинет/);
  assert.match(lobby, /data-message-notification/);
  assert.match(lobby, /data-message-notification-count/);
});

test('message bell combines unread player and administrator messages', () => {
  const app = read('app.js');
  assert.match(app, /from\('friend_messages'\)[\s\S]*?eq\('to_user_id', userId\)[\s\S]*?is\('read_at', null\)/);
  assert.match(app, /from\('admin_player_messages'\)[\s\S]*?eq\('player_user_id', userId\)[\s\S]*?eq\('direction', 'admin'\)[\s\S]*?is\('read_at', null\)/);
  assert.match(app, /paintLobbyMessageIndicator\([\s\S]*friendResult[\s\S]*adminResult/);
  assert.match(app, /setInterval\(refreshLobbyMessageIndicator, 5000\)/);
  assert.match(app, /window\.NarduApp = \{[\s\S]*refreshLobbyMessageIndicator/);
});

test('message bell renders the combined unread count', async () => {
  const stored = new Map([['narduh-user', JSON.stringify({
    id: 'player-1', name: 'tester1', nickname: 'tester1', guest: false,
  })]]);
  const badge = { textContent: '', hidden: true };
  const classes = new Set();
  const indicator = {
    title: '',
    querySelector: selector => selector === '[data-message-notification-count]' ? badge : null,
    classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
    setAttribute(name, value) { this[name] = value; },
  };
  const document = {
    readyState: 'loading',
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
    querySelector: selector => selector === '[data-message-notification]' ? indicator : null,
    querySelectorAll: selector => selector === '[data-message-notification]' ? [indicator] : [],
    addEventListener() {},
  };
  const localStorage = {
    getItem: key => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: key => stored.delete(key),
  };
  const queryFor = table => {
    const query = {
      select() { return query; },
      eq() { return query; },
      is() { return Promise.resolve({ count: table === 'friend_messages' ? 2 : 1, error: null }); },
    };
    return query;
  };
  const window = {
    addEventListener() {},
    NarduSupabase: {
      configured: () => true,
      client: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: 'player-1' } }, error: null }) },
        from: queryFor,
      }),
    },
  };
  window.window = window;
  const context = {
    window, document, localStorage,
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { href: '' }, console, Date, Math, JSON,
    setInterval() { return 1; }, CustomEvent: class {},
  };
  context.globalThis = window;
  vm.createContext(context);
  vm.runInContext(read('app.js'), context, { filename: 'app.js' });

  await window.NarduApp.refreshLobbyMessageIndicator();

  assert.equal(badge.textContent, '3');
  assert.equal(badge.hidden, false);
  assert.equal(indicator['aria-label'], 'Новых сообщений: 3');
  assert.equal(classes.has('has-unread'), true);
});
