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
  let diceSounds = 0;
  const math = Object.create(Math);
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
  const bear = element('bear-btn');
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
    window, document, location, URL, TextEncoder, Math: math, console, setTimeout: schedule, clearTimeout,
    setInterval() { return 1; }, clearInterval() {}, requestAnimationFrame: window.requestAnimationFrame,
    CustomEvent: class { constructor(type, { detail }) { Object.assign(this, { type, detail }); } },
    localStorage: { getItem() { return null; }, setItem(key) { mutations.push(key); }, removeItem(key) { mutations.push(key); } },
    sessionStorage: { getItem() { return null; }, setItem(key) { mutations.push(key); }, removeItem(key) { mutations.push(key); } },
    history: { replaceState() { mutations.push('url'); } },
    NarduSound: { prime() {}, dice() { diceSounds += 1; }, move() {}, bearOff() {}, click() {} },
    NarduBoardEngine: { animateDiceRoll: async () => {}, animateCheckerMove: async () => {} },
    NarduRating: service,
  });
  vm.runInContext(source('game.js'), context);
  context.NarduGame = window.NarduGame;
  vm.runInContext(source('bot.js'), context);
  context.NarduBot = window.NarduBot;
  vm.runInContext(source('game-controller.js'), context);
  return { controller: window.NarduController, game: context.NarduGame, roll, confirm, undo, bear, events, mutations,
    setRandom: random => { math.random = random; },
    click: id => listeners.get(`${id}:click`)(),
    hasClickHandler: id => listeners.has(`${id}:click`), gameOver: () => elements.get('game-over')?.innerHTML,
    get reloads() { return reloads; }, get diceSounds() { return diceSounds; } };
}

