/* ------------------------------------------------------------------
   dice-engine.js - reusable dice roll animation physics.
   Rendering stays in board-engine.js; this module owns motion.
   ------------------------------------------------------------------ */

window.NarduDiceEngine = (function () {
  const DEFAULTS = {
    duration: 720,
    gravity: 1.25,
    floorBounce: 0.33,
    railBounceX: 0.7,
    railBounceY: 0.7,
    bodyBounce: 0.6,
    linearFriction: 0.88,
    angularFriction: 0.88,
    spinFriction: 0.88,
    maxFrameMs: 38,
  };

  class DiceRollEngine {
    constructor(opts = {}) {
      this.area = opts.area;
      this.blockers = opts.blockers || [];
      this.color = opts.color || 'white';
      this.faces = opts.faces || [];
      this.diceSize = opts.diceSize || 40;
      this.diceGap = opts.diceGap || 10;
      this.duration = opts.duration || DEFAULTS.duration;
      this.randomOrientation = opts.randomOrientation || defaultOrientation;
      this.orientationFaces = opts.orientationFaces || ((top) => ({ top, front: 2, right: 3 }));
      this.onFrame = opts.onFrame || (() => {});
      this.onImpact = opts.onImpact || (() => {});
      this.now = opts.now || (() => performance.now());
      this.raf = opts.raf || ((fn) => requestAnimationFrame(fn));
      this.startAt = 0;
      this.lastAt = 0;
      this.bodies = [];
    }

    start() {
      if (!this.area || this.faces.length === 0) {
        return Promise.resolve([]);
      }

      this.bodies = this.createBodies();
      this.startAt = this.now();
      this.lastAt = this.startAt;
      this.onFrame(this.snapshot());

      return new Promise(resolve => {
        const tick = (time) => {
          const elapsed = time - this.startAt;
          const done = elapsed >= this.duration;
          const dt = Math.min(DEFAULTS.maxFrameMs, time - this.lastAt) / 16.67;
          this.lastAt = time;

          if (!done) {
            this.step(dt, time);
            this.onFrame(this.snapshot());
            this.raf(tick);
            return;
          }

          this.finish();
          this.onFrame(this.snapshot());
          resolve(this.snapshot());
        };

        this.raf(tick);
      });
    }

    createBodies() {
      // Drop each die from just above its (checker-free) landing spot, with only
      // a little sideways drift and a fast tumble - so it falls onto the board,
      // bounces a couple of times and settles, instead of skidding in from a rail.
      const area = this.settleArea();
      const placed = [];
      return this.faces.map((face, i) => {
        const target = findClearSpot(area, this.blockers, placed, this.diceSize, this.diceGap);
        placed.push(target);
        return {
          id: i,
          x: clamp(target.x + randomBetween(-8, 8), area.xMin, area.xMax),
          y: clamp(target.y + randomBetween(-8, 8), area.yMin, area.yMax),
          z: randomBetween(56, 80),
          vx: randomBetween(-1.8, 1.8),
          vy: randomBetween(-1.8, 1.8),
          vz: randomBetween(-1, 1),
          rx: randomBetween(-80, 80),
          ry: randomBetween(-80, 80),
          rz: randomBetween(0, 360),
          avx: randomBetween(13, 24) * randomSign(),
          avy: randomBetween(13, 24) * randomSign(),
          avz: randomBetween(11, 20) * randomSign(),
          face,
          targetX: target.x,
          targetY: target.y,
          displayFaces: this.randomOrientation(),
          used: false,
          rolling: true,
          settle: 0,
          restYaw: Math.random() * Math.PI * 2,
          nextFaceAt: this.now() + randomBetween(45, 95),
        };
      });
    }

    step(dt, time) {
      // The last stretch of the roll is a settle phase: the tumble freezes and
      // each die glides to a checker-free target while the renderer rotates it
      // onto its result, so it never comes to rest on top of a checker.
      const elapsed = time - this.startAt;
      const settleStart = this.duration * 0.62;
      const settleT = elapsed <= settleStart
        ? 0
        : clamp((elapsed - settleStart) / Math.max(1, this.duration - settleStart), 0, 1);

      if (settleT > 0 && !this.targetsAssigned) {
        this.assignSettleTargets();
        this.targetsAssigned = true;
      }

      this.bodies.forEach(body => this.stepBody(body, dt, time, settleT));

      if (settleT === 0) {
        for (let i = 0; i < this.bodies.length; i++) {
          for (let j = i + 1; j < this.bodies.length; j++) {
            this.collideBodies(this.bodies[i], this.bodies[j]);
          }
        }
        this.bodies.forEach(body => this.keepAwayFromBlockers(body));
      }
    }

    assignSettleTargets() {
      // Targets were chosen at launch (each die was dropped over its spot); here
      // we just remember where the die actually is when the settle phase begins so
      // a small final nudge lands it exactly on its clear target.
      const area = this.settleArea();
      const placed = this.bodies.filter(b => b.targetX !== undefined).map(b => ({ x: b.targetX, y: b.targetY }));
      this.bodies.forEach(body => {
        if (body.targetX === undefined) {
          const target = findClearSpot(area, this.blockers, placed, this.diceSize, this.diceGap);
          body.targetX = target.x;
          body.targetY = target.y;
          placed.push(target);
        }
        body.settleFromX = body.x;
        body.settleFromY = body.y;
      });
    }

    stepBody(body, dt, time, settleT = 0) {
      if (settleT > 0) {
        body.settle = settleT;
        const e = easeInOut(settleT);
        // Sink onto the board and glide to the clear resting target.
        body.z = Math.max(0, body.z * (1 - e) - 0.4);
        if (body.targetX !== undefined) {
          body.x = body.settleFromX + (body.targetX - body.settleFromX) * e;
          body.y = body.settleFromY + (body.targetY - body.settleFromY) * e;
        }
        return;
      }

      body.x += body.vx * dt;
      body.y += body.vy * dt;
      body.z += body.vz * dt;
      body.vz -= DEFAULTS.gravity * dt;

      body.vx *= DEFAULTS.linearFriction;
      body.vy *= DEFAULTS.linearFriction;
      body.rx += body.avx * dt;
      body.ry += body.avy * dt;
      body.rz += body.avz * dt;
      body.avx *= DEFAULTS.angularFriction;
      body.avy *= DEFAULTS.angularFriction;
      body.avz *= DEFAULTS.spinFriction;

      let railHit = false;
      let boardHit = false;

      if (body.z <= 0) {
        body.z = 0;
        if (body.vz < -1.0) {
          const impact = Math.abs(body.vz);
          body.vz = impact * DEFAULTS.floorBounce;
          body.vx *= 0.90;
          body.vy *= 0.90;
          body.avx += randomBetween(-12, 12);
          body.avy += randomBetween(-12, 12);
          body.avz += randomBetween(-10, 10);
          body.displayFaces = this.randomOrientation();
          boardHit = true;
        } else {
          body.vz = 0;
        }
      }

      if (body.x < this.area.xMin) {
        body.x = this.area.xMin;
        body.vx = Math.abs(body.vx) * DEFAULTS.railBounceX;
        body.avz += randomBetween(7, 12);
        railHit = true;
      } else if (body.x > this.area.xMax) {
        body.x = this.area.xMax;
        body.vx = -Math.abs(body.vx) * DEFAULTS.railBounceX;
        body.avz -= randomBetween(7, 12);
        railHit = true;
      }

      if (body.y < this.area.yMin) {
        body.y = this.area.yMin;
        body.vy = Math.abs(body.vy) * DEFAULTS.railBounceY;
        body.avx += randomBetween(6, 11);
        railHit = true;
      } else if (body.y > this.area.yMax) {
        body.y = this.area.yMax;
        body.vy = -Math.abs(body.vy) * DEFAULTS.railBounceY;
        body.avx -= randomBetween(6, 11);
        railHit = true;
      }

      if (railHit) {
        body.displayFaces = this.randomOrientation();
        this.onImpact(speedOf(body) / 14);
      }
      if (boardHit) {
        this.onImpact(Math.min(1, Math.abs(body.vz) / 8 + 0.35));
      }

      if (time >= body.nextFaceAt && speedOf(body) + Math.abs(body.vz) > 2.4) {
        body.displayFaces = this.randomOrientation();
        body.nextFaceAt = time + randomBetween(55, 120);
      }
    }

    collideBodies(a, b) {
      if (Math.abs(a.z - b.z) > this.diceSize * 0.9) return;
      const minDistance = this.diceSize + 6;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      if (distance >= minDistance) return;

      const nx = dx / distance;
      const ny = dy / distance;
      const overlap = (minDistance - distance) / 2;
      a.x -= nx * overlap;
      a.y -= ny * overlap;
      b.x += nx * overlap;
      b.y += ny * overlap;

      const impulse = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (impulse > 0) return;

      const bounce = -impulse * DEFAULTS.bodyBounce;
      a.vx -= bounce * nx;
      a.vy -= bounce * ny;
      b.vx += bounce * nx;
      b.vy += bounce * ny;
      a.avz -= bounce * 2.6;
      b.avz += bounce * 2.6;
      a.displayFaces = this.randomOrientation();
      b.displayFaces = this.randomOrientation();
      this.onImpact(Math.min(1, Math.abs(impulse) / 13));
    }

    keepAwayFromBlockers(body) {
      const rect = this.spotRect(body);
      for (const blocker of this.blockers) {
        if (!rectsOverlap(rect, blocker)) continue;
        const leftPush = Math.abs(rect.right - blocker.left);
        const rightPush = Math.abs(blocker.right - rect.left);
        const upPush = Math.abs(rect.bottom - blocker.top);
        const downPush = Math.abs(blocker.bottom - rect.top);
        const minPush = Math.min(leftPush, rightPush, upPush, downPush);

        if (minPush === leftPush) {
          body.x = blocker.left - this.diceSize / 2;
          body.vx = -Math.abs(body.vx) * 0.68;
        } else if (minPush === rightPush) {
          body.x = blocker.right + this.diceSize / 2;
          body.vx = Math.abs(body.vx) * 0.68;
        } else if (minPush === upPush) {
          body.y = blocker.top - this.diceSize / 2;
          body.vy = -Math.abs(body.vy) * 0.68;
        } else {
          body.y = blocker.bottom + this.diceSize / 2;
          body.vy = Math.abs(body.vy) * 0.68;
        }

        body.x = clamp(body.x, this.area.xMin, this.area.xMax);
        body.y = clamp(body.y, this.area.yMin, this.area.yMax);
        body.displayFaces = this.randomOrientation();
        this.onImpact(0.44);
        return;
      }
    }

    finish() {
      if (!this.targetsAssigned) this.assignSettleTargets();
      const settleArea = this.settleArea();
      this.bodies.forEach((body, i) => {
        body.z = 0;
        body.vz = 0;
        body.vx = 0;
        body.vy = 0;
        body.settle = 1;

        // Rest on the checker-free target chosen at settle start.
        if (body.targetX !== undefined) {
          body.x = body.targetX;
          body.y = body.targetY;
        }
        body.x = clamp(body.x, settleArea.xMin, settleArea.xMax);
        body.y = clamp(body.y, settleArea.yMin, settleArea.yMax);

        body.face = this.faces[i];
        body.used = false;
        body.rolling = false;
        body.displayFaces = this.orientationFaces(this.faces[i], body.rz + i * 71);
      });
    }

    settleArea() {
      const inset = Math.max(4, this.diceGap * 0.75);
      const xMin = this.area.xMin + inset;
      const xMax = this.area.xMax - inset;
      const yMin = this.area.yMin + inset;
      const yMax = this.area.yMax - inset;
      if (xMin >= xMax || yMin >= yMax) return this.area;
      return { ...this.area, xMin, xMax, yMin, yMax };
    }

    separateRestingDice(a, b) {
      const minDistance = this.diceSize + this.diceGap;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      if (distance >= minDistance) return;

      const push = (minDistance - distance) / 2;
      const nx = dx / distance;
      const ny = dy / distance;
      const area = this.settleArea();
      a.x = clamp(a.x - nx * push, area.xMin, area.xMax);
      a.y = clamp(a.y - ny * push, area.yMin, area.yMax);
      b.x = clamp(b.x + nx * push, area.xMin, area.xMax);
      b.y = clamp(b.y + ny * push, area.yMin, area.yMax);
    }

    isSpotClear(spot, placed) {
      const rect = this.spotRect(spot);
      if (this.blockers.some(blocker => rectsOverlap(rect, blocker))) return false;
      return !placed.some(other => Math.hypot(spot.x - other.x, spot.y - other.y) < this.diceSize + this.diceGap);
    }

    spotRect(spot) {
      return {
        left: spot.x - this.diceSize / 2,
        right: spot.x + this.diceSize / 2,
        top: spot.y - this.diceSize / 2,
        bottom: spot.y + this.diceSize / 2,
      };
    }

    snapshot() {
      return this.bodies.map(body => ({ ...body }));
    }
  }

  function roll(opts) {
    return new DiceRollEngine(opts).start();
  }

  function defaultOrientation() {
    const top = 1 + Math.floor(Math.random() * 6);
    return { top, front: ((top + 1) % 6) + 1, right: ((top + 2) % 6) + 1 };
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function randomSign() {
    return Math.random() > 0.5 ? 1 : -1;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeAngle(value) {
    return ((value % 360) + 360) % 360;
  }

  function snapToRightAngle(value) {
    return normalizeAngle(Math.round(value / 90) * 90);
  }

  function speedOf(body) {
    return Math.hypot(body.vx, body.vy);
  }

  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function easeInOut(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
  }

  // Signed clearance of a die centred at (x,y): >= 0 means it overlaps no checker
  // blocker and no already-placed die; larger is further from everything.
  function clearSpotScore(x, y, blockers, placed, size, gap) {
    const half = size / 2;
    const rect = { left: x - half, right: x + half, top: y - half, bottom: y + half };
    let minClear = Infinity;
    for (const b of blockers) {
      const dx = Math.max(b.left - rect.right, rect.left - b.right);
      const dy = Math.max(b.top - rect.bottom, rect.top - b.bottom);
      minClear = Math.min(minClear, Math.max(dx, dy));
    }
    for (const p of placed) {
      minClear = Math.min(minClear, Math.hypot(x - p.x, y - p.y) - (size + gap));
    }
    return minClear;
  }

  // Grid-search the settle area for a checker-free resting spot. Returns a random
  // clear cell when one exists, otherwise the least-crowded fallback.
  function findClearSpot(area, blockers, placed, size, gap) {
    const cols = 8;
    const rows = 10;
    const cellW = (area.xMax - area.xMin) / cols;
    const cellH = (area.yMax - area.yMin) / rows;
    let best = { x: (area.xMin + area.xMax) / 2, y: (area.yMin + area.yMax) / 2 };
    let bestScore = -Infinity;
    const clear = [];
    for (let cx = 0; cx <= cols; cx++) {
      for (let cy = 0; cy <= rows; cy++) {
        const x = clamp(area.xMin + cellW * cx, area.xMin, area.xMax);
        const y = clamp(area.yMin + cellH * cy, area.yMin, area.yMax);
        const score = clearSpotScore(x, y, blockers || [], placed, size, gap);
        if (score > bestScore) { bestScore = score; best = { x, y }; }
        if (score >= 0) clear.push({ x, y });
      }
    }
    if (clear.length) return clear[Math.floor(Math.random() * clear.length)];
    return best;
  }

  return {
    DiceRollEngine,
    version: 'physics-v1',
    roll,
  };
})();
