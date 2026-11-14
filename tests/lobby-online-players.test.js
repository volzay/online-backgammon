const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const lobby = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const rosterSource = lobby.slice(lobby.indexOf('  const onlinePlayersList ='), lobby.lastIndexOf('</script>'));
const flush = () => new Promise(resolve => setImmediate(resolve));

function element(tag) {
  const node = {
    tag, children: [], dataset: {}, attributes: {},
    classList: new Set(), hidden: false, textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    set innerHTML(_) { assert.fail('Player data must be inserted as plain text'); },
  };
  return node;
}

function setup(request, { hidden = false, user = { id: 'viewer' } } = {}) {
  const list = element('ul');
  const labels = element('div');
  const status = element('p');
  const elements = {
    'online-players-list': list, 'online-players-labels': labels, 'online-players-status': status,
  };
  const pageEvents = new Map();
  const windowEvents = new Map();
  let poll;
  let language = 'ru';
  const document = {
    hidden, getElementById: id => elements[id], createElement: element,
    addEventListener: (event, callback) => pageEvents.set(event, callback),
  };
  vm.runInNewContext(rosterSource, {
    document,
    window: {
      addEventListener: (event, callback) => windowEvents.set(event, callback),
      NarduSupabase: {
        configured: () => true,
        client: async () => ({ rpc: request }),
      },
    },
    NarduApp: { currentLang: () => language, getUser: () => user },
    tt: key => `${language}:${key}`,
    setInterval(callback, delay) { poll = { callback, delay }; },
    syncCreatePanel() {},
    renderTables() {},
  });
  return {
    list, labels, status, document, pageEvents, windowEvents, poll,
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

test('an unavailable roster is distinct from an empty roster and refresh replaces the data', async () => {
  const responses = [
    { data: [{ nickname: 'Online player', rating: 1000, guest: false }] },
    { error: new Error('Backend unavailable') },
    { data: [] },
  ];
  const { list, labels, status, windowEvents } = setup(async () => responses.shift());
  await flush();
  assert.equal(list.children.length, 1);

  await windowEvents.get('online')();
  assert.equal(list.hidden, true);
  assert.equal(labels.hidden, true);
  assert.equal(list.children.length, 0);
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'ru:online_players_unavailable');

  await windowEvents.get('pageshow')();
  assert.equal(list.hidden, true);
  assert.equal(status.textContent, 'ru:online_players_empty');
});

test('online roster skips hidden pages and avoids overlapping polls', async () => {
  let release;
  let requests = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const { document, pageEvents, windowEvents, poll, status } = setup(() => {
    requests += 1;
    return requests === 1 ? pending : Promise.resolve({ data: [] });
  }, { hidden: true });

  assert.equal(poll.delay, 30000);
  await poll.callback();
  assert.equal(requests, 0);
  document.hidden = false;
  const first = pageEvents.get('visibilitychange')();
  await poll.callback();
  await windowEvents.get('pageshow')();
  assert.equal(requests, 1);
  release({ data: [] });
  await first;
  await poll.callback();
  assert.equal(requests, 2);
  assert.equal(status.textContent, 'ru:online_players_empty');
});
