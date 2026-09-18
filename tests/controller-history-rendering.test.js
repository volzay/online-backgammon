'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'game-controller.js'), 'utf8');
const section = source.slice(source.indexOf('  let historyRenderCache = null;'), source.indexOf('  async function copyHashToClipboard('));
assert.ok(section.includes('function renderHistory()') && section.includes('function historyMarkup('));
const clone = value => JSON.parse(JSON.stringify(value));
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function move(index = 0) {
  return { color: index % 2 ? 'dark' : 'white', from: 24, to: 23, die: 1, hit: false, hitColor: null,
    at: `2026-09-18T00:00:${String(index % 60).padStart(2, '0')}.000Z` };
}

function roll(index = 0) {
  const hash = index.toString(16).padStart(64, '0');
  return { color: index % 2 ? 'dark' : 'white', roll: '2:4', sha256: hash,
    sha256Input: `completed-roll-${index}`, fairDiceProof: { protocol: 'system-csprng-v1',
      request: { id: `issued-${index}`, nonce: index + 1, gameId: 'game-one' },
      dice: [2, 4], sha256: hash, sha256Input: `completed-roll-${index}`,
      commitReveal: { serverSeed: `server-seed-${index}`, clientSeed: `client-seed-${index}`, blocks: ['abcdef'] } } };
}

class HistoryList {
  constructor({ incremental = true } = {}) {
    this.parentElement = {};
    this.rows = [];
    this.rebuilds = 0;
    this.prepends = 0;
    this.renderedRows = 0;
    if (!incremental) this.insertAdjacentHTML = undefined;
  }
  parse(markup) {
    const chunks = markup.split(/(?=<div class="hist-item">)/).filter(chunk => chunk.includes('<div class="hist-item">'));
    this.renderedRows += chunks.length;
    return chunks.map(html => ({ html, detailsOpen: false, verification: null }));
  }
  get innerHTML() { return this.rows.map(row => row.html).join(''); }
  set innerHTML(markup) { this.rebuilds += 1; this.rows = this.parse(markup); }
  insertAdjacentHTML(where, markup) {
    assert.equal(where, 'afterbegin');
    this.prepends += 1;
    this.rows = [...this.parse(markup), ...this.rows];
  }
}

function rig(history = [], options = {}) {
  const list = new HistoryList(options);
  const contextCalls = [];
  const controlCalls = [];
  const context = vm.createContext({ state: { history, roomCode: 'ABCD-EFGH', variant: 'long', startedAt: 1,
      gameId: 'game-one', fairDiceGameId: 'game-one' }, mode: 'bot', spectatorMode: false, playerColor: 'white',
    remoteCode: '', uiLanguage: 'ru', names: { white: 'Игрок', dark: 'Бот' },
    document: { getElementById: id => id === 'history-list' ? list : null, querySelector: () => null },
    lang() { return context.uiLanguage; },
    sideName(color) { return `${context.uiLanguage}:side:${color}`; },
    turnName(color) { return context.names[color]; },
    tr(key, variables = {}) { return `${context.uiLanguage}:${key}${Object.values(variables).length ? ':' + Object.values(variables).join(':') : ''}`; },
    localizedMessage(message) { return `${context.uiLanguage}:${message}`; },
    window: { NarduVerifyUI: {
      setGameContext(parent, state) { contextCalls.push({ parent, state }); },
      rollControls(item, options) {
        controlCalls.push({ item, options });
        return `<button data-copy-roll-proof="${escape(JSON.stringify(item.fairDiceProof))}">${options.lang}:JSON</button>`;
      },
    } },
  });
  vm.runInContext(`${section}\nthis.render = renderHistory;`, context, { filename: 'actual-controller-history.js' });
  return { context, list, contextCalls, controlCalls, render: () => context.render() };
}

