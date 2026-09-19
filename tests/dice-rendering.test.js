const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

test("WebGL dice use a uniform orthographic camera and recover their context", () => {
  const source = fs.readFileSync(path.join(ROOT, "dice-webgl.js"), "utf8");
  assert.match(source, /const matrix = orthoBoardMatrix\(/);
  assert.match(source, /webglcontextlost/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /webglcontextrestored/);
  assert.match(source, /renderers\.delete\(canvas\)/);
  assert.match(source, /gl\.isContextLost/);
  assert.match(source, /const VIEW_TILT =/);
});

test("board dice use drop-and-settle physics without the old disappearing-canvas path", () => {
  const board = fs.readFileSync(path.join(ROOT, "board-engine.js"), "utf8");
  const controller = fs.readFileSync(path.join(ROOT, "game-controller.js"), "utf8");

  assert.match(board, /const DICE_ROLL_MS = 720;/);
  assert.match(board, /function settleProgress\(/);
  assert.match(board, /body\.settleFromX === undefined/);
  assert.match(board, /function findClearSpot\(/);
  assert.match(controller, /if \(isRolling\) return;/);
  assert.doesNotMatch(controller, /layer\.innerHTML = '';/);
  // System commit/reveal uses a shorter visual settle after proof verification;
  // quicknet and legacy rolls keep their previous opening/default durations.
  assert.match(controller, /duration: fair\.proof\?\.protocol === 'system-csprng-v1' \? 380 : 800/);
  assert.match(controller, /duration: fair\.proof\?\.protocol === 'system-csprng-v1' \? 380 : undefined/);
  assert.match(board, /const duration = opts\.duration \|\| DICE_ROLL_MS;/);
  assert.match(board, /const duration = opts\.duration \|\| \(DICE_ROLL_MS \+ 80\);/);
  assert.match(controller, /Opening roll failed/);
  assert.match(controller, /Turn roll failed/);
});

for (const protocol of ['system-csprng-v1', 'drand-quicknet-v1', undefined]) {
  test(`incoming ${protocol || 'legacy'} dice choose only their protocol animation duration and preserve the canvas`, async () => {
    const controller = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8');
    const captured = [];
    const layer = { dataset: {} };
    Object.defineProperty(layer, 'innerHTML', { set() { throw new Error('The existing dice layer must not be destroyed.'); } });
    const proof = protocol ? { protocol } : undefined;
    const state = { rollToken: 'fixture-token', turn: 'dark', rolled: [2, 4],
      openingRoll: { host: 2, guest: 4, fairDiceProof: proof }, history: [{ fairDiceProof: proof }] };
    const context = vm.createContext({ state, isRolling: true, console,
      document: { getElementById: () => layer }, NarduSound: { dice() {} },
      NarduBoardEngine: {
        animateOpeningRoll(options) { captured.push({ kind: 'opening', ...options }); return Promise.resolve(); },
        animateDiceRoll(options) { captured.push({ kind: 'turn', ...options }); return Promise.resolve(); },
      }, trayRollAnimation: () => Promise.resolve(), boardDiceFaces: values => values,
      render() {}, scheduleOpeningTurnRoll() {}, ensureAutoProgress() {}, OPENING_RESULT_PAUSE_MS: 1 });
    const start = controller.indexOf('function animateRemoteIncomingOpeningRoll()');
    const end = controller.indexOf('function renderUndo()', start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(controller.slice(start, end), context);
    context.animateRemoteIncomingOpeningRoll();
    await Promise.resolve();
    context.animateRemoteIncomingRoll();
    await Promise.resolve();
    assert.equal(captured.length, 2);
    assert.equal(captured[0].duration, protocol === 'system-csprng-v1' ? 380 : 800);
    assert.equal(captured[1].duration, protocol === 'system-csprng-v1' ? 380 : undefined);
    assert.equal(captured.every(options => options.layer === layer && options.token === state.rollToken), true);
    assert.equal(layer.dataset.boardDiceCount, '2');
  });
}

test("the first player makes a separate roll after the opening result", () => {
  const controller = fs.readFileSync(path.join(ROOT, "game-controller.js"), "utf8");
  const transition = controller.slice(
    controller.indexOf("function startOpeningTurnRoll()"),
    controller.indexOf("async function autoRoll()"),
  );

  assert.match(transition, /NarduGame\.startOpeningTurn\(state\)/);
  assert.match(transition, /opening-complete:/);
  assert.match(transition, /publishRemoteState\(\)/);
  assert.match(transition, /ensureAutoProgress\(mode === 'bot' \? NEXT_ROLL_DELAY_MS : 200\)/);
  assert.doesNotMatch(transition, /animateDiceRoll/);
  assert.doesNotMatch(transition, /NarduSound\.dice/);
  assert.doesNotMatch(controller, /opening-turn:/);
  assert.match(controller, /label: 'turn-roll'/);
  assert.match(controller, /openingMove,/);
});
