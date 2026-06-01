/* ------------------------------------------------------------------
   board-engine.js - canvas board engine for dice and checker motion.
   Rules stay in game.js; this module owns visual physics.
   ------------------------------------------------------------------ */

window.NarduBoardEngine = (function () {
  const DIE_SIZE = 39;
  const DICE_GAP = 11;
  const DICE_ROLL_MS = 1550;
  const CHECKER_MOVE_MS = 440;
  const HIT_COOLDOWN_MS = 74;
  const MAX_DPR = 2;
  const MIN_REST_ANGLE_DELTA = 16;

  const OPPOSITE = { 1: 6, 2: 5, 3: 4, 4: 3, 5: 2, 6: 1 };
  const FACE_POOL = [1, 2, 3, 4, 5, 6];

  let placementToken = null;
  let placement = null;
  let openingPlacementToken = null;
  let openingPlacement = null;
  let placementColor = 'white';
  let lastDiceHitAt = 0;
  let lastDiceDebug = null;

  function diceScale() {
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const compactLandscape = vw <= 940 && vh <= 560 && window.matchMedia?.('(orientation: landscape)')?.matches;
    const boardFocus = document.body?.classList.contains('board-focus');
    if (boardFocus || compactLandscape || vw <= 520) return 0.82;
    if (vw <= 760) return 0.90;
    return 1;
  }

  function currentDieSize() {
    return Math.round(DIE_SIZE * diceScale());
  }

  function currentDiceGap() {
    return Math.max(6, Math.round(DICE_GAP * diceScale()));
  }

  function createDie(face, opts = {}) {
    const die = document.createElement('div');
    die.className = 'die tray-die';
    die.dataset.face = face;
    if (opts.used) die.classList.add('used');
    setDieFace(die, face);
    return die;
  }

  function renderDice(container, faces, opts = {}) {
    if (!container) return;
    if (opts.board) {
      renderBoardDice(container, faces, opts.usedMask || []);
      return;
    }

    container.innerHTML = '';
    faces.forEach((face, i) => {
      container.appendChild(createDie(face, {
        used: Boolean(opts.usedMask?.[i]),
      }));
    });
  }

  function setDieFace(die, face) {
    die.dataset.face = face;
    die.innerHTML = '';
    for (let p = 0; p < face; p++) {
      die.appendChild(Object.assign(document.createElement('div'), { className: 'pip' }));
    }
  }

  function renderBoardDice(layer, faces, usedMask) {
    const canvas = ensureDiceCanvas(layer);
    if (!canvas) return;
    sizeCanvas(canvas);

    if (!faces.length) {
      clearCanvas(canvas);
      return;
    }

    if (!placement?.dice || placement.dice.length !== faces.length) {
      placement = pickDicePlacement(placementColor, faces.length);
    }

    const bodies = placement.dice.map((spot, i) => ({
      ...spot,
      face: faces[i],
      used: Boolean(usedMask[i]),
      displayFaces: orientationFaces(faces[i], spot.seed || spot.rz || 0),
      rolling: false,
      z: 0,
    }));
    drawDiceScene(canvas, bodies);
  }

  function renderOpeningDice(layer, opening, opts = {}) {
    const canvas = ensureDiceCanvas(layer);
    if (!canvas || !opening) return;
    sizeCanvas(canvas);

    const token = opts.token || `opening:${opening.at || ''}:${opening.host?.die}:${opening.guest?.die}`;
    if (!openingPlacement || openingPlacementToken !== token) {
      openingPlacement = pickOpeningPlacement(opening);
      openingPlacementToken = token;
    }

    const bodies = openingPlacement.dice.map((spot, i) => ({
      ...spot,
      face: i === 0 ? opening.host.die : opening.guest.die,
      used: false,
      displayFaces: orientationFaces(i === 0 ? opening.host.die : opening.guest.die, spot.seed || spot.rz || 0),
      rolling: false,
      z: 0,
    }));
    drawDiceScene(canvas, bodies);
  }

  function usedDiceMask(state) {
    const remaining = state.dice.reduce((acc, face) => {
      acc[face] = (acc[face] || 0) + 1;
      return acc;
    }, {});

    return state.rolled.map(face => {
      if (remaining[face] > 0) {
        remaining[face] -= 1;
        return false;
      }
      return true;
    });
  }

  function placeDiceLayer(layer, opts = {}) {
    if (!layer) return null;
    ensureDiceCanvas(layer);
    placementColor = opts.color || placementColor;
    const token = opts.token || `${placementColor}:${opts.faces?.join(',') || opts.diceCount}`;
    const diceCount = opts.diceCount || opts.faces?.length || 2;

    if (!placement || placementToken !== token || placement.dice?.length !== diceCount) {
      placement = pickDicePlacement(placementColor, diceCount);
      placementToken = token;
    }
    return placement;
  }

  function animateDiceRoll(opts = {}) {
    const layer = opts.layer;
    const faces = opts.faces || [];
    if (!layer || faces.length === 0) return Promise.resolve();

    placementColor = opts.color || placementColor;
    const canvas = ensureDiceCanvas(layer);
    if (!canvas) return Promise.resolve();
    sizeCanvas(canvas);

    const area = diceRollArea(placementColor, faces.length);
    if (!area) return Promise.resolve();

    const duration = opts.duration || DICE_ROLL_MS;
    const blockers = checkerBlockers();
    layer.classList.add('tumbling');
    layer.dataset.diceEngineState = 'rolling';

    if (window.NarduDiceEngine?.roll) {
      layer.dataset.diceEngine = 'physics-v1';
      return window.NarduDiceEngine.roll({
        area,
        blockers,
        color: placementColor,
        diceGap: currentDiceGap(),
        diceSize: currentDieSize(),
        duration,
        faces,
        onFrame: bodies => drawDiceScene(canvas, bodies),
        onImpact: intensity => diceHit(intensity),
        orientationFaces,
        randomOrientation,
      }).then(bodies => {
        settleBodies(bodies, area, blockers);
        bodies.forEach((body, i) => {
          body.face = faces[i];
          body.used = false;
          body.rolling = false;
          body.displayFaces = orientationFaces(faces[i], body.rz + i * 71);
        });
        diversifyRestingAngles(bodies);
        placement = {
          dice: bodies.map((body, i) => ({
            x: body.x,
            y: body.y,
            z: 0,
            rx: body.rx,
            ry: body.ry,
            rz: body.rz,
            seed: body.rz + i * 71,
          })),
        };
        placementToken = opts.token || `${placementColor}:${faces.join(',')}:${Date.now()}`;
        drawDiceScene(canvas, bodies);
        diceHit(0.62);

        return new Promise(resolve => {
          setTimeout(() => {
            layer.classList.remove('tumbling');
            layer.dataset.diceEngineState = 'settled';
            resolve();
          }, 90);
        });
      });
    }

    layer.dataset.diceEngine = 'legacy';
    const bodies = createDiceBodies(placementColor, faces.length, area);
    const start = performance.now();
    let last = start;
    drawDiceScene(canvas, bodies);

    return new Promise(resolve => {
      function tick(now) {
        const done = now - start >= duration;
        const dt = Math.min(38, now - last) / 16.67;
        last = now;

        if (!done) {
          stepDiceBodies(bodies, area, blockers, dt, now);
          drawDiceScene(canvas, bodies);
          requestAnimationFrame(tick);
          return;
        }

        settleBodies(bodies, area, blockers);
        bodies.forEach((body, i) => {
          body.face = faces[i];
          body.used = false;
          body.rolling = false;
          body.displayFaces = orientationFaces(faces[i], body.rz + i * 71);
        });

        placement = {
          dice: bodies.map((body, i) => ({
            x: body.x,
            y: body.y,
            z: 0,
            rx: body.rx,
            ry: body.ry,
            rz: body.rz,
            seed: body.rz + i * 71,
          })),
        };
        placementToken = opts.token || `${placementColor}:${faces.join(',')}:${Date.now()}`;
        drawDiceScene(canvas, bodies);
        diceHit(0.62);

        setTimeout(() => {
          layer.classList.remove('tumbling');
          layer.dataset.diceEngineState = 'settled';
          resolve();
        }, 90);
      }

      requestAnimationFrame(tick);
    });
  }

  function animateOpeningRoll(opts = {}) {
    const layer = opts.layer;
    const opening = opts.opening;
    if (!layer || !opening?.host || !opening?.guest) return Promise.resolve();

    const canvas = ensureDiceCanvas(layer);
    if (!canvas) return Promise.resolve();
    sizeCanvas(canvas);

    const hostArea = diceRollArea(opening.host.color || 'white', 1);
    const guestArea = diceRollArea(opening.guest.color || 'dark', 1);
    if (!hostArea || !guestArea) return Promise.resolve();

    const duration = opts.duration || Math.max(2100, DICE_ROLL_MS + 650);
    const blockers = checkerBlockers();
    const bodies = [
      {
        ...createDiceBodies(opening.host.color || 'white', 1, hostArea)[0],
        area: hostArea,
        finalFace: opening.host.die,
      },
      {
        ...createDiceBodies(opening.guest.color || 'dark', 1, guestArea)[0],
        area: guestArea,
        finalFace: opening.guest.die,
      },
    ];
    const start = performance.now();
    let last = start;

    layer.classList.add('tumbling', 'opening-roll-active');
    layer.dataset.diceEngine = 'opening-physics-v1';
    layer.dataset.diceEngineState = 'opening-rolling';
    drawDiceScene(canvas, bodies);

    return new Promise(resolve => {
      function tick(now) {
        const done = now - start >= duration;
        const dt = Math.min(38, now - last) / 16.67;
        last = now;

        if (!done) {
          stepDiceBodies(bodies, null, blockers, dt, now);
          drawDiceScene(canvas, bodies);
          requestAnimationFrame(tick);
          return;
        }

        settleOpeningBodies(bodies, blockers);
        bodies.forEach((body, i) => {
          body.face = body.finalFace;
          body.used = false;
          body.rolling = false;
          body.displayFaces = orientationFaces(body.finalFace, body.rz + i * 71);
        });

        openingPlacement = {
          dice: bodies.map((body, i) => ({
            x: body.x,
            y: body.y,
            z: 0,
            rx: body.rx,
            ry: body.ry,
            rz: body.rz,
            seed: body.rz + i * 71,
          })),
        };
        openingPlacementToken = opts.token || `opening:${opening.at || ''}:${opening.host.die}:${opening.guest.die}`;
        drawDiceScene(canvas, bodies);
        diceHit(0.72);

        setTimeout(() => {
          layer.classList.remove('tumbling', 'opening-roll-active');
          layer.dataset.diceEngineState = 'opening-settled';
          resolve();
        }, 110);
      }

      requestAnimationFrame(tick);
    });
  }

  function createDiceBodies(color, diceCount, area) {
    const bodies = [];
    const launchFromRight = color === 'white';
    for (let i = 0; i < diceCount; i++) {
      const speed = randomBetween(10.5, 15.5);
      bodies.push({
        x: launchFromRight ? randomBetween(area.xMax - 10, area.xMax) : randomBetween(area.xMin, area.xMin + 10),
        y: randomBetween(area.yMin + 20, area.yMax - 20),
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
        displayFaces: randomOrientation(),
        used: false,
        rolling: true,
        nextFaceAt: performance.now() + randomBetween(45, 95),
      });
    }
    return bodies;
  }

  function stepDiceBodies(bodies, area, blockers, dt, now) {
    bodies.forEach(body => {
      const bounds = body.area || area;
      if (!bounds) return;

      body.x += body.vx * dt;
      body.y += body.vy * dt;
      body.z += body.vz * dt;
      body.vz -= 0.86 * dt;

      body.vx *= 0.988;
      body.vy *= 0.988;
      body.rx += body.avx * dt;
      body.ry += body.avy * dt;
      body.rz += body.avz * dt;
      body.avx *= 0.989;
      body.avy *= 0.989;
      body.avz *= 0.99;

      let railHit = false;
      let boardHit = false;
      if (body.z <= 0) {
        body.z = 0;
        if (body.vz < -1.0) {
          const impact = Math.abs(body.vz);
          body.vz = impact * 0.43;
          body.vx *= 0.90;
          body.vy *= 0.90;
          body.avx += randomBetween(-12, 12);
          body.avy += randomBetween(-12, 12);
          body.avz += randomBetween(-10, 10);
          body.displayFaces = randomOrientation();
          boardHit = true;
        } else {
          body.vz = 0;
        }
      }

      if (body.x < bounds.xMin) {
        body.x = bounds.xMin;
        body.vx = Math.abs(body.vx) * 0.84;
        body.avz += randomBetween(7, 12);
        railHit = true;
      } else if (body.x > bounds.xMax) {
        body.x = bounds.xMax;
        body.vx = -Math.abs(body.vx) * 0.84;
        body.avz -= randomBetween(7, 12);
        railHit = true;
      }

      if (body.y < bounds.yMin) {
        body.y = bounds.yMin;
        body.vy = Math.abs(body.vy) * 0.82;
        body.avx += randomBetween(6, 11);
        railHit = true;
      } else if (body.y > bounds.yMax) {
        body.y = bounds.yMax;
        body.vy = -Math.abs(body.vy) * 0.82;
        body.avx -= randomBetween(6, 11);
        railHit = true;
      }

      if (railHit) {
        body.displayFaces = randomOrientation();
        diceHit(speedOf(body) / 14);
      }
      if (boardHit) {
        diceHit(Math.min(1, Math.abs(body.vz) / 8 + 0.35));
      }

      if (now >= body.nextFaceAt && speedOf(body) + Math.abs(body.vz) > 2.4) {
        body.displayFaces = randomOrientation();
        body.nextFaceAt = now + randomBetween(55, 120);
      }
    });

    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        collideDice(bodies[i], bodies[j]);
      }
    }

    bodies.forEach(body => keepAwayFromBlockers(body, blockers, body.area || area));
  }

  function collideDice(a, b) {
    const dieSize = currentDieSize();
    if (Math.abs(a.z - b.z) > dieSize * 0.9) return;
    const minDistance = dieSize + 6;
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

    const bounce = -impulse * 0.76;
    a.vx -= bounce * nx;
    a.vy -= bounce * ny;
    b.vx += bounce * nx;
    b.vy += bounce * ny;
    a.avz -= bounce * 2.6;
    b.avz += bounce * 2.6;
    a.displayFaces = randomOrientation();
    b.displayFaces = randomOrientation();
    diceHit(Math.min(1, Math.abs(impulse) / 13));
  }

  function keepAwayFromBlockers(body, blockers, area) {
    const dieSize = currentDieSize();
    const rect = spotRect(body);
    for (const blocker of blockers) {
      if (!rectsOverlap(rect, blocker)) continue;
      const leftPush = Math.abs(rect.right - blocker.left);
      const rightPush = Math.abs(blocker.right - rect.left);
      const upPush = Math.abs(rect.bottom - blocker.top);
      const downPush = Math.abs(blocker.bottom - rect.top);
      const minPush = Math.min(leftPush, rightPush, upPush, downPush);

      if (minPush === leftPush) {
        body.x = blocker.left - dieSize / 2;
        body.vx = -Math.abs(body.vx) * 0.68;
      } else if (minPush === rightPush) {
        body.x = blocker.right + dieSize / 2;
        body.vx = Math.abs(body.vx) * 0.68;
      } else if (minPush === upPush) {
        body.y = blocker.top - dieSize / 2;
        body.vy = -Math.abs(body.vy) * 0.68;
      } else {
        body.y = blocker.bottom + dieSize / 2;
        body.vy = Math.abs(body.vy) * 0.68;
      }
      body.x = clamp(body.x, area.xMin, area.xMax);
      body.y = clamp(body.y, area.yMin, area.yMax);
      body.displayFaces = randomOrientation();
      diceHit(0.44);
      return;
    }
  }

  function drawDiceScene(canvas, bodies) {
    captureDiceDebug(canvas, bodies);
    if (window.NarduDiceWebGL?.renderDiceScene?.(canvas, bodies, { diceSize: currentDieSize() })) {
      return;
    }

    sizeCanvas(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.__dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    bodies.forEach(body => drawDieShadow(ctx, body));
    [...bodies]
      .sort((a, b) => (a.y + a.z * 0.18) - (b.y + b.z * 0.18))
      .forEach(body => drawDie(ctx, body));
  }

  function captureDiceDebug(canvas, bodies) {
    const board = document.getElementById('board');
    const bar = board?.querySelector('.bar');
    const boardRect = board?.getBoundingClientRect();
    const barRect = bar?.getBoundingClientRect();
    lastDiceDebug = {
      diceSize: currentDieSize(),
      diceGap: currentDiceGap(),
      board: boardRect ? { width: boardRect.width, height: boardRect.height } : null,
      bar: boardRect && barRect ? {
        left: barRect.left - boardRect.left,
        right: barRect.right - boardRect.left,
        top: barRect.top - boardRect.top,
        bottom: barRect.bottom - boardRect.top,
      } : null,
      blockers: checkerBlockers(),
      dice: (bodies || []).map(body => ({
        x: body.x,
        y: body.y,
        z: body.z || 0,
        face: body.face,
        used: Boolean(body.used),
      })),
    };
    const layer = canvas?.closest?.('.board-dice-layer');
    if (layer) layer.dataset.diceDebug = JSON.stringify(lastDiceDebug);
  }

  function getDiceDebug() {
    return lastDiceDebug ? JSON.parse(JSON.stringify(lastDiceDebug)) : null;
  }

  function drawDieShadow(ctx, body) {
    const dieSize = currentDieSize();
    const height = Math.max(0, body.z);
    const liftScale = Math.min(height, 170) / 170;
    const scale = 1 + liftScale * 0.72;
    const alpha = Math.max(0.06, 0.20 - liftScale * 0.13);

    ctx.save();
    ctx.globalAlpha = body.used ? alpha * 0.40 : alpha;
    ctx.filter = `blur(${2.2 + liftScale * 7}px)`;
    ctx.fillStyle = 'rgba(96, 60, 34, 0.36)';
    ctx.beginPath();
    ctx.ellipse(body.x, body.y + dieSize * 0.24, dieSize * 0.40 * scale, dieSize * 0.23 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (height < 5) {
      ctx.save();
      ctx.globalAlpha = body.used ? 0.04 : 0.11;
      ctx.filter = 'blur(0.8px)';
      ctx.fillStyle = 'rgba(88, 56, 32, 0.48)';
      ctx.beginPath();
      ctx.ellipse(body.x + 1, body.y + dieSize * 0.31, dieSize * 0.34, dieSize * 0.13, body.rz * Math.PI / 180, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawDie(ctx, body) {
    const shape = dieShape(body);
    const faces = body.displayFaces || orientationFaces(body.face || 1, body.rz);

    ctx.save();
    drawDiceFace(ctx, shape.sideFaces[0].points, faces.front, {
      fillA: '#e8e8e8',
      fillB: '#dedede',
      rimA: '#bdbdbd',
      rimB: '#ffffff',
      stroke: 'rgba(188, 188, 188, 0.34)',
      pip: '#14181d',
      radius: 5,
      bevel: 3.2,
      pipRadius: 2.0,
      side: 'side',
    });
    drawDiceFace(ctx, shape.sideFaces[1].points, faces.right, {
      fillA: '#e6e6e6',
      fillB: '#d9d9d9',
      rimA: '#b9b9b9',
      rimB: '#ffffff',
      stroke: 'rgba(188, 188, 188, 0.32)',
      pip: '#14181d',
      radius: 5,
      bevel: 3.2,
      pipRadius: 2.0,
      side: 'side',
    });
    drawDiceFace(ctx, shape.top, faces.top, {
      fillA: '#eeeeee',
      fillB: '#e4e4e4',
      rimA: '#bdbdbd',
      rimB: '#ffffff',
      stroke: 'rgba(188, 188, 188, 0.36)',
      pip: '#14181d',
      radius: 10,
      bevel: 5.6,
      pipRadius: 3.2,
      side: 'top',
    });

    if (body.used) drawUsedOverlay(ctx, shape);
    ctx.restore();
  }

  function dieShape(body) {
    const yaw = body.rz * Math.PI / 180;
    const dieSize = currentDieSize();
    const half = dieSize / 2;
    const heightLift = Math.max(0, body.z) * 0.57;
    const center = {
      x: body.x,
      y: body.y - heightLift - dieSize * 0.15,
    };

    const topPulse = body.rolling
      ? 1 + Math.sin((body.rx + body.ry) * Math.PI / 180) * 0.015
      : 1;
    const top = [
      projectSquareCorner(center, -half, -half, yaw, topPulse),
      projectSquareCorner(center, half, -half, yaw, topPulse),
      projectSquareCorner(center, half, half, yaw, topPulse),
      projectSquareCorner(center, -half, half, yaw, topPulse),
    ];
    const thickness = dieSize * 0.44 + (body.rolling ? Math.abs(Math.sin(body.ry * Math.PI / 180)) * dieSize * 0.10 : 0);
    const drop = {
      x: Math.sin(yaw) * 1.6,
      y: thickness,
    };
    const bottom = top.map(p => ({ x: p.x + drop.x, y: p.y + drop.y }));
    const low = top.reduce((best, point, i) => point.y > top[best].y ? i : best, 0);
    const prev = (low + 3) % 4;
    const next = (low + 1) % 4;
    const sideFaces = [
      {
        points: [top[prev], top[low], bottom[low], bottom[prev]],
        edge: [prev, low],
      },
      {
        points: [top[low], top[next], bottom[next], bottom[low]],
        edge: [low, next],
      },
    ].sort((a, b) => avgX(a.points) - avgX(b.points));

    return {
      top,
      bottom,
      sideFaces,
    };
  }

  function projectSquareCorner(center, x, y, yaw, scale) {
    return {
      x: center.x + (x * Math.cos(yaw) - y * Math.sin(yaw)) * scale,
      y: center.y + (x * Math.sin(yaw) + y * Math.cos(yaw)) * scale,
    };
  }

  function avgX(points) {
    return points.reduce((sum, p) => sum + p.x, 0) / points.length;
  }

  function drawDiceFace(ctx, points, value, opts) {
    const innerPoints = insetPolygon(points, opts.bevel || 4);
    const gradient = ctx.createLinearGradient(innerPoints[0].x, innerPoints[0].y, innerPoints[2].x, innerPoints[2].y);
    gradient.addColorStop(0, opts.fillA);
    gradient.addColorStop(1, opts.fillB);

    ctx.save();
    roundedPolygonPath(ctx, points, opts.radius);
    ctx.fillStyle = opts.rimA || '#c8ccd0';
    ctx.fill();
    ctx.clip();
    drawBevelBands(ctx, points, opts);
    roundedPolygonPath(ctx, innerPoints, Math.max(2, opts.radius - (opts.bevel || 4) * 0.85));
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.clip();
    drawFaceShade(ctx, points, opts.side !== 'top');
    drawPipsOnQuad(ctx, innerPoints, value, opts);
    ctx.restore();

    ctx.save();
    roundedPolygonPath(ctx, points, opts.radius);
    ctx.strokeStyle = opts.stroke;
    ctx.lineWidth = opts.side === 'top' ? 0.26 : 0.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  function drawBevelBands(ctx, points, opts) {
    const band = opts.bevel || 4;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = band;
    ctx.strokeStyle = opts.rimA || '#c8ccd0';
    drawEdge(ctx, points[0], points[1]);
    drawEdge(ctx, points[3], points[0]);
    ctx.strokeStyle = opts.rimB || '#ffffff';
    drawEdge(ctx, points[1], points[2]);
    drawEdge(ctx, points[2], points[3]);
    ctx.restore();
  }

  function drawEdge(ctx, a, b) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function drawFaceShade(ctx, points, side) {
    const gradient = ctx.createLinearGradient(points[0].x, points[0].y, points[3].x, points[3].y);
    gradient.addColorStop(0, side ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.20)');
    gradient.addColorStop(1, side ? 'rgba(170,170,170,0.10)' : 'rgba(170,170,170,0.04)');
    ctx.fillStyle = gradient;
    ctx.fillRect(
      Math.min(...points.map(p => p.x)) - 2,
      Math.min(...points.map(p => p.y)) - 2,
      Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)) + 4,
      Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)) + 4
    );
  }

  function drawEdgeHighlights(ctx, shape) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(189, 189, 189, 0.42)';
    ctx.lineWidth = 0.35;
    roundedPolygonPath(ctx, shape.top, 11);
    ctx.stroke();
    ctx.restore();
  }

  function drawUsedOverlay(ctx, shape) {
    ctx.save();
    ctx.fillStyle = 'rgba(90, 96, 104, 0.30)';
    [...shape.sideFaces.map(face => face.points), shape.top].forEach(points => {
      roundedPolygonPath(ctx, points, 10);
      ctx.fill();
    });
    ctx.strokeStyle = 'rgba(189, 189, 189, 0.28)';
    ctx.lineWidth = 0.35;
    roundedPolygonPath(ctx, shape.top, 11);
    ctx.stroke();
    ctx.restore();
  }

  function roundedPolygonPath(ctx, points, radius) {
    const maxRadius = Math.min(radius, ...points.map((point, i) => {
      const prev = points[(i - 1 + points.length) % points.length];
      const next = points[(i + 1) % points.length];
      return Math.min(distance(point, prev), distance(point, next)) * 0.34;
    }));
    const center = polygonCenter(points);

    ctx.beginPath();
    points.forEach((point, i) => {
      const prev = points[(i - 1 + points.length) % points.length];
      const next = points[(i + 1) % points.length];
      const from = insetPoint(point, prev, maxRadius);
      const to = insetPoint(point, next, maxRadius);
      const control = pullPoint(point, center, Math.min(maxRadius * 0.16, 1.8));
      if (i === 0) ctx.moveTo(from.x, from.y);
      else ctx.lineTo(from.x, from.y);
      ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
    });
    ctx.closePath();
  }

  function drawPipsOnQuad(ctx, points, value, opts) {
    const spots = pipSpots(value);
    ctx.save();
    ctx.fillStyle = opts.pip;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 0.45;
    for (const [u, v] of spots) {
      const p = quadPoint(points, u, v);

      ctx.beginPath();
      ctx.arc(p.x, p.y, opts.pipRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function pipSpots(face) {
    const low = 0.25;
    const mid = 0.5;
    const high = 0.75;
    const map = {
      1: [[mid, mid]],
      2: [[low, low], [high, high]],
      3: [[low, low], [mid, mid], [high, high]],
      4: [[low, low], [high, low], [low, high], [high, high]],
      5: [[low, low], [high, low], [mid, mid], [low, high], [high, high]],
      6: [[low, low], [high, low], [low, mid], [high, mid], [low, high], [high, high]],
    };
    return map[face] || map[1];
  }

  function quadPoint(points, u, v) {
    const a = lerpPoint(points[0], points[1], u);
    const b = lerpPoint(points[3], points[2], u);
    return lerpPoint(a, b, v);
  }

  function lerpPoint(a, b, t) {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    };
  }

  function insetPolygon(points, amount) {
    const center = polygonCenter(points);
    return points.map(point => pullPoint(point, center, amount));
  }

  function insetPoint(point, target, amount) {
    const len = distance(point, target) || 1;
    return {
      x: point.x + (target.x - point.x) / len * amount,
      y: point.y + (target.y - point.y) / len * amount,
    };
  }

  function pullPoint(point, center, amount) {
    const len = distance(point, center) || 1;
    return {
      x: point.x + (center.x - point.x) / len * amount,
      y: point.y + (center.y - point.y) / len * amount,
    };
  }

  function polygonCenter(points) {
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    };
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function ensureDiceCanvas(layer) {
    if (!layer) return null;
    let canvas = layer.querySelector('canvas.board-dice-canvas');
    if (!canvas) {
      layer.innerHTML = '';
      canvas = document.createElement('canvas');
      canvas.className = 'board-dice-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      layer.appendChild(canvas);
    }
    return canvas;
  }

  function sizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvas.__dpr = dpr;
  }

  function clearCanvas(canvas) {
    if (window.NarduDiceWebGL?.clearDiceScene?.(canvas)) return;

    sizeCanvas(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.__dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
  }

  function animateCheckerMove(opts = {}) {
    const fromEl = document.querySelector(`[data-point="${opts.from}"]`);
    const stackEl = fromEl?.querySelector('.stack');
    const checker = stackEl?.lastElementChild;
    if (!checker) return Promise.resolve(false);

    const source = checker.getBoundingClientRect();
    const target = checkerTargetRect({
      color: opts.color,
      to: opts.to,
      source,
      destinationCount: opts.destinationCount || 0,
    });
    if (!target) return Promise.resolve(false);

    const clone = checker.cloneNode(true);
    clone.classList.add('board-flying-checker');
    Object.assign(clone.style, {
      position: 'fixed',
      left: `${source.left}px`,
      top: `${source.top}px`,
      width: `${source.width}px`,
      height: `${source.height}px`,
      margin: '0',
      zIndex: '9999',
      pointerEvents: 'none',
      filter: 'drop-shadow(0 8px 18px oklch(0 0 0 / 0.46))',
    });
    document.body.appendChild(clone);
    checker.style.opacity = '0';

    const dx = target.x - source.left;
    const dy = target.y - source.top;
    const lift = Math.min(72, Math.max(34, Math.abs(dx) * 0.16 + Math.abs(dy) * 0.08));
    const arcY = checkerArcBendY(source, target, dy, lift);
    const animation = clone.animate([
      { transform: 'translate3d(0, 0, 0) scale(1)', filter: 'drop-shadow(0 8px 18px oklch(0 0 0 / 0.46))' },
      { transform: `translate3d(${dx * 0.48}px, ${arcY}px, 0) scale(1.08)`, filter: 'drop-shadow(0 16px 24px oklch(0 0 0 / 0.36))', offset: 0.55 },
      { transform: `translate3d(${dx}px, ${dy}px, 0) scale(1)`, filter: 'drop-shadow(0 5px 12px oklch(0 0 0 / 0.42))' },
    ], {
      duration: CHECKER_MOVE_MS,
      easing: 'cubic-bezier(0.25, 0.82, 0.32, 1)',
      fill: 'forwards',
    });

    return animation.finished
      .catch(() => null)
      .then(() => {
        clone.remove();
        return true;
      });
  }

  function checkerArcBendY(source, target, dy, lift) {
    const boardRect = document.getElementById('board')?.getBoundingClientRect();
    if (!boardRect) return dy * 0.48 - lift;

    const sourceCenterY = source.top + source.height / 2;
    const targetCenterY = target.y + source.height / 2;
    const routeMidY = (sourceCenterY + targetCenterY) / 2;
    const boardCenterY = boardRect.top + boardRect.height / 2;
    const referenceY = Math.abs(routeMidY - boardCenterY) < 14 ? sourceCenterY : routeMidY;
    const bendTowardCenter = referenceY < boardCenterY ? lift : -lift;
    return dy * 0.48 + bendTowardCenter;
  }

  function checkerTargetRect(opts) {
    if (opts.to === 0) {
      const tr = document.querySelector(`.bear-track.${opts.color}`)?.getBoundingClientRect();
      if (!tr) return null;
      const cx = opts.color === 'white' ? (tr.left + 60) : (tr.right - 60);
      return {
        x: cx - opts.source.width / 2,
        y: tr.top + tr.height / 2 - opts.source.height / 2,
      };
    }

    const targetPoint = document.querySelector(`[data-point="${opts.to}"]`);
    const targetRect = targetPoint?.getBoundingClientRect();
    if (!targetRect) return null;

    const gap = stackGap(opts.destinationCount + 1, opts.source.width, targetPoint);
    const inset = stackInset(targetPoint);
    const isBottomQuad = targetPoint.classList.contains('bottom');
    return {
      x: targetRect.left + targetRect.width / 2 - opts.source.width / 2,
      y: isBottomQuad
        ? targetRect.bottom - (inset + opts.destinationCount * gap) - opts.source.height
        : targetRect.top + inset + opts.destinationCount * gap,
    };
  }

  function boardCssPx(name, fallback) {
    const board = document.getElementById('board');
    if (!board) return fallback;
    const value = parseFloat(getComputedStyle(board).getPropertyValue(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function stackInset() {
    return boardCssPx('--checker-seat-inset', Math.max(6, currentCheckerSize() * 0.36));
  }

  function stackAreaHeight(pointEl) {
    const pointHeight = pointEl?.getBoundingClientRect?.().height;
    if (Number.isFinite(pointHeight) && pointHeight > 0) return pointHeight;
    const boardHeight = document.getElementById('board')?.getBoundingClientRect().height || 540;
    return boardHeight / 2;
  }

  function stackGap(count, checkerSize = currentCheckerSize(), pointEl = null) {
    if (count <= 1) return 0;
    const preferred = checkerSize * (count <= 5 ? 0.62 : count <= 8 ? 0.48 : count <= 12 ? 0.36 : 0.29);
    const available = stackAreaHeight(pointEl) - stackInset() * 2 - checkerSize;
    const fitted = available / Math.max(1, count - 1);
    return Math.max(0, Math.min(preferred, fitted));
  }

  function currentCheckerSize() {
    const checker = document.querySelector('.chk');
    const rect = checker?.getBoundingClientRect();
    if (rect?.height) return rect.height;
    return boardCssPx('--checker-size', 42);
  }

  function diceRollArea(color, diceCount) {
    const board = document.getElementById('board');
    const bar = board?.querySelector('.bar');
    const boardRect = board?.getBoundingClientRect();
    const barRect = bar?.getBoundingClientRect();
    if (!boardRect || !barRect) return null;
    const dieSize = currentDieSize();

    const railGap = boardRect.height < 420 ? Math.max(42, dieSize + 12) : 46;
    const topGap = boardRect.height < 420 ? Math.max(52, dieSize + 18) : 70;
    const barLeft = barRect.left - boardRect.left;
    const barRight = barRect.right - boardRect.left;

    const viewColor = board.dataset.viewColor || 'white';
    const rollOnRight = color === viewColor;

    return {
      xMin: rollOnRight
        ? barRight + railGap + dieSize / 2
        : railGap + dieSize / 2,
      xMax: rollOnRight
        ? boardRect.width - railGap - dieSize / 2
        : barLeft - railGap - dieSize / 2,
      yMin: topGap + dieSize / 2,
      yMax: boardRect.height - topGap - dieSize / 2,
      diceCount,
    };
  }

  function pickDicePlacement(color, diceCount) {
    const board = document.getElementById('board');
    const boardRect = board?.getBoundingClientRect();
    const area = diceRollArea(color, diceCount);
    if (!boardRect || !area || area.xMin >= area.xMax || area.yMin >= area.yMax) {
      return { dice: fallbackDice(boardRect || { width: 640, height: 380 }, diceCount, color) };
    }

    const blockers = checkerBlockers();
    const dice = [];
    for (let i = 0; i < diceCount; i++) {
      dice.push(pickRestingSpot(area, blockers, dice, i));
    }
    return { dice: diversifyRestingAngles(dice) };
  }

  function pickOpeningPlacement(opening) {
    const hostArea = diceRollArea(opening.host.color || 'white', 1);
    const guestArea = diceRollArea(opening.guest.color || 'dark', 1);
    const blockers = checkerBlockers();
    const hostSpot = hostArea
      ? pickRestingSpot(hostArea, blockers, [], 0)
      : fallbackDice(document.getElementById('board')?.getBoundingClientRect() || { width: 640, height: 380 }, 1, opening.host.color || 'white')[0];
    const guestSpot = guestArea
      ? pickRestingSpot(guestArea, blockers, [], 0)
      : fallbackDice(document.getElementById('board')?.getBoundingClientRect() || { width: 640, height: 380 }, 1, opening.guest.color || 'dark')[0];
    return { dice: diversifyRestingAngles([hostSpot, guestSpot]) };
  }

  function pickRestingSpot(area, blockers, placed, index) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const spot = {
        x: randomBetween(area.xMin, area.xMax),
        y: randomBetween(area.yMin, area.yMax),
        z: 0,
        rx: randomBetween(-4, 4),
        ry: randomBetween(-4, 4),
        rz: randomBetween(0, 360),
        seed: Math.random() * 1000,
      };
      if (isSpotClear(spot, blockers, placed)) return spot;
    }

    const fallbackOffset = (index - Math.max(0, placed.length / 2)) * (currentDieSize() * 0.72);
    return {
      x: clamp((area.xMin + area.xMax) / 2 + fallbackOffset, area.xMin, area.xMax),
      y: randomBetween(area.yMin, area.yMax),
      z: 0,
      rx: randomBetween(-4, 4),
      ry: randomBetween(-4, 4),
      rz: randomBetween(0, 360),
      seed: Math.random() * 1000,
    };
  }

  function settleBodies(bodies, area, blockers) {
    bodies.forEach(body => {
      body.z = 0;
      body.vz = 0;
      body.vx = 0;
      body.vy = 0;
      body.rx = randomBetween(-3.5, 3.5);
      body.ry = randomBetween(-3.5, 3.5);
      body.rz = normalizeFlatAngle(body.rz + randomBetween(-18, 18));

      const settleArea = insetDiceArea(area);

      for (let attempt = 0; attempt < 60; attempt++) {
        const others = bodies.filter(other => other !== body).map(other => ({ x: other.x, y: other.y }));
        if (isSpotClear(body, blockers, others)) break;
        body.x = randomBetween(settleArea.xMin, settleArea.xMax);
        body.y = randomBetween(settleArea.yMin, settleArea.yMax);
      }

      body.x = clamp(body.x, settleArea.xMin, settleArea.xMax);
      body.y = clamp(body.y, settleArea.yMin, settleArea.yMax);
    });

    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          separateRestingDice(bodies[i], bodies[j], insetDiceArea(area));
        }
      }
    }
    diversifyRestingAngles(bodies);
  }

  function settleOpeningBodies(bodies, blockers) {
    bodies.forEach(body => {
      const area = body.area;
      const settleArea = insetDiceArea(area);
      body.z = 0;
      body.vz = 0;
      body.vx = 0;
      body.vy = 0;
      body.rx = randomBetween(-3.5, 3.5);
      body.ry = randomBetween(-3.5, 3.5);
      body.rz = normalizeFlatAngle(body.rz + randomBetween(-18, 18));

      for (let attempt = 0; attempt < 70; attempt++) {
        if (isSpotClear(body, blockers, [])) break;
        body.x = randomBetween(settleArea.xMin, settleArea.xMax);
        body.y = randomBetween(settleArea.yMin, settleArea.yMax);
      }
      body.x = clamp(body.x, settleArea.xMin, settleArea.xMax);
      body.y = clamp(body.y, settleArea.yMin, settleArea.yMax);
    });
    diversifyRestingAngles(bodies);
  }

  function insetDiceArea(area) {
    if (!area) return null;
    const inset = Math.max(4, currentDiceGap() * 0.75);
    const xMin = area.xMin + inset;
    const xMax = area.xMax - inset;
    const yMin = area.yMin + inset;
    const yMax = area.yMax - inset;
    if (xMin >= xMax || yMin >= yMax) return area;
    return { ...area, xMin, xMax, yMin, yMax };
  }

  function separateRestingDice(a, b, area) {
    const minDistance = currentDieSize() + currentDiceGap();
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distanceValue = Math.hypot(dx, dy) || 1;
    if (distanceValue >= minDistance) return;
    const push = (minDistance - distanceValue) / 2;
    const nx = dx / distanceValue;
    const ny = dy / distanceValue;
    a.x = clamp(a.x - nx * push, area.xMin, area.xMax);
    a.y = clamp(a.y - ny * push, area.yMin, area.yMax);
    b.x = clamp(b.x + nx * push, area.xMin, area.xMax);
    b.y = clamp(b.y + ny * push, area.yMin, area.yMax);
  }

  function checkerBlockers() {
    const board = document.getElementById('board');
    const boardRect = board?.getBoundingClientRect();
    if (!boardRect) return [];
    return [...board.querySelectorAll('.chk')].map(el => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - boardRect.left - 12,
        right: r.right - boardRect.left + 12,
        top: r.top - boardRect.top - 12,
        bottom: r.bottom - boardRect.top + 12,
      };
    });
  }

  function isSpotClear(spot, blockers, placed) {
    const rect = spotRect(spot);
    if (blockers.some(blocker => rectsOverlap(rect, blocker))) return false;
    return !placed.some(other => Math.hypot(spot.x - other.x, spot.y - other.y) < currentDieSize() + currentDiceGap());
  }

  function spotRect(spot) {
    const dieSize = currentDieSize();
    return {
      left: spot.x - dieSize / 2,
      right: spot.x + dieSize / 2,
      top: spot.y - dieSize / 2,
      bottom: spot.y + dieSize / 2,
    };
  }

  function fallbackDice(boardRect, diceCount, color) {
    const dieSize = currentDieSize();
    const baseX = color === 'white' ? boardRect.width * 0.72 : boardRect.width * 0.28;
    const baseY = boardRect.height * 0.52;
    const dice = Array.from({ length: diceCount }, (_, i) => ({
      x: baseX + (i - (diceCount - 1) / 2) * (dieSize * 0.86),
      y: baseY + ((i % 2) ? 18 : -13),
      z: 0,
      rx: randomBetween(-3, 3),
      ry: randomBetween(-3, 3),
      rz: randomBetween(0, 360),
      seed: Math.random() * 1000,
    }));
    return diversifyRestingAngles(dice);
  }

  function diversifyRestingAngles(dice) {
    dice.forEach((body, index) => {
      body.rz = normalizeFlatAngle(body.rz ?? randomBetween(0, 360));
      for (let attempt = 0; attempt < 12; attempt++) {
        const tooParallel = dice.slice(0, index).some(other =>
          squareAngleDelta(body.rz, other.rz || 0) < MIN_REST_ANGLE_DELTA
        );
        if (!tooParallel) break;
        body.rz = normalizeFlatAngle(body.rz + MIN_REST_ANGLE_DELTA + 8 + index * 11 + attempt * 7 + randomBetween(0, 12));
      }
      body.seed = body.rz + index * 71;
    });
    return dice;
  }

  function squareAngleDelta(a, b) {
    const diff = Math.abs((((a - b) % 90) + 90) % 90);
    return Math.min(diff, 90 - diff);
  }

  function orientationFaces(top, seed = 0) {
    const available = FACE_POOL.filter(face => face !== top && face !== OPPOSITE[top]);
    const index = Math.abs(Math.floor(seed / 90)) % available.length;
    const front = available[index];
    const sideCandidates = available.filter(face => face !== front && face !== OPPOSITE[front]);
    const right = sideCandidates[Math.abs(Math.floor(seed / 37)) % sideCandidates.length];
    return { top, front, right };
  }

  function randomOrientation() {
    const top = 1 + Math.floor(Math.random() * 6);
    return orientationFaces(top, Math.random() * 1440);
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

  function normalizeFlatAngle(value) {
    return ((value % 360) + 360) % 360;
  }

  function speedOf(body) {
    return Math.hypot(body.vx, body.vy);
  }

  function diceHit(intensity) {
    const now = performance.now();
    if (now - lastDiceHitAt < HIT_COOLDOWN_MS) return;
    lastDiceHitAt = now;
    window.NarduSound?.diceHit?.(intensity);
  }

  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  return {
    animateCheckerMove,
    animateDiceRoll,
    animateOpeningRoll,
    createDie,
    getDiceDebug,
    placeDiceLayer,
    renderOpeningDice,
    renderDice,
    usedDiceMask,
  };
})();
