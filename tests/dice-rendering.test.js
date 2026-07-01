const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
  assert.match(controller, /duration: 800/);
  assert.match(controller, /duration: 740/);
  assert.match(controller, /Opening roll failed/);
  assert.match(controller, /Turn roll failed/);
});
