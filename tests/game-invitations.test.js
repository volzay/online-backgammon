const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'game-invitations.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function createElement(tag) {
  const listeners = new Map();
  const attributes = new Map();
  let text = '';
  const element = {
    tag,
    children: [],
    dataset: {},
    hidden: false,
    disabled: false,
    set textContent(value) {
      text = String(value);
      this.children.length = 0;
    },
    get textContent() {
      return this.children.length ? this.children.map(child => child.textContent).join('') : text;
    },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.append(child); return child; },
    replaceChildren(...children) { this.children = children; text = ''; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    focus() {},
    click() {
      if (!this.disabled) return listeners.get('click')?.({ currentTarget: this, target: this });
    },
  };
  return element;
}

function elements(element, predicate) {
  return [
    ...(predicate(element) ? [element] : []),
    ...element.children.flatMap(child => elements(child, predicate)),
  ];
}

function harness(rpcResult, options = {}) {
  const events = [];
  const listeners = new Map();
  const calls = [];
  const sounds = [];
  const player = { id: 'player-1' };
  const persisted = options.persisted ?? new Map();
  const page = options.page ?? 'settings.html';
  const storage = {
    getItem: key => persisted.get(key) ?? null,
    setItem: (key, value) => persisted.set(key, String(value)),
    removeItem: key => persisted.delete(key),
  };
  const location = { href: 'https://example.test/' + page };
  location.assign = value => { location.href = value; };
  location.replace = value => { location.href = value; };
  let poll;
  const lobbyElements = new Map();
  if (options.lobby) {
    const section = createElement('section');
    const list = createElement('div');
    const status = createElement('p');
    section.append(list, status);
    lobbyElements.set('game-invitations', section);
    lobbyElements.set('game-invitations-list', list);
    lobbyElements.set('game-invitations-status', status);
  }
  const document = {
    readyState: 'loading',
    hidden: false,
    body: createElement('body'),
    createElement,
    getElementById: id => lobbyElements.get(id) ?? null,
    addEventListener: (event, callback) => listeners.set(event, callback),
  };
  const window = {
    location,
    localStorage: storage,
    sessionStorage: storage,
    NarduApp: {
      getUser: () => player,
      t: key => key,
      currentSound: () => options.soundOn !== false,
      safeStorageSet: (key, value) => storage.setItem(key, value),
    },
    NarduSound: {
      invitation() {
        sounds.push('invitation');
        return options.playSound?.() ?? true;
      },
    },
    NarduRooms: { getRoom: options.getRoom ?? (async () => ({ room: null })) },
    NarduSupabase: {
      configured: () => true,
      client: async () => ({ rpc(name, args) {
        calls.push([name, args ? { ...args } : undefined]);
        return rpcResult(name, args);
      } }),
    },
    addEventListener: (event, callback) => listeners.set(event, callback),
    dispatchEvent: event => events.push(event),
  };
  vm.runInNewContext(source, {
    document,
    window,
    location,
    sessionStorage: storage,
    localStorage: storage,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout(callback, delay) {
      const timeout = setTimeout(callback, delay);
      timeout.unref();
      return timeout;
    },
    clearTimeout,
    CustomEvent: class {
      constructor(name, { detail }) { Object.assign(this, { name, detail }); }
    },
    setInterval(callback, delay) { poll = { callback, delay }; },
  });
  listeners.get('DOMContentLoaded')();
  function notice() {
    if (options.lobby) return lobbyElements.get('game-invitations');
    const matches = elements(document.body, element => element.className?.split(/\s+/).includes('game-invitations-notice'));
    assert.equal(matches.length, 1, 'single invitation notification');
    return matches[0];
  }
  function action(key) {
    const matches = elements(notice(), element => element.tag === 'button' && element.textContent === key);
    assert.equal(matches.length, 1, 'find invitation action ' + key);
    return matches[0];
  }
  return { invitations: window.NarduGameInvitations, calls, document, events, listeners, notice, action, player, poll, sounds, location, persisted };
}

test('the invitation client sends the selected rules and answers by exact invitation ID', async () => {
  const { invitations, calls } = harness(async () => ({ data: { incoming: [], outgoing: [] } }));
  await invitations.listTargets();
  await invitations.send('recipient-2', 'short');
  await invitations.send('recipient-3', 'long');
  await invitations.answer('invite-1', true);
  await invitations.answer('invite-2', false);
  assert.deepEqual(calls, [
    ['list_lobby_game_invitations', undefined],
    ['list_lobby_invite_targets', undefined],
    ['send_lobby_game_invitation', { p_target: 'recipient-2', p_variant: 'short' }],
    ['send_lobby_game_invitation', { p_target: 'recipient-3', p_variant: 'long' }],
    ['answer_lobby_game_invitation', { p_invitation_id: 'invite-1', p_accept: true }],
    ['answer_lobby_game_invitation', { p_invitation_id: 'invite-2', p_accept: false }],
  ]);
});

