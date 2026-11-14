const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function setup(t) {
  const location = new URL('https://example.test/room.html?mode=remote&room=OLD-ROOM&variant=short&color=dark&role=spectator');
  const rawTimeout = setTimeout;
  const timers = new Set();
  const schedule = (fn, ms) => {
    const timer = rawTimeout(() => {
      timers.delete(timer);
      fn();
    }, Math.min(2, ms || 0));
    timers.add(timer);
    return timer;
  };
  t.after(() => timers.forEach(clearTimeout));

  const listeners = new Map();
  const elements = new Map();
  const events = [];
  const mutations = [];
  let reloads = 0;
  location.reload = () => { reloads += 1; };
  function element(id) {
    const result = {
      hidden: true,
      disabled: true,
      classList: { add() {}, remove() {} },
      addEventListener(name, fn) { listeners.set(`${id}:${name}`, fn); },
      replaceChildren() {},
      setAttribute() {},
    };
    elements.set(id, result);
    return result;
  }
  const roll = element('practice-roll');
  const confirm = element('practice-confirm');
  const undo = element('undo-btn');
  element('resign-btn');
  const document = {
    addEventListener() {},
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { classList: { add() {} } }; },
    body: { appendChild(node) { elements.set(node.id, node); } },
  };
  const service = new Proxy({}, { get: (_, name) => () => {
    mutations.push(name);
    throw new Error('Practice must not call server game APIs');
  } });
  const window = {
    addEventListener() {},
    dispatchEvent(event) { events.push(event); },
    setTimeout: schedule,
    requestAnimationFrame(fn) { fn(); },
    NarduApp: { getUser: () => ({ id: 'registered', name: 'Player' }), paintUser() {} },
    NarduRooms: service,
  };
  const context = vm.createContext({
    window, document, location, URL, TextEncoder, console, setTimeout: schedule, clearTimeout,
    setInterval() { return 1; }, clearInterval() {}, requestAnimationFrame: window.requestAnimationFrame,
    CustomEvent: class { constructor(type, { detail }) { Object.assign(this, { type, detail }); } },
    localStorage: { getItem() { return null; }, setItem(key) { mutations.push(key); }, removeItem(key) { mutations.push(key); } },
    sessionStorage: { getItem() { return null; }, setItem(key) { mutations.push(key); }, removeItem(key) { mutations.push(key); } },
    history: { replaceState() { mutations.push('url'); } },
    NarduSound: { prime() {}, dice() {}, move() {}, click() {} },
    NarduBoardEngine: { animateDiceRoll: async () => {}, animateCheckerMove: async () => {} },
    NarduRating: service,
  });
  vm.runInContext(source('game.js'), context);
  context.NarduGame = window.NarduGame;
  vm.runInContext(source('bot.js'), context);
  context.NarduBot = window.NarduBot;
  vm.runInContext(source('game-controller.js'), context);
  return { controller: window.NarduController, game: context.NarduGame, roll, confirm, undo, events, mutations,
    click: id => listeners.get(`${id}:click`)(), gameOver: () => elements.get('game-over')?.innerHTML,
    get reloads() { return reloads; } };
}

async function until(condition) {
  for (let i = 0; i < 150; i += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Expected practice state was not reached');
}

test('practice requires a manual roll, a legal complete turn and confirmation, and an easy bot replies locally', async t => {
  const { controller, game, roll, confirm, undo, events, mutations, click } = setup(t);
  controller.init({ practice: true, freshGame: true, difficulty: 'hard' });
  let state = controller.getState();
  assert.equal(state.mode, 'bot');
  assert.equal(state.variant, 'long');
  assert.equal(state.botDifficulty, 'easy');
  assert.equal(state.playerColor, 'white');
  assert.equal(state.roomCode, '');
  assert.equal(state.phase, 'roll');
  assert.equal(state.spectator, false);
  assert.equal(roll.hidden, false);
  assert.equal(roll.disabled, false);
  assert.equal(confirm.disabled, true);
  assert.equal(controller.receiveRemoteState({ phase: 'over', winner: 'dark' }, 17), false);
  assert.equal(controller.getState(), state);
  assert.equal(controller.prepareRoomReload(), false);
  assert.equal(await controller.publishRemoteState(), false);

  click('practice-roll');
  assert.equal(roll.disabled, true);
  await until(() => events.at(-1).detail.canMove);
  const { sha256, sha256Input } = controller.getState().history[0];
  assert.equal(crypto.createHash('sha256').update(sha256Input).digest('hex'), sha256);
  assert.equal(events.at(-1).detail.rollHash, sha256);
  assert.equal(confirm.disabled, true);
  click('practice-confirm');
  assert.equal(controller.getState().turn, 'white');

  const play = async () => {
    state = controller.getState();
    const move = game.legalNextMoves(state)[0];
    const previousMoves = state.turnMoves.length;
    controller.onPointClick(move.from);
    controller.onPointClick(move.to);
    await until(() => controller.getState().turnMoves.length > previousMoves && !undo.disabled);
  };
  await play();
  click('undo-btn');
  assert.equal(controller.getState().turnMoves.length, 0);
  assert.equal(undo.disabled, true);
  while (confirm.disabled) await play();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(controller.getState().turn, 'white', 'the player may undo before manually confirming');
  click('practice-confirm');
  assert.equal(controller.getState().turn, 'dark');
  assert.equal(events.at(-1).detail.confirmed, true);
  await until(() => controller.getState().phase === 'roll' && controller.getState().turn === 'white');
  assert.ok(controller.getState().history.some(move => move.color === 'dark' && move.from !== undefined));
  assert.equal(controller.getState().history.filter(event => event.roll && event.color === 'white').length, 1);
  assert.equal(events.at(-1).detail.rollHash, sha256);
  assert.deepEqual(mutations, []);
});


test('finishing or restarting practice stays local and leaves account ratings and rooms untouched', t => {
  const practice = setup(t);
  practice.controller.init({ practice: true });
  practice.click('resign-btn');
  assert.equal(practice.controller.getState().winner, 'dark');
  assert.match(practice.gameOver(), /id="go-again"/);
  assert.doesNotMatch(practice.gameOver(), /go-rating|go-r-delta/);
  practice.controller.startBotGameInNewRoom();
  assert.equal(practice.reloads, 1);
  assert.deepEqual(practice.mutations, []);
});
