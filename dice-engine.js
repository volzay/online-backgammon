/* ------------------------------------------------------------------
   dice-engine.js - reusable dice roll animation physics.
   Rendering stays in board-engine.js; this module owns motion.
   ------------------------------------------------------------------ */

window.NarduDiceEngine = (function () {
  const DEFAULTS = {
    duration: 1550,
    gravity: 0.88,
    floorBounce: 0.43,
    railBounceX: 0.84,
    railBounceY: 0.82,
    bodyBounce: 0.76,
    linearFriction: 0.988,
    angularFriction: 0.989,
    spinFriction: 0.99,
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
      const launchFromRight = this.color === 'white';
      return this.faces.map((_, i) => {
        const speed = randomBetween(10.5, 15.5);
        return {
          id: i,
          x: launchFromRight
            ? randomBetween(this.area.xMax - 10, this.area.xMax)
            : randomBetween(this.area.xMin, this.area.xMin + 10),
          y: randomBetween(this.area.yMin + 20, this.area.yMax - 20),
          z: randomBetween(130, 200),
          vx: (launchFromRight ? -1 : 1) * speed * randomBetween(0.86, 1.12),
          vy: randomBetween(-7.4, 7.4),
          vz: randomBetween(-16, -10),
          rx: randomBetween(-80, 80),
          ry: randomBetween(-80, 80),
          rz: randomBetween(0, 360),
          avx: randomBetween(18, 34) * randomSign(),
          avy: randomBetween(18, 34) * randomSign(),
          avz: randomBetween(14, 28) * randomSign(),
          face: 1 + Math.floor(Math.random() * 6),
          displayFaces: this.randomOrientation(),
          used: false,
          rolling: true,
          nextFaceAt: this.now() + randomBetween(45, 95),
        };
      });
    }

    step(dt, time) {
      this.bodies.forEach(body => this.stepBody(body, dt, time));

      for (let i = 0; i < this.bodies.length; i++) {
        for (let j = i + 1; j < this.bodies.length; j++) {
          this.collideBodies(this.bodies[i], this.bodies[j]);
        }
      }

      this.bodies.forEach(body => this.keepAwayFromBlockers(body));
    }

    stepBody(body, dt, time) {
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
      const placed = [];
      const settleArea = this.settleArea();
      this.bodies.forEach((body, i) => {
        body.z = 0;
        body.vz = 0;
        body.vx = 0;
        body.vy = 0;
        body.rx = 0;
        body.ry = 0;
        body.rz = snapToRightAngle(body.rz);

        for (let attempt = 0; attempt < 80; attempt++) {
          if (this.isSpotClear(body, placed)) break;
          body.x = randomBetween(settleArea.xMin, settleArea.xMax);
          body.y = randomBetween(settleArea.yMin, settleArea.yMax);
        }
        body.x = clamp(body.x, settleArea.xMin, settleArea.xMax);
        body.y = clamp(body.y, settleArea.yMin, settleArea.yMax);

        placed.push(body);
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

  return {
    DiceRollEngine,
    version: 'physics-v1',
    roll,
  };
})();