const shortInvite = { id: 'invite-1', nickname: '<img src=x>', variant: 'short' };
const longInvite = { id: 'invite-2', nickname: 'Opponent B', variant: 'long' };
const inbox = (...incoming) => ({ data: { incoming, outgoing: [] } });
const ANSWER_RPC = 'answer_lobby_game_invitation';
const ACCEPT = 'game_invitation_accept';
const DECLINE = 'game_invitation_decline';
const ROOM_CODE = 'ROOM-TEST';
const waitingPage = 'https://example.test/settings.html';

test('the shared notification remains actionable after poll failure and disappears when the inbox clears', async () => {
  let response = inbox(shortInvite);
  const { action, calls, document, events, notice, poll, sounds } = harness(async () => response);
  await flush();

  assert.equal(events.at(-1).name, 'nardu:game-invitations');
  assert.deepEqual(Array.from(events.at(-1).detail.incoming), [shortInvite]);
  assert.equal(notice().hidden, false);
  assert.ok(notice().textContent.includes(shortInvite.nickname), 'display nickname as text');
  assert.equal(elements(notice(), element => element.tag === 'img').length, 0);
  assert.equal(action(ACCEPT).disabled, false);
  assert.equal(action(DECLINE).disabled, false);
  assert.equal(poll.delay, 10000);
  assert.equal(sounds.length, 1);

  document.hidden = true;
  await poll.callback();
  assert.equal(calls.length, 1);
  document.hidden = false;
  response = { error: new Error('Unavailable') };
  await poll.callback();
  assert.equal(notice().hidden, false);
  assert.deepEqual(Array.from(events.at(-1).detail.incoming), [shortInvite]);
  assert.equal(action(ACCEPT).disabled, false);

  response = inbox(shortInvite);
  await poll.callback();
  assert.equal(sounds.length, 1, 'resumed polling does not replay a sound');
  response = inbox();
  await poll.callback();
  assert.equal(notice().hidden, true);
  assert.equal(events.at(-1).detail.incoming.length, 0);
});

test('a new invite chimes once and reopening an already displayed invite does not replay it', async () => {
  let response = inbox(shortInvite);
  const first = harness(async () => response);
  await flush();
  assert.equal(first.sounds.length, 1);
  response = inbox(shortInvite, longInvite);
  await first.poll.callback();
  assert.equal(first.sounds.length, 2, 'notify for a newly arrived ID');

  const second = harness(async () => response, { persisted: first.persisted, page: 'rules.html' });
  await flush();
  assert.equal(second.notice().hidden, false);
  assert.equal(second.sounds.length, 0, 'keep the invitation visible without replaying audio on another page');
});

test('the lobby inline alert uses the same sound and actions as other pages', async () => {
  const state = harness(async () => inbox(shortInvite), { lobby: true, page: 'index.html' });
  await flush();
  assert.equal(state.notice().hidden, false);
  assert.equal(state.action(ACCEPT).disabled, false);
  assert.equal(state.action(DECLINE).disabled, false);
  assert.equal(state.document.body.children.length, 0, 'do not duplicate the inline alert');
  assert.equal(state.sounds.length, 1);
});

test('muting site sound keeps the invitation visible without calling the audio API', async () => {
  const state = harness(async () => inbox(shortInvite), { soundOn: false });
  await flush();
  assert.equal(state.notice().hidden, false);
  assert.equal(state.sounds.length, 0);
});

test('a browser-blocked chime retries on audio readiness only while the invite is pending', async () => {
  let allowSound = false;
  let response = inbox(shortInvite);
  const state = harness(async () => response, { playSound: () => allowSound });
  await flush();
  assert.equal(state.notice().hidden, false);
  assert.equal(state.sounds.length, 1);

  allowSound = true;
  await state.listeners.get('nardu:audio-ready')();
  assert.equal(state.sounds.length, 2);
  await state.listeners.get('nardu:audio-ready')();
  await state.poll.callback();
  assert.equal(state.sounds.length, 2, 'successful chime is never retried');

  allowSound = false;
  response = inbox(longInvite);
  await state.poll.callback();
  const attempts = state.sounds.length;
  response = inbox();
  await state.poll.callback();
  allowSound = true;
  await state.listeners.get('nardu:audio-ready')();
  assert.equal(state.sounds.length, attempts, 'expired invitation is silent after audio unlock');
});

