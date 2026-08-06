/* ------------------------------------------------------------------
   dice-webgl.js - WebGL dice renderer for board dice.
   Dice motion is provided by dice-engine.js; this file renders volume.

   A die is a real cube with a fixed pip layout (opposite faces sum to 7).
   What you see on a face is decided purely by the body's 3D orientation
   (body.q quaternion while rolling, or body.face when it has settled) - never
   by random per-frame face swaps. Faces are lit with diffuse + specular so the
   cube reads as a solid object instead of a flat token.
   ------------------------------------------------------------------ */

window.NarduDiceWebGL = (function () {
  const renderers = new WeakMap();

  /* Cube face geometry. `pos` keys which slot the face occupies; the pip value in
     that slot is assigned per die so the rolled value always lands on +Z (top).
     Every die rests in the SAME orientation, so they all sit at one angle and
     catch the light identically - only the numbers differ. */
  const CUBE_FACES = [
    { pos: 'pz', n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { pos: 'nz', n: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0] },
    { pos: 'px', n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { pos: 'nx', n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { pos: 'py', n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { pos: 'ny', n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ];

  const IDENTITY_Q = [0, 0, 0, 1];
  const IDENTITY_MAT3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  // Assign the six pip values for a die whose top face must read `top`. Top/bottom
  // and both side pairs sum to 7, so it is always a valid die.
  function dieFaceValues(top) {
    const t = clampFace(top);
    const bottom = 7 - t;
    const rest = [1, 2, 3, 4, 5, 6].filter(v => v !== t && v !== bottom);
    const a = rest[0];
    const b = rest.find(v => v !== a && v !== 7 - a);
    return { pz: t, nz: bottom, px: a, nx: 7 - a, py: b, ny: 7 - b };
  }

  const COLORS = {
    edge: [0.78, 0.75, 0.69, 1],     // darker ivory for the cube body / bevel
    face: [0.95, 0.93, 0.88, 1],     // bright ivory face inset
    pip: [0.10, 0.10, 0.12, 1],      // engraved dark pips
    pipRim: [0.62, 0.60, 0.56, 0.55],// subtle light catch on the pip lip
    shadow: [0.02, 0.02, 0.03, 1],   // soft neutral contact shadow
  };

  // A gentle, consistent camera tilt so every die shows its top plus a sliver of
  // its front/right faces - the 3/4 view that makes a die read as a cube.
  const VIEW_TILT = mat3Multiply(rotationMat3X(degToRad(-14)), rotationMat3Y(degToRad(-5)));

  const VERTEX_SHADER = `
    attribute vec3 a_position;
    attribute vec3 a_normal;
    attribute vec4 a_color;

    uniform mat4 u_matrix;
    uniform vec3 u_light;
    uniform vec3 u_view;

    varying vec4 v_color;
    varying float v_shade;

    void main() {
      vec3 N = normalize(a_normal);
      vec3 L = normalize(u_light);
      vec3 V = normalize(u_view);
      vec3 H = normalize(L + V);
      float diffuse = max(dot(N, L), 0.0);
      float spec = pow(max(dot(N, H), 0.0), 26.0);
      float ambient = 0.50 + 0.12 * max(dot(N, vec3(0.0, 0.0, 1.0)), 0.0);
      v_shade = ambient + diffuse * 0.52 + spec * 0.42;
      v_color = a_color;
      gl_Position = u_matrix * vec4(a_position, 1.0);
    }
  `;

  const FRAGMENT_SHADER = `
    precision mediump float;
    varying vec4 v_color;
    varying float v_shade;
    void main() {
      gl_FragColor = vec4(v_color.rgb * v_shade, v_color.a);
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
        view: gl.getUniformLocation(program, 'u_view'),
      };
    }

    render(bodies, opts = {}) {
      const gl = this.gl;
      // A lost GPU context (mobile backgrounding, memory pressure, driver reset)
      // turns every GL call into a no-op/error. Bail so the caller can fall back
      // and so we never paint into a dead context; recovery happens on restore.
      if (gl.isContextLost && gl.isContextLost()) return;
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

      // Orthographic, not perspective: a perspective frustum makes a die that
      // sits off-centre appear tilted (it is viewed at an oblique angle), so two
      // dice in different spots looked like they were at different angles. With
      // an orthographic camera every die shows the identical VIEW_TILT pose
      // wherever it lands on the board.
      const matrix = orthoBoardMatrix(rect.width, rect.height);
      const scene = buildScene(bodies, rect.width, rect.height, opts.diceSize || 40);

      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.locations.matrix, false, matrix);
      gl.uniform3f(this.locations.light, -0.42, -0.52, 0.80);
      gl.uniform3f(this.locations.view, 0, 0, 1);
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
    const cached = renderers.get(canvas);
    if (cached && !(cached.gl.isContextLost && cached.gl.isContextLost())) return cached;
    if (cached) renderers.delete(canvas);

    const attribs = {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    };
    const gl = canvas.getContext('webgl', attribs) || canvas.getContext('experimental-webgl', attribs);
    if (!gl) return null;

    const program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    if (!program) return null;

    // WebGL contexts are routinely dropped on mobile (tab backgrounded, GPU reset,
    // memory pressure). Without this the cached dead renderer keeps getting reused
    // and the dice canvas stays blank for the rest of the session. Drop the cached
    // renderer on loss (preventDefault keeps the context recoverable) and force a
    // board redraw on restore so the dice reappear immediately.
    if (!canvas.__diceContextHandlers) {
      canvas.__diceContextHandlers = true;
      canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        renderers.delete(canvas);
      }, false);
      canvas.addEventListener('webglcontextrestored', () => {
        renderers.delete(canvas);
        window.NarduController?.render?.();
      }, false);
    }

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

  /* ── scene assembly ─────────────────────────────────────────────── */

  function buildScene(bodies, width, height, diceSize) {
    const shadows = [];
    const dice = [];

    bodies.forEach(body => addShadow(shadows, body, width, height, diceSize));
    bodies
      .slice()
      .sort((a, b) => (a.y + (a.z || 0) * 0.2) - (b.y + (b.z || 0) * 0.2))
      .forEach(body => addDie(dice, body, width, height, diceSize));

    return {
      shadows: { data: shadows, count: shadows.length / 10 },
      dice: { data: dice, count: dice.length / 10 },
    };
  }

  function addDie(out, body, width, height, diceSize) {
    const transform = bodyTransform(body, width, height);
    const used = Boolean(body.used);
    const half = diceSize / 2;
    const corner = Math.min(half * 0.42, Math.max(4.5, diceSize * 0.16));
    const bevel = Math.max(2.6, diceSize * 0.085);
    const pipRadius = Math.max(2.4, diceSize * 0.082);
    const faceColor = used ? dim(COLORS.face, 0.74) : COLORS.face;
    const edgeColor = used ? dim(COLORS.edge, 0.74) : COLORS.edge;
    const pipColor = used ? dim(COLORS.pip, 1.35) : COLORS.pip;
    const values = dieFaceValues(body.face || 1);

    CUBE_FACES.forEach(face => {
      const worldNormal = applyMat3(transform.rot, face.n);
      // Only draw faces that point toward the viewer (with a small bias so the
      // silhouette edges fill in). Depth testing sorts the rest.
      if (worldNormal[2] < -0.04) return;

      const center = scale(face.n, half);
      const inset = half - bevel;

      // Cube body (full rounded square in the darker ivory) gives the bevel.
      addRoundedRect(out, transform, center, face.n, face.u, face.v, half, half, corner, edgeColor);
      // Bright face inset, nudged out along the normal to avoid z-fighting.
      addRoundedRect(out, transform, add(center, scale(face.n, 0.6)), face.n, face.u, face.v, inset, inset, corner * 0.7, faceColor);
      // Pips for whichever value sits in this face slot.
      addPips(out, transform, add(center, scale(face.n, 1.1)), face.n, face.u, face.v, values[face.pos], inset * 1.46, pipRadius, pipColor);
    });
  }

  function addShadow(out, body, width, height, diceSize) {
    const lift = Math.max(0, body.z || 0);
    const liftScale = Math.min(lift, 170) / 170;
    const centerX = body.x - width / 2;
    const centerY = height / 2 - (body.y + diceSize * 0.30);
    const baseRx = diceSize * (0.50 + liftScale * 0.40);
    const baseRy = diceSize * (0.20 + liftScale * 0.10);
    const baseAlpha = Math.max(0.05, 0.26 - liftScale * 0.16) * (body.used ? 0.5 : 1);
    const normal = [0, 0, 1];

    // Two stacked ellipses (a soft core + a wider faint halo) read as a blurred
    // contact shadow instead of a hard brown disc.
    addShadowEllipse(out, centerX, centerY, baseRx * 1.25, baseRy * 1.25, baseAlpha * 0.45, normal);
    addShadowEllipse(out, centerX, centerY, baseRx, baseRy, baseAlpha, normal);
  }

  function addShadowEllipse(out, cx, cy, rx, ry, alpha, normal) {
    const color = [COLORS.shadow[0], COLORS.shadow[1], COLORS.shadow[2], alpha];
    const center = [cx, cy, -18];
    const segments = 30;
    for (let i = 0; i < segments; i++) {
      const a = Math.PI * 2 * i / segments;
      const b = Math.PI * 2 * (i + 1) / segments;
      pushVertex(out, center, normal, color);
      pushVertex(out, [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, -18], normal, color);
      pushVertex(out, [cx + Math.cos(b) * rx, cy + Math.sin(b) * ry, -18], normal, color);
    }
  }

  function addPips(out, transform, center, normal, uAxis, vAxis, value, spread, radius, color) {
    pipSpots(value).forEach(([u, v]) => {
      const cx = (u - 0.5) * spread;
      const cy = (v - 0.5) * spread;
      const pipCenter = add(add(center, scale(uAxis, cx)), scale(vAxis, cy));
      // faint light rim under the pip, then the dark pip on top
      addDisc(out, transform, add(pipCenter, scale(normal, -0.05)), normal, uAxis, vAxis, radius * 1.16, COLORS.pipRim, 20);
      addDisc(out, transform, pipCenter, normal, uAxis, vAxis, radius, color, 22);
    });
  }

  /* ── geometry helpers ───────────────────────────────────────────── */

  function addRoundedRect(out, transform, center, normal, uAxis, vAxis, uHalf, vHalf, radius, color) {
    const points = roundedRectPoints(center, uAxis, vAxis, uHalf, vHalf, radius, 6);
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

  function pushVertex(out, position, normal, color) {
    out.push(
      position[0], position[1], position[2],
      normal[0], normal[1], normal[2],
      color[0], color[1], color[2], color[3]
    );
  }

  /* ── per-body transform (position + orientation) ────────────────── */

  function bodyTransform(body, width, height) {
    const lift = Math.max(0, body.z || 0);
    const screenY = body.y - lift * 0.57;
    const translate = [
      body.x - width / 2,
      height / 2 - screenY,
      lift * 0.36,
    ];
    return { translate, rot: mat3Multiply(VIEW_TILT, orientationMatrix(body)) };
  }

  // Orientation of the cube in its own space, before the shared camera tilt.
  // Every die settles to ONE shared orientation (identity); the rolled value is
  // painted onto the top slot by dieFaceValues, so all resting dice sit at the
  // exact same angle. While tumbling we follow the spin; in the last stretch of
  // the roll (body.settle 0->1) we slerp the frozen tumble pose to that shared
  // resting pose, so the die rotates to a stop with no snap and no pop.
  function orientationMatrix(body) {
    if (body.q) return quatToMat3(body.q);
    if (body.rolling) {
      const qTumble = eulerToQuat(degToRad(body.rx || 0), degToRad(body.ry || 0), degToRad(body.rz || 0));
      const settle = body.settle || 0;
      if (settle > 0) {
        return quatToMat3(quatSlerp(qTumble, IDENTITY_Q, easeInOut(settle)));
      }
      return quatToMat3(qTumble);
    }
    return IDENTITY_MAT3;
  }

  function easeInOut(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
  }

  function transformPoint(transform, point) {
    const r = applyMat3(transform.rot, point);
    return [r[0] + transform.translate[0], r[1] + transform.translate[1], r[2] + transform.translate[2]];
  }

  function transformedNormal(transform, normal) {
    return normalize(applyMat3(transform.rot, normal));
  }

  /* ── face / pip data ────────────────────────────────────────────── */

  function clampFace(face) {
    const value = Number(face);
    return value >= 1 && value <= 6 ? Math.round(value) : 1;
  }

  function dim(color, amount) {
    return [
      Math.min(1, color[0] * amount),
      Math.min(1, color[1] * amount),
      Math.min(1, color[2] * amount),
      color[3],
    ];
  }

  function pipSpots(face) {
    const low = 0.22;
    const mid = 0.5;
    const high = 0.78;
    const map = {
      1: [[mid, mid]],
      2: [[low, low], [high, high]],
      3: [[low, low], [mid, mid], [high, high]],
      4: [[low, low], [high, low], [low, high], [high, high]],
      5: [[low, low], [high, low], [mid, mid], [low, high], [high, high]],
      6: [[low, low], [high, low], [low, mid], [high, mid], [low, high], [high, high]],
    };
    return map[clampFace(face)] || map[1];
  }

  /* ── quaternion / matrix math ───────────────────────────────────── */

  function quatAxisAngle(axis, angle) {
    const a = normalize(axis);
    const s = Math.sin(angle / 2);
    return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
  }

  function quatMultiply(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  }

  function quatNormalize(q) {
    const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
  }

  function quatToMat3(q) {
    const [x, y, z, w] = quatNormalize(q);
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    // column-major 3x3 stored as [m00,m10,m20, m01,m11,m21, m02,m12,m22]
    return [
      1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy),
      2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx),
      2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy),
    ];
  }

  function eulerToMat3(rx, ry, rz) {
    return mat3Multiply(rotationMat3Z(rz), mat3Multiply(rotationMat3Y(ry), rotationMat3X(rx)));
  }

  // Same Z*Y*X order as eulerToMat3, expressed as a quaternion.
  function eulerToQuat(rx, ry, rz) {
    const qx = quatAxisAngle([1, 0, 0], rx);
    const qy = quatAxisAngle([0, 1, 0], ry);
    const qz = quatAxisAngle([0, 0, 1], rz);
    return quatMultiply(qz, quatMultiply(qy, qx));
  }

  function quatSlerp(a, b, t) {
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
    if (dot > 0.9995) {
      return quatNormalize([
        a[0] + (bx - a[0]) * t,
        a[1] + (by - a[1]) * t,
        a[2] + (bz - a[2]) * t,
        a[3] + (bw - a[3]) * t,
      ]);
    }
    const theta0 = Math.acos(Math.min(1, dot));
    const theta = theta0 * t;
    const sin0 = Math.sin(theta0);
    const s0 = Math.sin(theta0 - theta) / sin0;
    const s1 = Math.sin(theta) / sin0;
    return [
      a[0] * s0 + bx * s1,
      a[1] * s0 + by * s1,
      a[2] * s0 + bz * s1,
      a[3] * s0 + bw * s1,
    ];
  }

  function rotationMat3X(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, c, s, 0, -s, c];
  }

  function rotationMat3Y(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, 0, -s, 0, 1, 0, s, 0, c];
  }

  function rotationMat3Z(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, s, 0, -s, c, 0, 0, 0, 1];
  }

  function mat3Multiply(a, b) {
    const out = new Array(9);
    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 3; row++) {
        out[col * 3 + row] =
          a[0 * 3 + row] * b[col * 3 + 0] +
          a[1 * 3 + row] * b[col * 3 + 1] +
          a[2 * 3 + row] * b[col * 3 + 2];
      }
    }
    return out;
  }

  function applyMat3(m, p) {
    return [
      m[0] * p[0] + m[3] * p[1] + m[6] * p[2],
      m[1] * p[0] + m[4] * p[1] + m[7] * p[2],
      m[2] * p[0] + m[5] * p[1] + m[8] * p[2],
    ];
  }

  /* ── small vector helpers ───────────────────────────────────────── */

  function add(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }

  function scale(a, value) {
    return [a[0] * value, a[1] * value, a[2] * value];
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  function lengthOf(a) {
    return Math.hypot(a[0], a[1], a[2]);
  }

  function normalize(a) {
    const len = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / len, a[1] / len, a[2] / len];
  }

  function degToRad(value) {
    return value * Math.PI / 180;
  }

  /* ── projection ─────────────────────────────────────────────────── */

  function orthoBoardMatrix(width, height) {
    const r = width / 2;
    const t = height / 2;
    const n = -2000;
    const f = 2000;
    return new Float32Array([
      1 / r, 0, 0, 0,
      0, 1 / t, 0, 0,
      0, 0, -2 / (f - n), 0,
      0, 0, -(f + n) / (f - n), 1,
    ]);
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

  return {
    clearDiceScene,
    renderDiceScene,
    version: 'webgl-v3',
  };
})();