test('unchanged selection/animation renders reuse every journal node and disclosed proof without skipping context revision guards', () => {
  const ui = rig([roll(4), move(3), roll(2), move(1)]);
  ui.render();
  const rows = ui.list.rows.slice();
  rows[0].detailsOpen = true;
  rows[0].verification = 'verified';
  for (let index = 0; index < 20; index += 1) {
    ui.context.state.selected = index;
    ui.context.state.hints = [index + 1];
    ui.context.state.turnClock = { white: index };
    ui.render();
  }
  assert.equal(ui.list.rebuilds, 1);
  assert.equal(ui.list.prepends, 0);
  assert.equal(ui.list.renderedRows, 4);
  assert.equal(ui.controlCalls.length, 2);
  assert.equal(ui.contextCalls.length, 21, 'actual setGameContext is still called for every render');
  ui.list.rows.forEach((row, index) => assert.equal(row, rows[index]));
  assert.equal(ui.list.rows[0].detailsOpen, true);
  assert.equal(ui.list.rows[0].verification, 'verified');
});

test('prepend-only updates compile and insert just their new rows, keep old proof DOM, and preserve chronological numbering', () => {
  const ui = rig([roll(2), move(1)]);
  ui.render();
  const prior = ui.list.rows.slice();
  ui.context.state.history.unshift(move(3));
  ui.render();
  assert.equal(ui.list.rebuilds, 1);
  assert.equal(ui.list.prepends, 1);
  assert.equal(ui.controlCalls.length, 1);
  assert.match(ui.list.rows[0].html, /class="n">03/);
  assert.equal(ui.list.rows[1], prior[0]);
  assert.equal(ui.list.rows[2], prior[1]);
  ui.context.state.history.unshift(roll(5), move(4));
  ui.render();
  assert.equal(ui.list.rebuilds, 1);
  assert.equal(ui.list.prepends, 2);
  assert.equal(ui.controlCalls.length, 2);
  assert.equal(ui.list.rows.length, 5);
  assert.match(ui.list.rows[0].html, /class="n">05/);
  assert.match(ui.list.rows[1].html, /class="n">04/);
  assert.equal(ui.list.rows[3], prior[0]);
  assert.equal(ui.list.rows[4], prior[1]);
});

test('an in-place historical proof mutation fully rebuilds controls instead of copying an old cached trusted record', () => {
  const ui = rig([move(3), roll(2), roll(1)]);
  ui.render();
  const previous = ui.list.rows.slice();
  ui.context.state.history[2].fairDiceProof.commitReveal.serverSeed = 'altered-old-server-seed';
  ui.context.state.history.unshift(move(4));
  ui.render();
  assert.equal(ui.list.rebuilds, 2);
  assert.equal(ui.list.prepends, 0);
  assert.equal(ui.controlCalls.length, 4);
  assert.ok(ui.list.innerHTML.includes('altered-old-server-seed'));
  assert.notEqual(ui.list.rows[1], previous[0]);
  assert.equal(ui.contextCalls.length, 2);
});

test('mutating an old move, source string, or opening names invalidates the entire history signature', () => {
  for (const change of [item => { item.sha256Input += '|changed'; }, item => { item.roll = '3:5'; },
    item => { item.hostName = 'New opening name'; }]) {
    const ui = rig([roll(2), roll(1)]);
    ui.render();
    const old = ui.list.rows[1];
    change(ui.context.state.history[1]);
    ui.render();
    assert.equal(ui.list.rebuilds, 2);
    assert.notEqual(ui.list.rows[1], old);
  }
  const ui = rig([move(2), move(1)]);
  ui.render();
  ui.context.state.history[1].to = 19;
  ui.render();
  assert.equal(ui.list.rebuilds, 2);
  assert.match(ui.list.rows[1].html, /24 → 19/);
});

test('non-JSON historical values cannot alias a previous signature and stale proof DOM', () => {
  const ui = rig([roll(2), { ...move(1), to: null }]);
  ui.render();
  ui.context.state.history[1].to = Number.NaN;
  ui.render();
  assert.equal(ui.list.rebuilds, 2);
  assert.match(ui.list.rows[1].html, /24 → NaN/);
  ui.render();
  assert.equal(ui.list.rebuilds, 3, 'unsupported records use safe full render rather than an ambiguous cache');
});