async function until(condition) {
  for (let i = 0; i < 150; i += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Expected practice state was not reached');
}

async function playPracticeMove({ controller, game }, move) {
  const state = controller.getState();
  move ??= game.bestMoveSequences(state)[0][0];
  const previousMoves = state.turnMoves.length;
  controller.onPointClick(move.from);
  controller.onPointClick(move.to);
  await until(() => controller.getState().turnMoves.length > previousMoves && controller.getPracticeStatus().canMove);
}

test('practice rolls automatically on both player turns and waits for manual confirmation before the bot replies', async t => {
  const practice = setup(t);
  const { controller, roll, confirm, undo, events, mutations, click, hasClickHandler } = practice;
  controller.init({ practice: true, freshGame: true, difficulty: 'hard' });
  const state = controller.getState();
  assert.equal(state.mode, 'bot');
  assert.equal(state.variant, 'long');
  assert.equal(state.botDifficulty, 'easy');
  assert.equal(state.playerColor, 'white');
  assert.equal(state.roomCode, '');
  assert.equal(state.phase, 'roll');
  assert.equal(state.spectator, false);
  assert.doesNotMatch(source('room.html'), /id="practice-roll"/);
  assert.equal(roll.hidden, true);
  assert.equal(hasClickHandler('practice-roll'), false);
  assert.equal(confirm.disabled, true);
  assert.equal(controller.receiveRemoteState({ phase: 'over', winner: 'dark' }, 17), false);
  assert.equal(controller.getState(), state);
  assert.equal(controller.prepareRoomReload(), false);
  assert.equal(await controller.publishRemoteState(), false);

  await until(() => events.at(-1).detail.canMove);
  const { sha256, sha256Input } = controller.getState().history[0];
  assert.equal(crypto.createHash('sha256').update(sha256Input).digest('hex'), sha256);
  assert.equal(events.at(-1).detail.rollHash, sha256);
  assert.equal(confirm.disabled, true);
  click('practice-confirm');
  assert.equal(controller.getState().turn, 'white');

  await playPracticeMove(practice);
  click('undo-btn');
  assert.equal(controller.getState().turnMoves.length, 0);
  assert.equal(undo.disabled, true);
  while (confirm.disabled) await playPracticeMove(practice);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(controller.getState().turn, 'white', 'the player may undo before manually confirming');
  click('practice-confirm');
  assert.equal(controller.getState().turn, 'dark');
  assert.equal(events.at(-1).detail.confirmedTurns, 1);
  await until(() => events.at(-1).detail.canMove && controller.getState().turn === 'white');
  assert.ok(controller.getState().history.some(move => move.color === 'dark' && move.from !== undefined));
  const humanRolls = controller.getState().history.filter(event => event.roll && event.color === 'white');
  assert.equal(humanRolls.length, 2);
  assert.notEqual(humanRolls[0].sha256, sha256);
  assert.equal(crypto.createHash('sha256').update(humanRolls[0].sha256Input).digest('hex'), humanRolls[0].sha256);
  assert.equal(humanRolls[1].sha256, sha256);
  assert.equal(events.at(-1).detail.rollHash, sha256);
  assert.deepEqual(mutations, []);
});

async function confirmPracticeTurn(practice) {
  await until(() => practice.controller.getPracticeStatus().canMove);
  while (practice.confirm.disabled) await playPracticeMove(practice);
  practice.click('practice-confirm');
}

test('the practice guide holds the first bot roll and lets the player make a second turn', async t => {
  const practice = setup(t);
  const { controller, mutations } = practice;
  controller.init({ practice: true });
  controller.setPracticeGuideActive(true);
  await until(() => controller.getPracticeStatus().canMove);
  const playerRollHash = controller.getPracticeStatus().rollHash;
  assert.ok(playerRollHash);
  await confirmPracticeTurn(practice);

  const { history, turnClock } = controller.getState();
  const journalAtConfirmation = history.slice();
  assert.equal(controller.getPracticeStatus().confirmedTurns, 1);
  assert.equal(controller.getPracticeStatus().paused, true);
  assert.equal(controller.startPracticeBearOff(), false);
  assert.equal(controller.getPracticeStatus().rollHash, playerRollHash);
  assert.equal(controller.getState().turn, 'dark');
  assert.equal(controller.getState().phase, 'roll');
  assert.equal(turnClock.active, null);
  assert.equal(practice.diceSounds, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.render();
  assert.deepEqual(controller.getState().history, journalAtConfirmation);
  assert.equal(controller.getState().turnClock.dark, turnClock.dark);
  assert.equal(practice.diceSounds, 1);

  controller.resumePracticeGuide();
  await until(() => controller.getPracticeStatus().canMove);
  assert.equal(controller.getState().turn, 'white');
  const opponentRolls = controller.getState().history.filter(event => event.color === 'dark' && event.roll);
  assert.equal(opponentRolls.length, 1);
  assert.equal(controller.getPracticeStatus().paused, false);
  assert.equal(practice.diceSounds, 3);
  await confirmPracticeTurn(practice);
  assert.equal(controller.getPracticeStatus().confirmedTurns, 2);
  assert.equal(controller.getPracticeStatus().paused, true);
  assert.equal(controller.getState().turnClock.active, null);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(controller.getState().history.filter(event => event.color === 'dark' && event.roll).length, 1);
  assert.equal(practice.diceSounds, 3);
  assert.deepEqual(mutations, []);
});

function randomFromSeed(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

async function openGuidedBearOff(practice, seed) {
  const { controller } = practice;
  controller.init({ practice: true });
  controller.setPracticeGuideActive(true);
  await confirmPracticeTurn(practice);
  controller.resumePracticeGuide();
  await confirmPracticeTurn(practice);
  practice.setRandom(randomFromSeed(seed));
  assert.equal(controller.startPracticeBearOff(), true);
}

test('a guided bear-off drill varies the position and removes two checkers through the long rules locally', async t => {
  const boards = [];
  for (const seed of [42, 100]) {
    const practice = setup(t);
    const { controller, game, bear, click, mutations } = practice;
    await openGuidedBearOff(practice, seed);
    const drill = controller.getState();
    const board = JSON.stringify(drill.points);
    boards.push(board);
    assert.equal(drill.variant, 'long');
    assert.equal(drill.turn, 'white');
    assert.equal(drill.phase, 'move');
    assert.equal(controller.getPracticeStatus().bearOff, true);
    assert.equal(controller.getPracticeStatus().offCount, 0);
    assert.equal(new Set(drill.dice).size, 2);
    for (const color of ['white', 'dark']) {
      assert.equal(game.homeReady(drill, color), true);
      const onBoard = Object.values(drill.points).filter(point => point.color === color);
      assert.equal(onBoard.reduce((sum, point) => sum + point.count, 0), 15);
    }

    for (let off = 1; off <= 2; off += 1) {
      const state = controller.getState();
      const sequence = game.bestMoveSequences(state).find(moves => moves.length > 0
        && moves.every(move => move.bearOff));
      assert.ok(sequence, 'the rules allow an immediate bear-off for the remaining dice');
      controller.onPointClick(sequence[0].from);
      assert.equal(bear.hidden, false);
      assert.equal(bear.disabled, false);
      click('bear-btn');
      await until(() => controller.getPracticeStatus().offCount === off);
    }

    assert.equal(controller.getState().winner, null);
    assert.equal(controller.getPracticeStatus().paused, true);
    assert.equal(controller.startPracticeBearOff(), false);
    const journal = controller.getState().history.slice();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(controller.getState().history, journal);
    assert.deepEqual(mutations, []);
  }
  assert.notEqual(boards[0], boards[1]);
});

test('an exhausted bear-off drill can be retried if the player moved instead of bearing off twice', async t => {
  const practice = setup(t);
  const { controller, game, mutations } = practice;
  await openGuidedBearOff(practice, 42);
  const drill = controller.getState();
  const sequence = game.bestMoveSequences(drill).find(moves => moves.length > 0 && !moves[0].bearOff);
  assert.ok(sequence, 'this draw allows moving within home');
  await playPracticeMove(practice, sequence[0]);
  while (controller.getState().dice.length) await playPracticeMove(practice);
  assert.equal(controller.getPracticeStatus().paused, true);
  assert.ok(controller.getPracticeStatus().offCount < 2);
  practice.setRandom(randomFromSeed(100));
  assert.equal(controller.startPracticeBearOff(), true);
  assert.equal(controller.getPracticeStatus().paused, false);
  assert.equal(controller.getPracticeStatus().offCount, 0);
  assert.equal(controller.getState().turnMoves.length, 0);
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
