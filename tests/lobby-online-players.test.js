const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const lobby = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const rosterSource = lobby.slice(
  lobby.indexOf('  const onlinePlayersList ='),
  lobby.indexOf('  const invitationDialog ='),
);
const flush = () => new Promise(resolve => setImmediate(resolve));

function element(tag) {
  const node = {
    tag, children: [], dataset: {}, attributes: {},
    classList: new Set(), hidden: false, textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    set innerHTML(_) { assert.fail('Player data must be inserted as plain text'); },
  };
  return node;
}

function setup(request, { hidden = false, user = { id: 'viewer' }, listTargets } = {}) {
  const list = element('ul');
  const labels = element('div');
  const status = element('p');
  const elements = {
    'online-players-list': list, 'online-players-labels': labels, 'online-players-status': status,
  };
  const pageEvents = new Map();
  const windowEvents = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  let now = 0;
  let language = 'ru';
  const document = {
    hidden, getElementById: id => elements[id], createElement: element,
    addEventListener: (event, callback) => pageEvents.set(event, callback),
  };
  vm.runInNewContext(rosterSource, {
    document,
    window: {
      addEventListener: (event, callback) => windowEvents.set(event, callback),
      NarduGameInvitations: listTargets ? { listTargets } : undefined,
      NarduSupabase: {
        configured: () => true,
        client: async () => ({ rpc: request }),
      },
    },
    NarduApp: { currentLang: () => language, getUser: () => user },
    tt: key => `${language}:${key}`,
    performance: { now: () => now },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    syncCreatePanel() {},
    renderTables() {},
  });
  return {
    list, labels, status, document, pageEvents, windowEvents,
    get pendingTimers() { return Array.from(timers.values(), timer => timer.at - now); },
    async advanceTime(ms) {
      const target = now + ms;
      for (const [id, timer] of timers) {
        if (timer.at > target) continue;
        now = timer.at;
        timers.delete(id);
        timer.callback();
        await flush();
      }
      now = target;
    },
    setLanguage(value) { language = value; windowEvents.get('nardu:langchange')(); },
  };
}

test('online roster displays public ratings and renders every nickname as plain text', async () => {
  const nickname = '<img src=x>';
  const { list, labels, status, setLanguage } = setup(async operation => {
    assert.equal(operation, 'list_lobby_online_players');
    return { data: [
      { nickname, rating: 1250, guest: false },
      { nickname: 'Private player', rating: null, guest: false },
      { nickname: 'Guest0001', rating: null, guest: true },
    ] };
  });
  await flush();

  assert.equal(list.hidden, false);
  assert.equal(labels.hidden, false);
  assert.equal(status.hidden, true);
  assert.deepEqual(Array.from(list.children, row => row.tag), ['li', 'li', 'li']);
  assert.deepEqual(Array.from(list.children, row => row.children[0].textContent),
    [nickname, 'Private player', 'Guest0001']);
  assert.deepEqual(Array.from(list.children, row => row.children[1].textContent),
    [new Intl.NumberFormat('ru').format(1250), '—', 'ru:unrated']);
  assert.match(list.children[0].children[1].attributes['aria-label'], /^ru:rating /);

  setLanguage('en');
  assert.equal(list.children[0].children[1].textContent, '1,250');
  assert.equal(list.children[2].children[1].textContent, 'en:unrated');
});

test('a failed refresh keeps recent players and pauses invitations until an authoritative update', async () => {
  const responses = [
    [{ nickname: 'Online player', rating: 1000, guest: false, invite_target: 'token', can_invite: true }],
    new Error('Backend unavailable'),
    [],
  ];
  const ui = setup(async () => assert.fail('The invitations RPC supplies the roster'), {
    listTargets: async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  });
  const { list, labels, status, windowEvents } = ui;
  await flush();
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[2].disabled, false);
  assert.deepEqual(ui.pendingTimers, [30000]);

  await windowEvents.get('focus')();
  assert.equal(list.hidden, false);
  assert.equal(labels.hidden, false);
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[2].disabled, true);
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'ru:online_players_stale');
  assert.deepEqual(ui.pendingTimers, [5000]);

  await ui.advanceTime(5000);
  assert.equal(list.hidden, true);
  assert.equal(labels.hidden, true);
  assert.equal(list.children.length, 0);
  assert.equal(status.textContent, 'ru:online_players_empty');
  assert.deepEqual(ui.pendingTimers, [30000]);
});

test('the last roster expires after 90 seconds even while a retry is pending', async () => {
  let release;
  let requests = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const ui = setup(async () => {
    requests += 1;
    if (requests === 1) return { data: [{ nickname: 'Online player', rating: 1000, guest: false }] };
    if (requests === 6) return pending;
    return { error: new Error('Backend unavailable') };
  });
  await flush();

  await ui.advanceTime(80000);
  assert.equal(requests, 5);
  const retry = ui.windowEvents.get('focus')();
  await flush();
  await ui.advanceTime(9999);
  assert.equal(requests, 6);
  assert.equal(ui.list.hidden, false);
  assert.equal(ui.status.textContent, 'ru:online_players_stale');
  assert.deepEqual(ui.pendingTimers, [1]);

  await ui.advanceTime(1);
  assert.equal(requests, 6);
  assert.equal(ui.list.hidden, true);
  assert.equal(ui.status.textContent, 'ru:online_players_unavailable');
  assert.deepEqual(ui.pendingTimers, []);

  release({ data: [{ nickname: 'Online player', rating: 1000, guest: false }] });
  await retry;
  assert.equal(ui.list.hidden, false);
  assert.equal(ui.status.hidden, true);
  assert.deepEqual(ui.pendingTimers, [30000]);
});

test('an initial failure shows unavailable until a successful empty roster', async () => {
  const responses = [{ error: new Error('Backend unavailable') }, { data: [] }];
  const ui = setup(async () => responses.shift());
  await flush();
  assert.equal(ui.list.hidden, true);
  assert.equal(ui.labels.hidden, true);
  assert.equal(ui.status.textContent, 'ru:online_players_unavailable');
  assert.deepEqual(ui.pendingTimers, [5000]);

  await ui.windowEvents.get('online')();
  assert.equal(ui.list.hidden, true);
  assert.equal(ui.status.textContent, 'ru:online_players_empty');
  assert.deepEqual(ui.pendingTimers, [30000]);
});

test('online roster skips hidden pages and avoids overlapping polls', async () => {
  let release;
  let requests = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const ui = setup(() => {
    requests += 1;
    return requests === 1 ? pending : Promise.resolve({ data: [] });
  }, { hidden: true });
  const { document, pageEvents, windowEvents, status } = ui;

  assert.deepEqual(ui.pendingTimers, []);
  assert.equal(requests, 0);
  document.hidden = false;
  const first = pageEvents.get('visibilitychange')();
  await windowEvents.get('focus')();
  await windowEvents.get('pageshow')();
  assert.equal(requests, 1);
  release({ data: [] });
  await first;
  assert.deepEqual(ui.pendingTimers, [30000]);
  await ui.advanceTime(30000);
  assert.equal(requests, 2);
  assert.equal(status.textContent, 'ru:online_players_empty');
  assert.deepEqual(ui.pendingTimers, [30000]);
});