test('undo, authoritative restore and rematch each rebuild the full surviving journal', () => {
  const ui = rig([move(3), roll(2), move(1)]);
  ui.render();
  ui.context.state.history.shift();
  ui.render();
  assert.equal(ui.list.rebuilds, 2);
  assert.equal(ui.list.rows.length, 2);
  assert.match(ui.list.rows[0].html, /class="n">02/);
  ui.context.state = clone(ui.context.state);
  ui.render();
  assert.equal(ui.list.rebuilds, 3, 'restored state object must not retain stale DOM');
  ui.context.state.gameId = 'game-two';
  ui.context.state.fairDiceGameId = 'game-two';
  ui.context.state.startedAt = 2;
  ui.context.state.history = [roll(1)];
  ui.render();
  assert.equal(ui.list.rebuilds, 4);
  assert.equal(ui.list.rows.length, 1);
  assert.equal(ui.list.prepends, 0);
});

test('language, displayed player name and expected room/variant context invalidate all verification controls', () => {
  const ui = rig([roll(2), roll(1)]);
  ui.render();
  ui.context.uiLanguage = 'en';
  ui.render();
  assert.equal(ui.list.rebuilds, 2);
  assert.match(ui.list.innerHTML, /en:history_rolls/);
  assert.equal(ui.controlCalls.at(-1).options.lang, 'en');
  ui.context.names.white = 'New player';
  ui.render();
  assert.equal(ui.list.rebuilds, 3);
  assert.match(ui.list.innerHTML, /New player/);
  ui.context.remoteCode = 'WXYZ-2345';
  ui.context.state.variant = 'short';
  ui.render();
  assert.equal(ui.list.rebuilds, 4);
  assert.deepEqual(clone(ui.controlCalls.at(-1).options.context), { roomCode: 'WXYZ-2345', variant: 'short' });
  ui.context.state.fairDice = { protocol: 'system-csprng-v1', required: true, gameId: 'game-one' };
  ui.render();
  assert.equal(ui.list.rebuilds, 5);
  ui.context.state.fairDice.protocol = 'drand-quicknet-v1';
  ui.render();
  assert.equal(ui.list.rebuilds, 6);
});

test('waiting placeholder is reused while empty but removed rather than prepended behind the first real event', () => {
  const ui = rig([]);
  ui.render();
  const placeholder = ui.list.rows[0];
  ui.render();
  assert.equal(ui.list.rebuilds, 1);
  assert.equal(ui.list.rows[0], placeholder);
  ui.context.state.history.unshift(roll(1));
  ui.render();
  assert.equal(ui.list.rebuilds, 2);
  assert.equal(ui.list.prepends, 0);
  assert.equal(ui.list.rows.length, 1);
  assert.doesNotMatch(ui.list.innerHTML, /history_wait_opening/);
});

test('a library harness without insertAdjacentHTML uses the safe full-render fallback for additions', () => {
  const ui = rig([roll(1)], { incremental: false });
  ui.render();
  ui.render();
  assert.equal(ui.list.rebuilds, 1);
  ui.context.state.history.unshift(move(2));
  ui.render();
  assert.equal(ui.list.rebuilds, 2);
  assert.equal(ui.list.rows.length, 2);
  assert.equal(ui.list.prepends, 0);
});

test('1000-event journal compiles only 1002 rows and 335 proofs across twenty unchanged renders and two additions', () => {
  const history = Array.from({ length: 1000 }, (_, index) => index % 3 === 0 ? roll(index + 1) : move(index + 1));
  const ui = rig(history);
  ui.render();
  for (let index = 0; index < 20; index += 1) ui.render();
  ui.context.state.history.unshift(move(1001));
  ui.render();
  ui.context.state.history.unshift(roll(1002));
  ui.render();
  assert.equal(ui.list.rebuilds, 1);
  assert.equal(ui.list.prepends, 2);
  assert.equal(ui.list.renderedRows, 1002);
  assert.equal(ui.controlCalls.length, 335);
  assert.equal(ui.list.rows.length, 1002, 'no history or JSON proof access is truncated');
  assert.equal(ui.contextCalls.length, 23);
});
