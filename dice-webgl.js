/* ------------------------------------------------------------------
   dice-webgl.js - WebGL dice renderer for board dice.
   Dice motion is provided by dice-engine.js; this file renders volume.
   ------------------------------------------------------------------ */

window.NarduDiceWebGL = (function () {
  const OPPOSITE = { 1: 6, 2: 5, 3: 4, 4: 3, 5: 2, 6: 1 };
  const FACE_POOL = [1, 2, 3, 4, 5, 6];
  const renderers = new WeakMap();

  const FACE_DEFS = [
    { key: 'top', normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], value: faces => faces.top },
    { key: 'bottom', normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], value: faces => OPPOSITE[faces.top] },
    { key: 'right', normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], value: faces => faces.right },
    { key: 'left', normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], value: faces => OPPOSITE[faces.right] },
    { key: 'front', normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], value: faces => faces.front },
    { key: 'back', normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], value: faces => OPPOSITE[faces.front] },
  ];

  const FACE_COLORS = {
    top: [0.93, 0.93, 0.93, 1],
    side: [0.88, 0.88, 0.88, 1],
    rim: [0.74, 0.74, 0.74, 1],
    rimLight: [0.98, 0.98, 0.98, 1],
    restFace: [0.89, 0.89, 0.89, 1],
    restRim: [0.76, 0.76, 0.76, 1],
    restRimLight: [1.00, 1.00, 0.99, 1],
    pip: [0.055, 0.065, 0.078, 1],
    pipShadow: [0.00, 0.00, 0.00, 0.24],
    pipHighlight: [0.46, 0.46, 0.46, 0.28],
    shadow: [0.30, 0.18, 0.10, 1],
  };

  const VERTEX_SHADER = `
    attribute vec3 a_position;
    attribute vec3 a_normal;
    attribute vec4 a_color;

    uniform mat4 u_matrix;
    uniform vec3 u_light;

    varying vec3 v_normal;
    varying vec4 v_color;
    varying float v_light;

    void main() {
      vec3 normal = normalize(a_normal);
      float diffuse = max(dot(normal, normalize(u_light)), 0.0);
      float facing = max(dot(normal, vec3(0.0, 0.0, 1.0)), 0.0);
      v_light = 0.72 + diffuse * 0.26 + facing * 0.08;
      v_normal = normal;
      v_color = a_color;
      gl_Position = u_matrix * vec4(a_position, 1.0);
    }
  `;

  const FRAGMENT_SHADER = `
    precision mediump float;

    varying vec3 v_normal;
    varying vec4 v_color;
    varying float v_light;

    void main() {
      vec3 color = v_color.rgb * v_light;
      gl_FragColor = vec4(color, v_color.a);
    }
  `;

  class DiceWebGLRenderer {
    constructor(canvas, gl, program) {
      this.canvas = canvas;
      this.gl = gl;
      this.program = program;
      this.buffer = gl.createBuffer();
      this.locations = {
        position: gl.getAttribLocation(program, 'a_position'),
        normal: gl.getAttribLocation(program, 'a_normal'),
        color: gl.getAttribLocation(program, 'a_color'),
        matrix: gl.getUniformLocation(program, 'u_matrix'),
        light: gl.getUniformLocation(program, 'u_light'),
      };
    }

    render(bodies, opts = {}) {
      const gl = this.gl;
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const dpr = this.canvas.__dpr || Math.min(2, window.devicePixelRatio || 1);
      const targetWidth = Math.max(1, Math.round(rect.width * dpr));
      const targetHeight = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
        this.canvas.width = targetWidth;
        this.canvas.height = targetHeight;
      }

      this.canvas.dataset.renderer = 'webgl';
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const matrix = perspectiveBoardMatrix(rect.width, rect.height);
      const scene = buildScene(bodies, rect.width, rect.height, opts.diceSize || 40);

      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.locations.matrix, false, matrix);
      gl.uniform3f(this.locations.light, -0.34, -0.42, 0.84);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.CULL_FACE);

      this.drawBatch(scene.shadows, false);
      this.drawBatch(scene.dice, true);
    }

    clear() {
      const gl = this.gl;
      this.canvas.dataset.renderer = 'webgl';
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    drawBatch(batch, depthEnabled) {
      if (!batch.count) return;
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.data), gl.STREAM_DRAW);

      const stride = 10 * 4;
      gl.enableVertexAttribArray(this.locations.position);
      gl.vertexAttribPointer(this.locations.position, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this.locations.normal);
      gl.vertexAttribPointer(this.locations.normal, 3, gl.FLOAT, false, stride, 3 * 4);
      gl.enableVertexAttribArray(this.locations.color);
      gl.vertexAttribPointer(this.locations.color, 4, gl.FLOAT, false, stride, 6 * 4);

      if (depthEnabled) {
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
      } else {
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
      }

      gl.drawArrays(gl.TRIANGLES, 0, batch.count);
      gl.depthMask(true);
    }
  }

  function renderDiceScene(canvas, bodies, opts = {}) {
    const renderer = rendererFor(canvas);
    if (!renderer) return false;
    renderer.render(bodies || [], opts);
    return true;
  }

  function clearDiceScene(canvas) {
    const renderer = rendererFor(canvas);
    if (!renderer) return false;
    renderer.clear();
    return true;
  }

  function rendererFor(canvas) {
    if (!canvas) return null;
    if (renderers.has(canvas)) return renderers.get(canvas);

    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    }) || canvas.getContext('experimental-webgl', {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) return null;

    const program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    if (!program) return null;

    const renderer = new DiceWebGLRenderer(canvas, gl, program);
    renderers.set(canvas, renderer);
    return renderer;
  }

  function createProgram(gl, vertexSource, fragmentSource) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('Dice WebGL link failed:', gl.getProgramInfoLog(program));
      return null;
    }
    return program;
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('Dice WebGL shader failed:', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }

  function buildScene(bodies, width, height, diceSize) {
    const shadows = [];
    const dice = [];

    bodies.forEach(body => addShadow(shadows, body, width, height, diceSize));
    bodies
      .slice()
      .sort((a, b) => (a.y + a.z * 0.2) - (b.y + b.z * 0.2))
      .forEach(body => addDie(dice, body, width, height, diceSize));

    return {
      shadows: { data: shadows, count: shadows.length / 10 },
      dice: { data: dice, count: dice.length / 10 },
    };
  }

  function addDie(out, body, width, height, diceSize) {
    const transform = bodyTransform(body, width, height);
    const faces = normalizedFaces(body);
    const used = Boolean(body.used);
    const half = diceSize / 2;
    const bevel = Math.max(3.4, diceSize * 0.12);
    const pipRadius = Math.max(2.2, diceSize * 0.072);

    if (isResting(body)) {
      addRestingDie(out, transform, faces, {
        half,
        bevel: Math.max(4.4, diceSize * 0.15),
        pipRadius: Math.max(2.9, diceSize * 0.082),
        used,
      });
      return;
    }

    FACE_DEFS.forEach(def => {
      const value = def.value(faces);
      const frontFacing = transformedNormal(transform, def.normal)[2] > -0.58;
      if (!frontFacing && def.key !== 'bottom') return;

      addFace(out, transform, def, value, {
        half,
        bevel,
        pipRadius,
        used,
        faceColor: faceColor(def, used),
        rimColor: rimColor(def, used),
        pipColor: used ? dimColor(FACE_COLORS.pip, 0.70) : FACE_COLORS.pip,
      });
    });
  }

  function addRestingDie(out, transform, faces, opts) {
    const normal = [0, 0, 1];
    const uAxis = [1, 0, 0];
    const vAxis = [0, 1, 0];
    const half = opts.half;
    const band = opts.bevel;
    const radius = Math.min(half * 0.34, 7.2);
    const innerHalf = half - band;
    const innerRadius = Math.max(2.8, radius - band * 0.46);
    const faceColor = opts.used ? dimColor(FACE_COLORS.restFace, 0.70) : FACE_COLORS.restFace;
    const rimColor = opts.used ? dimColor(FACE_COLORS.restRim, 0.72) : FACE_COLORS.restRim;
    const rimLight = opts.used ? dimColor(FACE_COLORS.restRimLight, 0.72) : FACE_COLORS.restRimLight;
    const pipColor = opts.used ? dimColor(FACE_COLORS.pip, 0.70) : FACE_COLORS.pip;

    addRoundedRect(out, transform, scale(normal, half), normal, uAxis, vAxis, half, half, radius, rimLight);
    addRestingBevel(out, transform, normal, uAxis, vAxis, half, band, radius, rimColor);
    addRoundedRect(out, transform, scale(normal, half + 0.12), normal, uAxis, vAxis, innerHalf, innerHalf, innerRadius, faceColor);
    addRestingPips(out, transform, scale(normal, half + 0.34), normal, uAxis, vAxis, faces.top, innerHalf * 1.48, opts.pipRadius, pipColor);
  }

  function addRestingBevel(out, transform, normal, uAxis, vAxis, half, band, radius, color) {
    const topCenter = add(add(scale(normal, half + 0.06), scale(vAxis, half - band / 2)), [0, 0, 0]);
    const leftCenter = add(add(scale(normal, half + 0.06), scale(uAxis, -half + band / 2)), [0, 0, 0]);
    addPlaneQuad(out, transform, topCenter, normal, uAxis, vAxis, half - radius * 0.72, band / 2, color);
    addPlaneQuad(out, transform, leftCenter, normal, uAxis, vAxis, band / 2, half - radius * 0.72, color);
    addDisc(out, transform, add(add(scale(normal, half + 0.07), scale(uAxis, -half + radius)), scale(vAxis, half - radius)), normal, uAxis, vAxis, radius, color, 18);
  }

  function addRestingPips(out, transform, center, normal, uAxis, vAxis, value, spread, radius, color) {
    pipSpots(value).forEach(([u, v]) => {
      const x = (u - 0.5) * spread;
      const y = (v - 0.5) * spread;
      const pipCenter = add(add(center, scale(uAxis, x)), scale(vAxis, y));
      addDisc(out, transform, add(add(add(pipCenter, scale(normal, -0.04)), scale(uAxis, 0.42)), scale(vAxis, -0.42)), normal, uAxis, vAxis, radius * 1.06, FACE_COLORS.pipShadow, 24);
      addDisc(out, transform, add(pipCenter, scale(normal, 0.02)), normal, uAxis, vAxis, radius, color, 28);
      addDisc(out, transform, add(add(add(pipCenter, scale(normal, 0.04)), scale(uAxis, -radius * 0.18)), scale(vAxis, radius * 0.22)), normal, uAxis, vAxis, radius * 0.48, FACE_COLORS.pipHighlight, 18);
    });
  }

  function addFace(out, transform, def, value, opts) {
    const n = def.normal;
    const u = def.u;
    const v = def.v;
    const half = opts.half;
    const inner = half - opts.bevel;
    const center = scale(n, half);

    const full = faceCorners(center, u, v, half, half);
    const innerFace = faceCorners(add(center, scale(n, 0.10)), u, v, inner, inner);

    addQuad(out, transform, full, n, opts.rimColor);
    addQuad(out, transform, innerFace, n, opts.faceColor);
    addPips(out, transform, add(center, scale(n, 0.28)), n, u, v, value, inner * 1.52, opts.pipRadius, opts.pipColor);
  }

  function addShadow(out, body, width, height, diceSize) {
    const lift = Math.max(0, body.z || 0);
    const liftScale = Math.min(lift, 170) / 170;
    const centerX = body.x - width / 2;
    const centerY = height / 2 - (body.y + diceSize * 0.28);
    const rx = diceSize * (0.48 + liftScale * 0.34);
    const ry = diceSize * (0.19 + liftScale * 0.08);
    const alpha = Math.max(0.045, 0.20 - liftScale * 0.13) * (body.used ? 0.45 : 1);
    const color = [FACE_COLORS.shadow[0], FACE_COLORS.shadow[1], FACE_COLORS.shadow[2], alpha];
    const normal = [0, 0, 1];
    const center = [centerX, centerY, -18];
    const segments = 32;

    for (let i = 0; i < segments; i++) {
      const a = Math.PI * 2 * i / segments;
      const b = Math.PI * 2 * (i + 1) / segments;
      pushVertex(out, center, normal, color);
      pushVertex(out, [centerX + Math.cos(a) * rx, centerY + Math.sin(a) * ry, -18], normal, color);
      pushVertex(out, [centerX + Math.cos(b) * rx, centerY + Math.sin(b) * ry, -18], normal, color);
    }
  }

  function addPips(out, transform, center, normal, uAxis, vAxis, value, spread, radius, color) {
    const spots = pipSpots(value);
    const segments = 18;
    const worldNormal = transformedNormal(transform, normal);

    spots.forEach(([u, v]) => {
      const cx = (u - 0.5) * spread;
      const cy = (v - 0.5) * spread;
      const pipCenter = add(add(center, scale(uAxis, cx)), scale(vAxis, cy));

      for (let i = 0; i < segments; i++) {
        const a = Math.PI * 2 * i / segments;
        const b = Math.PI * 2 * (i + 1) / segments;
        const p1 = add(pipCenter, add(scale(uAxis, Math.cos(a) * radius), scale(vAxis, Math.sin(a) * radius)));
        const p2 = add(pipCenter, add(scale(uAxis, Math.cos(b) * radius), scale(vAxis, Math.sin(b) * radius)));
        pushVertex(out, transformPoint(transform, pipCenter), worldNormal, color);
        pushVertex(out, transformPoint(transform, p1), worldNormal, color);
        pushVertex(out, transformPoint(transform, p2), worldNormal, color);
      }
    });
  }

  function addQuad(out, transform, corners, normal, color) {
    const n = transformedNormal(transform, normal);
    const p = corners.map(point => transformPoint(transform, point));
    pushVertex(out, p[0], n, color);
    pushVertex(out, p[1], n, color);
    pushVertex(out, p[2], n, color);
    pushVertex(out, p[0], n, color);
    pushVertex(out, p[2], n, color);
    pushVertex(out, p[3], n, color);
  }

  function addPlaneQuad(out, transform, center, normal, uAxis, vAxis, uHalf, vHalf, color) {
    addQuad(out, transform, faceCorners(center, uAxis, vAxis, uHalf, vHalf), normal, color);
  }

  function addRoundedRect(out, transform, center, normal, uAxis, vAxis, uHalf, vHalf, radius, color) {
    const points = roundedRectPoints(center, uAxis, vAxis, uHalf, vHalf, radius, 8);
    addFan(out, transform, center, normal, points, color);
  }

  function addDisc(out, transform, center, normal, uAxis, vAxis, radius, color, segments) {
    const points = [];
    for (let i = 0; i < segments; i++) {
      const angle = Math.PI * 2 * i / segments;
      points.push(add(add(center, scale(uAxis, Math.cos(angle) * radius)), scale(vAxis, Math.sin(angle) * radius)));
    }
    addFan(out, transform, center, normal, points, color);
  }

  function addFan(out, transform, center, normal, points, color) {
    const n = transformedNormal(transform, normal);
    const c = transformPoint(transform, center);
    const p = points.map(point => transformPoint(transform, point));
    for (let i = 0; i < p.length; i++) {
      pushVertex(out, c, n, color);
      pushVertex(out, p[i], n, color);
      pushVertex(out, p[(i + 1) % p.length], n, color);
    }
  }

  function roundedRectPoints(center, uAxis, vAxis, uHalf, vHalf, radius, segments) {
    const r = Math.min(radius, uHalf, vHalf);
    const corners = [
      { cx: uHalf - r, cy: vHalf - r, start: 0, end: Math.PI / 2 },
      { cx: -uHalf + r, cy: vHalf - r, start: Math.PI / 2, end: Math.PI },
      { cx: -uHalf + r, cy: -vHalf + r, start: Math.PI, end: Math.PI * 1.5 },
      { cx: uHalf - r, cy: -vHalf + r, start: Math.PI * 1.5, end: Math.PI * 2 },
    ];
    const points = [];
    corners.forEach(corner => {
      for (let i = 0; i <= segments; i++) {
        const angle = corner.start + (corner.end - corner.start) * i / segments;
        points.push(add(
          add(center, scale(uAxis, corner.cx + Math.cos(angle) * r)),
          scale(vAxis, corner.cy + Math.sin(angle) * r)
        ));
      }
    });
    return points;
  }

  function faceCorners(center, uAxis, vAxis, uHalf, vHalf) {
    return [
      add(add(center, scale(uAxis, -uHalf)), scale(vAxis, -vHalf)),
      add(add(center, scale(uAxis, uHalf)), scale(vAxis, -vHalf)),
      add(add(center, scale(uAxis, uHalf)), scale(vAxis, vHalf)),
      add(add(center, scale(uAxis, -uHalf)), scale(vAxis, vHalf)),
    ];
  }

  function pushVertex(out, position, normal, color) {
    out.push(
      position[0], position[1], position[2],
      normal[0], normal[1], normal[2],
      color[0], color[1], color[2], color[3]
    );
  }

  function bodyTransform(body, width, height) {
    const lift = Math.max(0, body.z || 0);
    const resting = isResting(body);
    const screenY = body.y - lift * 0.57 - (resting ? 0 : 6);
    const yaw = body.rz || 0;
    const translate = [
      body.x - width / 2,
      height / 2 - screenY,
      lift * 0.36,
    ];
    return {
      translate,
      rx: resting ? 0 : degToRad(-30 + (body.rx || 0)),
      ry: resting ? 0 : degToRad(-24 + (body.ry || 0)),
      rz: degToRad(yaw),
    };
  }

  function isResting(body) {
    return !body.rolling && Math.max(0, body.z || 0) < 1;
  }

  function transformPoint(transform, point) {
    const rotated = rotatePoint(transform, point);
    return [
      rotated[0] + transform.translate[0],
      rotated[1] + transform.translate[1],
      rotated[2] + transform.translate[2],
    ];
  }

  function transformedNormal(transform, normal) {
    return normalize(rotatePoint(transform, normal));
  }

  function rotatePoint(transform, point) {
    let p = rotateX(point, transform.rx);
    p = rotateY(p, transform.ry);
    p = rotateZ(p, transform.rz);
    return p;
  }

  function rotateX(p, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
  }

  function rotateY(p, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
  }

  function rotateZ(p, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
  }

  function normalizedFaces(body) {
    const display = body.displayFaces || {};
    const top = clampFace(display.top || body.face || 1);
    let front = clampFace(display.front || 2);
    if (front === top || front === OPPOSITE[top]) {
      front = FACE_POOL.find(face => face !== top && face !== OPPOSITE[top]) || 2;
    }
    let right = clampFace(display.right || 3);
    if (right === top || right === OPPOSITE[top] || right === front || right === OPPOSITE[front]) {
      right = FACE_POOL.find(face =>
        face !== top &&
        face !== OPPOSITE[top] &&
        face !== front &&
        face !== OPPOSITE[front]
      ) || 3;
    }
    return { top, front, right };
  }

  function clampFace(face) {
    const value = Number(face);
    return value >= 1 && value <= 6 ? value : 1;
  }

  function faceColor(def, used) {
    const color = def.key === 'top' || def.key === 'bottom' ? FACE_COLORS.top : FACE_COLORS.side;
    return used ? dimColor(color, 0.70) : color;
  }

  function rimColor(def, used) {
    const color = def.key === 'top' || def.key === 'right' ? FACE_COLORS.rim : FACE_COLORS.rimLight;
    return used ? dimColor(color, 0.72) : color;
  }

  function dimColor(color, amount) {
    return [
      color[0] * amount,
      color[1] * amount,
      color[2] * amount,
      color[3],
    ];
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

  function perspectiveBoardMatrix(width, height) {
    const fov = degToRad(38);
    const aspect = width / height;
    const distance = height / (2 * Math.tan(fov / 2));
    return multiplyMat4(
      perspectiveMat4(fov, aspect, 1, distance + 1400),
      translateMat4(0, 0, -distance)
    );
  }

  function perspectiveMat4(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  }

  function translateMat4(x, y, z) {
    return new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      x, y, z, 1,
    ]);
  }

  function multiplyMat4(a, b) {
    const out = new Float32Array(16);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        out[col * 4 + row] =
          a[0 * 4 + row] * b[col * 4 + 0] +
          a[1 * 4 + row] * b[col * 4 + 1] +
          a[2 * 4 + row] * b[col * 4 + 2] +
          a[3 * 4 + row] * b[col * 4 + 3];
      }
    }
    return out;
  }

  function add(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }

  function scale(a, value) {
    return [a[0] * value, a[1] * value, a[2] * value];
  }

  function normalize(a) {
    const len = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / len, a[1] / len, a[2] / len];
  }

  function degToRad(value) {
    return value * Math.PI / 180;
  }

  return {
    clearDiceScene,
    renderDiceScene,
    version: 'webgl-v1',
  };
})();
