const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadDiceEngine() {
  let seed = 0x12345678;
  const math = Object.create(Math);
  math.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const context = {
    window: {},
    console,
    Math: math,
    Promise,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "dice-engine.js"), "utf8"), context, {
    filename: "dice-engine.js",
  });
  return context.window.NarduDiceEngine;
}

function overlapsChecker(body, blocker, size) {
  const half = size / 2;
  return (
    body.x - half < blocker.right
    && body.x + half > blocker.left
    && body.y - half < blocker.bottom
    && body.y + half > blocker.top
  );
}

test("dice fall, settle without NaN, and preserve the rolled faces", async () => {
  const dice = loadDiceEngine();
  const frames = [];
  const blockers = [
    { left: 120, right: 280, top: 160, bottom: 440 },
  ];
  let now = 0;
  const engine = new dice.DiceRollEngine({
    area: { xMin: 30, xMax: 370, yMin: 30, yMax: 570 },
    blockers,
    color: "white",
    faces: [6, 2],
    diceSize: 40,
    diceGap: 10,
    duration: 720,
    now: () => now,
    raf: callback => {
      now += 16;
      queueMicrotask(() => callback(now));
      return now;
    },
    onFrame: bodies => frames.push(bodies),
  });

  const result = await engine.start();
  assert.ok(frames.length > 20);
  assert.ok(frames[0].every(body => body.z >= 56));
  assert.ok(frames.some(frame => frame.some(body => body.settle > 0 && body.settle < 1)));

  for (const frame of frames) {
    for (const body of frame) {
      for (const value of [body.x, body.y, body.z, body.rx, body.ry, body.rz]) {
        assert.equal(Number.isFinite(value), true, `non-finite dice coordinate: ${value}`);
      }
    }
  }

  assert.deepEqual(result.map(body => body.face), [6, 2]);
  assert.ok(result.every(body => body.z === 0 && body.rolling === false && body.settle === 1));
  assert.ok(result.every(body => blockers.every(blocker => !overlapsChecker(body, blocker, 40))));
  assert.ok(Math.hypot(result[0].x - result[1].x, result[0].y - result[1].y) >= 50);
});

