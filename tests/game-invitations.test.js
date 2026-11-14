const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'game-invitations.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(rpcResult) {
  const notices = [];
  const events = [];
  const listeners = new Map();
  const calls = [];
  const player = { id: 'player-1' };
  let poll;
  const document = {
    readyState: 'loading',
    hidden: false,
    body: { append: notice => notices.push(notice) },
    createElement: tag => ({ tag }),
    getElementById: () => null,
    addEventListener: (event, callback) => listeners.set(event, callback),
  };
  const window = {
    NarduApp: { getUser: () => player, t: key => key },
    NarduSupabase: {
      configured: () => true,
      client: async () => ({ rpc(name, args) {
        calls.push([name, args ? { ...args } : undefined]);
        return rpcResult(name);
      } }),
    },
    addEventListener: (event, callback) => listeners.set(event, callback),
    dispatchEvent: event => events.push(event),
  };
  vm.runInNewContext(source, {
    document,
    window,
    CustomEvent: class {
      constructor(name, { detail }) { Object.assign(this, { name, detail }); }
    },
    setInterval(callback, delay) { poll = { callback, delay }; },
  });
  listeners.get('DOMContentLoaded')();
  return { invitations: window.NarduGameInvitations, calls, document, events, listeners, notices, player, poll };
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

test('the shared notification survives polling failure and disappears when the inbox clears', async () => {
  const invitation = { id: 'invite-1', nickname: '<img src=x>', variant: 'short' };
  let response = { data: { incoming: [invitation], outgoing: [] } };
  const { calls, document, events, notices, poll } = harness(async () => response);
  await flush();
  assert.equal(events.at(-1).name, 'nardu:game-invitations');
  assert.deepEqual(Array.from(events.at(-1).detail.incoming), [invitation]);
  assert.equal(notices[0].href, 'index.html#game-invitations');
  assert.equal(notices[0].hidden, false);
  assert.equal(poll.delay, 10000);

  document.hidden = true;
  await poll.callback();
  assert.equal(calls.length, 1);
  document.hidden = false;
  response = { error: new Error('Unavailable') };
  await poll.callback();
  assert.equal(notices[0].hidden, false);
  assert.deepEqual(Array.from(events.at(-1).detail.incoming), [invitation]);

  response = { data: { incoming: [], outgoing: [] } };
  await poll.callback();
  assert.equal(notices[0].hidden, true);
  assert.equal(events.at(-1).detail.incoming.length, 0);
  assert.equal(notices.length, 1);
});