test('declining from the notice answers the matching invitation and stays on this page', async () => {
  let remaining = [shortInvite];
  const state = harness(async name => {
    if (name === ANSWER_RPC) {
      remaining = [];
      return { data: {} };
    }
    return inbox(...remaining);
  });
  await flush();
  await state.action(DECLINE).click();
  await flush();
  assert.deepEqual(state.calls.filter(([name]) => name === ANSWER_RPC), [
    [ANSWER_RPC, { p_invitation_id: shortInvite.id, p_accept: false }],
  ]);
  assert.equal(state.location.href, waitingPage);
  assert.equal(state.notice().hidden, true);
});

test('accepting a notice waits for the matching guest seat and navigates to that room', async () => {
  let finishRoom;
  const getRoomCalls = [];
  let remaining = [longInvite];
  const state = harness(async name => {
    if (name === ANSWER_RPC) {
      remaining = [];
      return { data: { room_code: ROOM_CODE } };
    }
    return inbox(...remaining);
  }, {
    getRoom(code) {
      getRoomCalls.push(code);
      return new Promise(resolve => { finishRoom = resolve; });
    },
  });
  await flush();
  const acceptButton = state.action(ACCEPT);
  const accepting = acceptButton.click();
  await flush();
  assert.deepEqual(state.calls.filter(([name]) => name === ANSWER_RPC), [
    [ANSWER_RPC, { p_invitation_id: longInvite.id, p_accept: true }],
  ]);
  assert.deepEqual(getRoomCalls, [ROOM_CODE]);
  assert.equal(state.location.href, waitingPage);
  acceptButton.click();
  await flush();
  assert.equal(state.calls.filter(([name]) => name === ANSWER_RPC).length, 1, 'accept remains single-flight');
  finishRoom({
    room: {
      code: ROOM_CODE,
      status: 'joined',
      variant: 'long',
      access: 'closed',
      hostName: longInvite.nickname,
      hostUserId: 'host-1',
      guestUserId: state.player.id,
    },
  });
  await accepting;
  await flush();
  const destination = new URL(state.location.href, waitingPage);
  assert.equal(destination.pathname, '/room.html');
  assert.equal(destination.searchParams.get('room'), ROOM_CODE);
  assert.equal(destination.searchParams.get('color'), 'dark');
  assert.equal(destination.searchParams.get('variant'), 'long');
  assert.equal(destination.searchParams.get('guest'), '1');
});

test('an invitation answer cannot open a room whose guest seat belongs to another player', async () => {
  const state = harness(async name => name === ANSWER_RPC
    ? { data: { room_code: ROOM_CODE } }
    : inbox(shortInvite), {
    getRoom: async () => ({
      room: {
        code: ROOM_CODE,
        status: 'joined',
        variant: 'short',
        access: 'closed',
        hostUserId: 'host-1',
        guestUserId: 'other-player',
      },
    }),
  });
  await flush();
  await state.action(ACCEPT).click();
  await flush();
  assert.equal(state.location.href, waitingPage);
});

test('server busy and expired outcomes keep the player on the current page', async () => {
  let failure = { message: 'lobby_invite_player_busy', code: '23505' };
  const state = harness(async name => name === ANSWER_RPC ? { error: failure } : inbox(shortInvite));
  await flush();
  await state.action(ACCEPT).click();
  await flush();

  assert.equal(state.location.href, waitingPage);
  assert.equal(state.notice().hidden, false);
  assert.ok(state.notice().textContent.includes('game_invitation_player_busy'));
  assert.equal(state.action(DECLINE).disabled, false);
  assert.equal(state.sounds.length, 1);

  failure = { message: 'lobby_invite_unavailable', code: '22023' };
  await state.action(DECLINE).click();
  await flush();

  assert.equal(state.location.href, waitingPage);
  assert.ok(state.notice().textContent.includes('game_invitation_unavailable'));
  assert.deepEqual(state.calls.filter(([name]) => name === ANSWER_RPC), [
    [ANSWER_RPC, { p_invitation_id: shortInvite.id, p_accept: true }],
    [ANSWER_RPC, { p_invitation_id: shortInvite.id, p_accept: false }],
  ]);
});
