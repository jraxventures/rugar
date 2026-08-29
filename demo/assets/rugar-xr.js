/**
 * RugAR — custom WebXR AR session with a locked floor.
 *
 * WHY THIS EXISTS. Device testing on a Galaxy S22 Ultra (a 2022 flagship — ARCore certified,
 * Depth API capable, and with NO LiDAR/ToF, which no Galaxy S has) showed three failures:
 *
 *   1. The rug never locks to the floor.
 *   2. Squat down, stand slowly, and the rug LIFTS off the floor.
 *   3. It latched onto a flat moulding ledge running along a pillar.
 *
 * Scene Viewer — Google's own app, with ARCore's best tuning — reproduces (1) and (2). That is
 * decisive: no Android path we can reach exposes a floor lock, so the session has to be ours.
 *
 * Each failure has a distinct cause, and each drives a specific decision here:
 *
 * (2) is the most diagnostic. The rug was not drifting relative to its plane — the PLANE'S OWN
 *     POSE was being revised. Squatting changes the viewing angle and parallax on the floor
 *     dramatically; as you rise, ARCore refines its plane-height estimate and everything
 *     anchored to that plane trackable moves with it. So an XRAnchor is NOT sufficient: an
 *     anchor attached to a plane inherits the plane's revisions. We capture the pose ONCE into
 *     the `local` reference space and never consult the plane again. VIO drift over a few
 *     seconds is centimetres; plane re-estimation error is 10-30cm.
 *
 * (3) shows floor selection had no area gate — it took whatever plane the reticle ray hit. A
 *     moulding is horizontal, tiny, and not even the lowest thing in the room, which rules out
 *     "lowest wins" as the fix. AREA is the discriminator: a moulding is ~0.1m2, a sill ~0.2,
 *     a chair seat ~0.4, a sofa ~1.2 — a living-room floor is 8-20m2. Nothing else is close.
 *
 * (1) follows from both: pick correctly, freeze, and never re-assess unless asked.
 *
 * NOT IN THIS VERSION: depth occlusion. It needs a GPU depth-texture shader that cannot be
 * validated without the device, and a wrong one makes the rug vanish entirely. Scene Viewer
 * mode already has occlusion (see the disable_occlusion fix); this mode trades it for the lock
 * until the lock itself is confirmed on hardware.
 */
(function () {
  'use strict';

  // A moulding is ~0.1m2 and a sofa ~1.2m2; a floor is 8-20m2. 1.5 sits above every piece of
  // furniture in a room and far below any real floor.
  var MIN_FLOOR_AREA = 1.5;
  // Two candidates this close in area are treated as the same surface (a floor split into
  // patches) — and then, and only then, the LOWER one wins.
  var TIE_AREA_RATIO = 0.9;
  // A floor is this far below a held phone. Rules out ceilings and waist-height surfaces.
  var CAM_MIN_DROP = 0.6, CAM_MAX_DROP = 2.2;
  // Fallback mode (no plane-detection): how long the hit-test height must hold steady.
  var DWELL_MS = 1800, DWELL_SPREAD = 0.04;

  // STABILITY GATE. Area alone is not enough: a plane can cross 1.5m2 while its height is
  // still being estimated, and placing then is what produces a rug that later "lifts". The
  // chosen plane's height must also hold within STABLE_SPREAD for STABLE_MS before it can be
  // placed on.
  var STABLE_MS = 1000, STABLE_SPREAD = 0.02;

  // CORRECTION POLICY (replaces a hard freeze). A hard freeze is immune to bad plane revisions
  // but also throws away the good ones — ARCore genuinely improves its floor estimate as it
  // gathers parallax, and refusing that means an early mistake is permanent. So:
  //   |dy| < DEADBAND      -> ignore (sensor noise)
  //   DEADBAND..JUMP_MAX   -> slew toward it at SLEW_RATE (real refinement, invisible)
  //   >= JUMP_MAX          -> reject outright (the squat/stand artefact)
  var DEADBAND = 0.01, JUMP_MAX = 0.08, SLEW_RATE = 0.02;
  // A jump is transient. SUSTAINED disagreement is not an artefact — it is ARCore having
  // genuinely re-estimated the floor, and refusing it forever strands the rug at a stale
  // height. Device data showed 110 rejections against 64 corrections: the rug had stopped
  // tracking the floor entirely. After this long in continuous disagreement, accept.
  var RELOCK_MS = 2500;
  // Slack between the rug and the floor it lies on, so the floor cannot occlude the rug.
  var OCCL_BIAS = 0.05;
  // On merge, ARCore replaces a plane object; re-acquire only a floor this close to ours.
  var REACQUIRE_TOL = 0.10;

  // Once a correction starts it runs to within a millimetre; the deadband only decides
  // whether to START one.
  var SETTLED = 0.001;

  /**
   * Pure form of the correction policy, so it can be reasoned about and tested outside a live
   * AR session. Returns the new height, the branch taken, and whether a correction is in
   * progress — the caller must carry that state back in.
   *
   * The deadband is HYSTERESIS, not a stop condition. Treating it as a stop condition (the
   * first version of this) left a permanent offset the size of the deadband: the rug would
   * converge to within 1cm of the floor and sit there, visibly floating. The threshold now
   * governs entry only; once entered, the slew runs to convergence.
   */
  function correct(currentY, targetY, dt, correcting) {
    var dy = targetY - currentY, ady = Math.abs(dy);
    if (ady >= JUMP_MAX) return { y: currentY, branch: 'rejected', correcting: false };
    if (!correcting && ady < DEADBAND) return { y: currentY, branch: 'noise', correcting: false };
    if (ady < SETTLED) return { y: targetY, branch: 'settled', correcting: false };
    var step = SLEW_RATE * dt;
    return {
      y: currentY + (dy > 0 ? Math.min(step, dy) : Math.max(-step, dy)),
      branch: 'slew', correcting: true
    };
  }

  // ---------------------------------------------------------------- matrices

  function m4mul(a, b, o) {
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                       a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  /**
   * Model matrix built from the FLOOR'S OWN NORMAL rather than an assumed world up.
   *
   * A translation + Y-rotation matrix cannot tilt anything — so when the rug still landed
   * diagonal on device, the bug could only be in the assumption underneath it: that the
   * reference space's +Y is gravity. The WebXR spec does not guarantee that for `local`; its
   * orientation is platform-defined. Deriving the basis from the detected plane's normal makes
   * the rug coplanar with the floor by construction, whatever the reference space is doing.
   *
   * Columns are [X, up, Z, position]; Z = X x up keeps it right-handed, matching the
   * translation+Y-rotation form this replaced.
   */
  function basisModel(up, ry, px, py, pz, o) {
    var l = Math.hypot(up[0], up[1], up[2]) || 1;
    var Yx = up[0] / l, Yy = up[1] / l, Yz = up[2] / l;
    // Any reference not parallel to the normal; swapped near the degenerate case.
    var rx = 0, rz = 1;
    if (Math.abs(Yz) >= 0.9) { rx = 1; rz = 0; }
    var Xx = Yy * rz - Yz * 0, Xy = Yz * rx - Yx * rz, Xz = Yx * 0 - Yy * rx;
    var xl = Math.hypot(Xx, Xy, Xz) || 1; Xx /= xl; Xy /= xl; Xz /= xl;
    var Zx = Xy * Yz - Xz * Yy, Zy = Xz * Yx - Xx * Yz, Zz = Xx * Yy - Xy * Yx;
    var c = Math.cos(ry), s = Math.sin(ry);
    o[0] = Xx * c - Zx * s; o[1] = Xy * c - Zy * s; o[2] = Xz * c - Zz * s; o[3] = 0;
    o[4] = Yx;              o[5] = Yy;              o[6] = Yz;              o[7] = 0;
    o[8] = Xx * s + Zx * c; o[9] = Xy * s + Zy * c; o[10] = Xz * s + Zz * c; o[11] = 0;
    o[12] = px; o[13] = py; o[14] = pz; o[15] = 1;
    return o;
  }

  /** Angle between a normal and the reference space's +Y, in degrees. Surfaced on screen: if
   *  the two disagree, that is the tilt, and it is now visible instead of guessed at. */
  function tiltDeg(up) {
    var l = Math.hypot(up[0], up[1], up[2]) || 1;
    return Math.acos(Math.max(-1, Math.min(1, up[1] / l))) * 180 / Math.PI;
  }

  // ---------------------------------------------------------------- gl

  var VERT =
    'attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv;' +
    'uniform mat4 uProj, uView, uModel;' +
    'varying vec2 vUv; varying vec3 vNrm; varying vec4 vClip; varying float vViewZ;' +
    'void main(){ vUv = aUv; vNrm = aNrm;' +
    ' vec4 vp = uView * uModel * vec4(aPos, 1.0);' +
    ' vViewZ = -vp.z;' +                       // distance along the view axis, metres
    ' vClip = uProj * vp;' +
    ' gl_Position = vClip; }';

  // The face normal is (0,1,0) and Y-rotation leaves it unchanged, so normals need no
  // transform — the only rotated normals are the edge strip, which is 6mm tall.
  /**
   * OCCLUSION BY FLOOR MASK.
   *
   * The rug is coplanar with the floor, so "is this pixel floor?" and "is anything nearer to
   * the camera than the rug here?" are the SAME question. That is why a depth comparison gives
   * the floor mask a semantic segmenter would produce — without shipping a model, and it is
   * why this trick works for a rug and would not for a lamp.
   *
   * Depth arrives packed 16-bit across the luminance and alpha channels; the canonical decode
   * is dot(texel.ra, vec2(255.0, 65280.0)) scaled by rawValueToMeters.
   *
   * uOcclBias exists because the floor itself sits at almost exactly the rug's depth — without
   * a few centimetres of slack the rug would occlude against the very surface it lies on and
   * flicker away entirely.
   */
  var FRAG =
    'precision mediump float;' +
    'uniform sampler2D uTex; uniform float uIsFace; uniform float uAlpha;' +
    'uniform sampler2D uDepth; uniform float uUseDepth; uniform mat4 uDepthUv;' +
    'uniform float uRawToM; uniform float uOcclBias; uniform float uDebug;' +
    'varying vec2 vUv; varying vec3 vNrm; varying vec4 vClip; varying float vViewZ;' +
    'void main(){' +
    ' float occluded = 0.0; float sceneM = 0.0;' +
    ' if (uUseDepth > 0.5) {' +
    '   vec2 sUv = (vClip.xy / vClip.w) * 0.5 + 0.5;' +
    '   vec2 dUv = (uDepthUv * vec4(sUv, 0.0, 1.0)).xy;' +
    '   if (dUv.x >= 0.0 && dUv.x <= 1.0 && dUv.y >= 0.0 && dUv.y <= 1.0) {' +
    '     sceneM = dot(texture2D(uDepth, dUv).ra, vec2(255.0, 65280.0)) * uRawToM;' +
    '     if (sceneM > 0.05 && sceneM < vViewZ - uOcclBias) occluded = 1.0;' +
    '   }' +
    ' }' +
    ' if (uDebug > 0.5) {' +                    // mask made visible, so a bad decode is obvious
    '   gl_FragColor = vec4(occluded, 1.0 - occluded, min(sceneM * 0.2, 1.0), 0.75); return;' +
    ' }' +
    ' if (occluded > 0.5) discard;' +
    ' vec3 c = mix(vec3(0.16,0.15,0.14), texture2D(uTex, vUv).rgb, uIsFace);' +
    ' float l = 0.58 + 0.42 * max(dot(normalize(vNrm), normalize(vec3(0.35,1.0,0.25))), 0.0);' +
    ' gl_FragColor = vec4(c * l, uAlpha); }';

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function program(gl) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function buffer(gl, target, data) {
    var b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  }

  function uploadPart(gl, part, hasUv) {
    return {
      pos: buffer(gl, gl.ARRAY_BUFFER, part.p),
      nrm: buffer(gl, gl.ARRAY_BUFFER, part.n),
      uv: hasUv ? buffer(gl, gl.ARRAY_BUFFER, part.u) : null,
      idx: buffer(gl, gl.ELEMENT_ARRAY_BUFFER, part.i),
      count: part.i.length
    };
  }

  // ---------------------------------------------------------------- floor selection

  /** Shoelace area of an XRPlane polygon. Points are in plane space, so x/z is the footprint. */
  function polygonArea(poly) {
    if (!poly || poly.length < 3) return 0;
    var a = 0;
    for (var i = 0, n = poly.length; i < n; i++) {
      var p = poly[i], q = poly[(i + 1) % n];
      a += p.x * q.z - q.x * p.z;
    }
    return Math.abs(a) / 2;
  }

  /**
   * Rank detected planes and return the floor, or null.
   *
   * Order matters: the AREA GATE comes first and does most of the work — it removes the pillar
   * moulding, window sills, chair seats and coffee tables in one step. Height is only ever a
   * tie-break between two surfaces already agreed to be the same size, which is the "floor
   * detected as two patches" case.
   */
  function pickFloor(frame, refSpace, camY) {
    if (!frame.detectedPlanes) return null;
    var cands = [];
    frame.detectedPlanes.forEach(function (plane) {
      if (plane.orientation !== 'horizontal') return;
      var pose = frame.getPose(plane.planeSpace, refSpace);
      if (!pose) return;
      var y = pose.transform.position.y;
      var drop = camY - y;
      if (drop < CAM_MIN_DROP || drop > CAM_MAX_DROP) return;
      var area = polygonArea(plane.polygon);
      if (area < MIN_FLOOR_AREA) return;
      // Column 1 of the pose matrix is the plane's up vector. Copied, because the pose is
      // only valid for this frame. Guarded: this runs inside the render loop, so a throw here
      // would take down the whole session rather than degrade one frame.
      var m = pose.transform && pose.transform.matrix;
      var up = (m && m.length >= 7) ? [m[4], m[5], m[6]] : [0, 1, 0];
      cands.push({ y: y, area: area, up: up, plane: plane });
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return b.area - a.area; });
    var maxArea = cands[0].area, best = cands[0];
    for (var i = 1; i < cands.length; i++) {
      if (cands[i].area >= maxArea * TIE_AREA_RATIO && cands[i].y < best.y) best = cands[i];
    }
    best.total = cands.reduce(function (s, c) { return s + c.area; }, 0);
    return best;
  }

  /**
   * Fallback when plane-detection is unavailable: require the hit-test height to hold steady
   * for DWELL_MS. Takes the LOWER QUARTILE of samples rather than the mean — hit-test noise
   * on a floor skews upward (it catches rug pile, cables, feet), never downward.
   */
  function makeDwell() {
    var samples = [];
    return function (frame, hitSource, refSpace, camY) {
      var hits = frame.getHitTestResults(hitSource);
      if (!hits.length) return null;
      var p = hits[0].getPose(refSpace);
      if (!p) return null;
      var y = p.transform.position.y, drop = camY - y;
      if (drop < CAM_MIN_DROP || drop > CAM_MAX_DROP) return null;
      var now = performance.now();
      samples.push({ t: now, y: y });
      while (samples.length && now - samples[0].t > DWELL_MS) samples.shift();
      if (samples.length < 15 || now - samples[0].t < DWELL_MS * 0.8) return null;
      var ys = samples.map(function (s) { return s.y; }).sort(function (a, b) { return a - b; });
      if (ys[ys.length - 1] - ys[0] > DWELL_SPREAD) return null;
      // No plane means no measured normal; fall back to the reference space's up and say so.
      return { y: ys[Math.floor(ys.length * 0.25)], area: 0, total: 0, fallback: true,
               up: [0, 1, 0] };
    };
  }

  // ---------------------------------------------------------------- overlay

  var CSS =
    '.rugarxr{position:fixed;inset:auto 0 0 0;z-index:2147483600;font:15px/1.45 -apple-system,' +
    'BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;padding:16px 16px ' +
    'calc(16px + env(safe-area-inset-bottom));background:linear-gradient(transparent,rgba(0,0,0,.72) 34%);' +
    'display:flex;flex-direction:column;gap:10px;align-items:center;text-align:center}' +
    '.rugarxr p{margin:0;text-shadow:0 1px 6px rgba(0,0,0,.8);max-width:30ch}' +
    '.rugarxr .sub{font-size:12.5px;opacity:.78;font-variant-numeric:tabular-nums}' +
    '.rugarxr .row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}' +
    '.rugarxr button{border:0;border-radius:999px;padding:13px 24px;font:inherit;font-weight:600;' +
    'cursor:pointer;background:#fff;color:#14264a}' +
    '.rugarxr button.rot{padding:13px 18px;font-size:19px;line-height:1}' +
    '.rugarxr button.ghost{background:rgba(255,255,255,.16);color:#fff;' +
    'box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.5)}' +
    '.rugarxr button:disabled{opacity:.45}';

  function buildOverlay() {
    if (!document.getElementById('rugarxr-css')) {
      var st = document.createElement('style');
      st.id = 'rugarxr-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var root = document.createElement('div');
    root.className = 'rugarxr';
    root.innerHTML =
      '<p class="msg"></p><p class="sub"></p>' +
      '<div class="row">' +
        '<button class="rot ghost" data-d="-1" aria-label="Rotate left">&#8634;</button>' +
        '<button class="place" disabled>Place rug</button>' +
        '<button class="rot ghost" data-d="1" aria-label="Rotate right">&#8635;</button>' +
        '<button class="rescan ghost" hidden>Re-scan floor</button>' +
        '<button class="occl ghost">Occlusion: on</button>' +
        '<button class="mask ghost">Mask</button>' +
        '<button class="exit ghost">Done</button>' +
      '</div>';
    document.body.appendChild(root);
    return root;
  }

  // ---------------------------------------------------------------- session

  function supported() {
    if (!navigator.xr || !navigator.xr.isSessionSupported) return Promise.resolve(false);
    return navigator.xr.isSessionSupported('immersive-ar').catch(function () { return false; });
  }

  function start(opts) {
    var overlay = buildOverlay();
    var els = {
      msg: overlay.querySelector('.msg'), sub: overlay.querySelector('.sub'),
      place: overlay.querySelector('.place'), rescan: overlay.querySelector('.rescan'),
      exit: overlay.querySelector('.exit'), rot: overlay.querySelectorAll('.rot'),
      occl: overlay.querySelector('.occl'), mask: overlay.querySelector('.mask')
    };

    // hit-test is REQUIRED, not optional. model-viewer asks for it optionally, so a session can
    // start without it and quietly fall back to placing at a fixed distance in front of the
    // camera — which IS mid-air, by construction. Better to fail with an explanation.
    var withDepth = {
      requiredFeatures: ['hit-test'],
      // 'local-floor' MUST appear here to be grantable — requestReferenceSpace('local-floor')
      // rejects outright if the feature was never requested. It was missing, which is why the
      // A17 diagnostics reported space:"local" and the gravity-aligned space was never used.
      optionalFeatures: ['local-floor', 'plane-detection', 'dom-overlay', 'depth-sensing'],
      depthSensing: {
        usagePreference: ['gpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'float32']
      },
      domOverlay: { root: overlay }
    };
    // Some runtimes reject the WHOLE request if the depthSensing dictionary is not to their
    // liking. Losing the session for the sake of an optional feature would be a poor trade,
    // so a refusal retries without it.
    return navigator.xr.requestSession('immersive-ar', withDepth)
      .catch(function () {
        return navigator.xr.requestSession('immersive-ar', {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['local-floor', 'plane-detection', 'dom-overlay'],
          domOverlay: { root: overlay }
        });
      })
      .then(function (session) { return run(session, overlay, els, opts); })
      .catch(function (err) { overlay.remove(); throw err; });
  }

  function run(session, overlay, els, opts) {
    var canvas = document.createElement('canvas');
    // No antialiasing: the rug is 12 triangles, so MSAA buys nothing and costs fill rate on
    // exactly the budget GPUs that need the headroom.
    var glOpts = { xrCompatible: true, alpha: true, antialias: false };
    var gl = canvas.getContext('webgl2', glOpts);
    var isGL2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', glOpts);
    var prog, loc, face, body, tex, glNote = '';
    var refSpace, viewerSpace, hitSource, transientSource;
    var hasPlanes = false, dwell = makeDwell();

    // THE LOCK. Once accepted, `floorY` is captured in `local` space and is never written
    // again — not by a plane update, not by a hit-test, not by a drag. This single rule is
    // what stops the rug lifting when you stand up.
    var locked = false, floorY = 0, posX = 0, posZ = 0, rotY = 0, floorUp = [0, 1, 0];
    // The plane we have settled on, tracked across frames so corrections and merges can be
    // followed rather than ignored.
    var trackedPlane = null, stabBuf = [], lastT = 0, corrections = 0, rejects = 0;
    var correcting = false, rejectSince = 0, relocks = 0;
    var candidate = null, reticle = null, twoFingerAngle = null, spaceNote = 'local';
    var statusTick = null, glBinding = null;
    var occlOn = true, debugMask = false, frames = 0, t0 = 0;
    var depthAvailable = true, fbScale = 1;
    var diag = {
      ua: navigator.userAgent, gl: '', space: '', depth: 'unavailable', depthFmt: '',
      planes: 0, chosenArea: 0, mappedArea: 0, tiltDeg: 0, floorY: 0,
      corrections: 0, jumpsRejected: 0, relocks: 0, fps: 0, fbScale: 1,
      occlusion: 'on', notes: []
    };

    var model = new Float32Array(16);

    function status(msg, sub) { els.msg.textContent = msg; els.sub.textContent = sub || ''; }

    function initGL() {
      prog = program(gl);
      gl.useProgram(prog);
      loc = {
        aPos: gl.getAttribLocation(prog, 'aPos'),
        aNrm: gl.getAttribLocation(prog, 'aNrm'),
        aUv: gl.getAttribLocation(prog, 'aUv'),
        uProj: gl.getUniformLocation(prog, 'uProj'),
        uView: gl.getUniformLocation(prog, 'uView'),
        uModel: gl.getUniformLocation(prog, 'uModel'),
        uTex: gl.getUniformLocation(prog, 'uTex'),
        uIsFace: gl.getUniformLocation(prog, 'uIsFace'),
        uAlpha: gl.getUniformLocation(prog, 'uAlpha'),
        uDepth: gl.getUniformLocation(prog, 'uDepth'),
        uUseDepth: gl.getUniformLocation(prog, 'uUseDepth'),
        uDepthUv: gl.getUniformLocation(prog, 'uDepthUv'),
        uRawToM: gl.getUniformLocation(prog, 'uRawToM'),
        uOcclBias: gl.getUniformLocation(prog, 'uOcclBias'),
        uDebug: gl.getUniformLocation(prog, 'uDebug')
      };
      face = uploadPart(gl, opts.geometry.face, true);
      body = uploadPart(gl, opts.geometry.body, false);
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, opts.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // WHY THE RUG RENDERED BLACK: rug photos are not power-of-two (this one is 853x1172).
      // In WebGL 1 an NPOT texture with a mipmap min-filter is INCOMPLETE, and an incomplete
      // texture samples as opaque black — it does not warn, it just goes dark. WebGL 2 lifts
      // the restriction, so mipmap only when it is actually legal.
      var w = opts.texture.width || 0, h = opts.texture.height || 0;
      var pot = w > 0 && h > 0 && (w & (w - 1)) === 0 && (h & (h - 1)) === 0;
      if (isGL2 || pot) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.generateMipmap(gl.TEXTURE_2D);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      glNote = (isGL2 ? 'gl2' : 'gl1') + ' ' + w + 'x' + h + (pot ? ' pot' : ' npot');
      diag.gl = glNote;
      var e = gl.getError();
      if (e) glNote += ' GLERR:' + e;
    }

    function drawPart(part, isFace) {
      gl.bindBuffer(gl.ARRAY_BUFFER, part.pos);
      gl.enableVertexAttribArray(loc.aPos);
      gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, part.nrm);
      gl.enableVertexAttribArray(loc.aNrm);
      gl.vertexAttribPointer(loc.aNrm, 3, gl.FLOAT, false, 0, 0);
      if (part.uv) {
        gl.bindBuffer(gl.ARRAY_BUFFER, part.uv);
        gl.enableVertexAttribArray(loc.aUv);
        gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);
      } else {
        gl.disableVertexAttribArray(loc.aUv);
        gl.vertexAttrib2f(loc.aUv, 0, 0);
      }
      gl.uniform1f(loc.uIsFace, isFace);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.idx);
      gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_SHORT, 0);
    }

    function render(pose, layer, frame) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      // A preview before locking would be a lie about where the rug will land, so nothing is
      // drawn until there is a real floor to draw it on.
      if (!locked && !(candidate && reticle)) return;
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc.uTex, 0);
      gl.uniform1f(loc.uAlpha, locked ? 1 : 0.6);

      var y = locked ? floorY : candidate.y;
      var x = locked ? posX : reticle.x, z = locked ? posZ : reticle.z;
      basisModel(locked ? floorUp : (candidate.up || [0, 1, 0]), rotY, x, y, z, model);
      gl.uniformMatrix4fv(loc.uModel, false, model);

      gl.uniform1f(loc.uOcclBias, OCCL_BIAS);
      gl.uniform1f(loc.uDebug, debugMask ? 1 : 0);

      for (var i = 0; i < pose.views.length; i++) {
        var view = pose.views[i], vp = layer.getViewport(view);
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
        gl.uniformMatrix4fv(loc.uProj, false, view.projectionMatrix);
        gl.uniformMatrix4fv(loc.uView, false, view.transform.inverse.matrix);

        // Depth is published per view, so it must be fetched inside this loop, not once.
        //
        // PERFORMANCE: this used to call getDepthInformation() every frame even after it had
        // already thrown. On a device without depth-sensing that is a DOMException
        // constructed, thrown, caught and string-concatenated 60x a second forever — measured
        // at 8 fps on a Galaxy A17. One failure is enough to know; latch it off.
        var di = null;
        if (occlOn && depthAvailable && glBinding) {
          try { di = glBinding.getDepthInformation(view); }
          catch (e) {
            di = null;
            depthAvailable = false;
            diag.depth = 'unsupported: ' + (e && e.message ? e.message : e);
            els.occl.textContent = 'Occlusion: n/a';
            els.occl.disabled = true;
          }
        }
        if (di && di.texture) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, di.texture);
          gl.uniform1i(loc.uDepth, 1);
          gl.uniformMatrix4fv(loc.uDepthUv, false, di.normDepthBufferFromNormView.matrix);
          gl.uniform1f(loc.uRawToM, di.rawValueToMeters);
          gl.uniform1f(loc.uUseDepth, 1);
          diag.depth = di.width + 'x' + di.height;
          diag.depthFmt = 'gpu · ' + di.rawValueToMeters.toExponential(2) + ' m/unit';
          gl.activeTexture(gl.TEXTURE0);
        } else {
          gl.uniform1f(loc.uUseDepth, 0);
          if (occlOn && glBinding && diag.depth === 'unavailable') diag.depth = 'no gpu depth texture';
        }
        drawPart(face, 1);
        drawPart(body, 0);
      }
    }

    /**
     * Drag and rotate, both derived from ARCore's own raycast against the world.
     *
     * The critical line is that only X and Z are ever taken. Re-running a hit-test on drag is
     * exactly what lets the rug climb onto a chair or drift upward as planes are revised; here
     * the height simply cannot change.
     */
    function handleInput(frame) {
      if (!transientSource) return;
      var results = frame.getHitTestResultsForTransientInput(transientSource);
      if (!results.length) { twoFingerAngle = null; return; }

      // Rotation is allowed in BOTH states. Orientation is a decision you make while looking
      // at the preview — a runner along the hallway or across it — so requiring placement
      // first gets the order backwards.
      if (results.length >= 2) {
        var a = results[0].results[0], b = results[1].results[0];
        if (!a || !b) return;
        var pa = a.getPose(refSpace), pb = b.getPose(refSpace);
        if (!pa || !pb) return;
        var ang = Math.atan2(pb.transform.position.z - pa.transform.position.z,
                             pb.transform.position.x - pa.transform.position.x);
        if (twoFingerAngle !== null) rotY -= (ang - twoFingerAngle);
        twoFingerAngle = ang;
        return;
      }

      twoFingerAngle = null;
      // Position only becomes draggable once placed; before that it tracks the reticle.
      if (!locked) return;
      var hit = results[0].results[0];
      if (!hit) return;
      var p = hit.getPose(refSpace);
      if (!p) return;
      posX = p.transform.position.x;
      posZ = p.transform.position.z;   // Y deliberately ignored — the floor is already locked
    }

    /**
     * Follow the floor after locking, accepting refinement but not jumps.
     *
     * Also survives ARCore's plane MERGING: when two planes are merged the old XRPlane object
     * is dropped from detectedPlanes entirely. Holding a dead reference would silently freeze
     * corrections, so a vanished plane is re-acquired from the current best floor — but only
     * if it is within REACQUIRE_TOL of where we already are, otherwise it is a different
     * surface wearing the floor's name.
     */
    function trackFloor(frame, t) {
      if (!hasPlanes || !frame.detectedPlanes) return;
      diag.planes = frame.detectedPlanes.size || 0;
      var dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
      var target = null;

      if (trackedPlane && frame.detectedPlanes.has && frame.detectedPlanes.has(trackedPlane)) {
        var pose = frame.getPose(trackedPlane.planeSpace, refSpace);
        if (pose) target = pose.transform.position.y;
      } else {
        var re = pickFloor(frame, refSpace, floorY + 1.4);
        if (re && Math.abs(re.y - floorY) <= REACQUIRE_TOL) {
          trackedPlane = re.plane || null;
          target = re.y;
          floorUp = re.up || floorUp;
        }
      }
      if (target === null) return;

      diag.floorY = +floorY.toFixed(4);
      diag.corrections = corrections; diag.jumpsRejected = rejects;
      diag.tiltDeg = +tiltDeg(floorUp).toFixed(2);
      var r = correct(floorY, target, dt, correcting);
      correcting = r.correcting;
      if (r.branch === 'rejected') {
        rejects++;
        if (!rejectSince) rejectSince = t;
        if (t - rejectSince > RELOCK_MS) {
          floorY = target; correcting = false; rejectSince = 0;
          relocks++; diag.relocks = relocks;
        }
        return;
      }
      rejectSince = 0;
      if (r.branch === 'slew' || r.branch === 'settled') { floorY = r.y; corrections++; }
    }

    function lock() {
      if (!candidate || !reticle) return;
      floorY = candidate.y;
      floorUp = candidate.up || [0, 1, 0];
      trackedPlane = candidate.plane || null;
      corrections = 0; rejects = 0; correcting = false;
      posX = reticle.x; posZ = reticle.z;
      locked = true;
      els.place.hidden = true;
      els.rescan.hidden = false;
      status('Locked to the floor',
        'Drag · 2 fingers rotate · tracking floor · tilt ' +
        tiltDeg(floorUp).toFixed(1) + '° · ' + spaceNote + ' · ' + glNote +
        (candidate.fallback ? ' · dwell' : ''));
      statusTick = setInterval(function () {
        if (!locked) return;
        els.sub.textContent = 'Drag · 2 fingers rotate · tilt ' + tiltDeg(floorUp).toFixed(1) +
          '° · y=' + floorY.toFixed(3) + ' m · ' + corrections + ' corrections, ' +
          rejects + ' jumps rejected · ' + spaceNote;
      }, 500);
    }

    function rescan() {
      if (statusTick) { clearInterval(statusTick); statusTick = null; }
      locked = false; candidate = null; dwell = makeDwell();
      trackedPlane = null; stabBuf = [];
      els.place.hidden = false; els.place.disabled = true;
      els.rescan.hidden = true;
      status('Scanning for the floor…', 'Move your phone slowly across the floor');
    }

    for (var ri = 0; ri < els.rot.length; ri++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          rotY += (btn.getAttribute('data-d') === '1' ? 1 : -1) * Math.PI / 12;   // 15 degrees
        });
      })(els.rot[ri]);
    }
    els.occl.addEventListener('click', function () {
      occlOn = !occlOn;
      diag.occlusion = occlOn ? 'on' : 'off';
      els.occl.textContent = 'Occlusion: ' + diag.occlusion;
    });
    // Renders the computed mask instead of the rug: red = occluded, green = floor, blue tint
    // carries the decoded metres. If the depth decode is wrong this shows it immediately
    // rather than presenting as a mysteriously invisible rug.
    els.mask.addEventListener('click', function () {
      debugMask = !debugMask;
      els.mask.textContent = debugMask ? 'Mask: ON' : 'Mask';
    });
    els.place.addEventListener('click', lock);
    els.rescan.addEventListener('click', rescan);
    els.exit.addEventListener('click', function () { session.end(); });

    function onFrame(t, frame) {
      session.requestAnimationFrame(onFrame);
      var layer = session.renderState.baseLayer;
      var pose = frame.getViewerPose(refSpace);
      if (!pose || !layer) return;
      var camY = pose.transform.position.y;

      if (!locked) {
        var found = hasPlanes ? pickFloor(frame, refSpace, camY) : null;
        if (!found && !hasPlanes) found = dwell(frame, hitSource, refSpace, camY);

        if (found) {
          // Restart the stability clock whenever the winning plane changes identity — a
          // different surface has to earn its own settling time.
          if (found.plane !== trackedPlane) { trackedPlane = found.plane || null; stabBuf = []; }
          stabBuf.push({ t: t, y: found.y });
          while (stabBuf.length && t - stabBuf[0].t > STABLE_MS) stabBuf.shift();
          var span = stabBuf.length ? t - stabBuf[0].t : 0;
          var lo = Infinity, hi = -Infinity;
          for (var si = 0; si < stabBuf.length; si++) {
            if (stabBuf[si].y < lo) lo = stabBuf[si].y;
            if (stabBuf[si].y > hi) hi = stabBuf[si].y;
          }
          found.settled = span >= STABLE_MS * 0.9 && (hi - lo) <= STABLE_SPREAD;
          found.settleFrac = Math.min(1, span / STABLE_MS);
          found.wobble = stabBuf.length > 1 ? hi - lo : 0;
          candidate = found;
          diag.chosenArea = +(found.area || 0).toFixed(2);
          diag.mappedArea = +(found.total || 0).toFixed(2);
        }

        var hits = frame.getHitTestResults(hitSource);
        if (hits.length) {
          var hp = hits[0].getPose(refSpace);
          if (hp) reticle = { x: hp.transform.position.x, z: hp.transform.position.z };
        }

        var ready = !!(candidate && reticle && (candidate.settled || candidate.fallback));
        els.place.disabled = !ready;
        if (candidate && reticle && !ready) {
          status('Steadying the floor estimate…',
            Math.round((candidate.settleFrac || 0) * 100) + '% · height moving ±' +
            (((candidate.wobble || 0) * 100) / 2).toFixed(1) + ' cm · keep the phone moving slowly');
        } else if (ready) {
          status('Floor found — rotate if needed, then place',
            (candidate.fallback
              ? 'Steady height held · ' + (camY - candidate.y).toFixed(2) + ' m below camera'
              : candidate.area.toFixed(1) + ' m² floor · ' + candidate.total.toFixed(1) +
                ' m² mapped · ' + (camY - candidate.y).toFixed(2) + ' m below camera') +
            ' · tilt ' + tiltDeg(candidate.up || [0, 1, 0]).toFixed(1) + '° · ' + spaceNote);
        } else {
          status('Scanning for the floor…',
            hasPlanes ? 'Move your phone slowly across the floor — needs ' + MIN_FLOOR_AREA +
                        ' m² of open floor' : 'Hold steady, pointing at the floor');
        }
        handleInput(frame);   // rotate the preview before committing
      } else {
        trackFloor(frame, t);
        handleInput(frame);
      }
      lastT = t;
      frames++;
      if (!t0) t0 = t;
      if (t - t0 > 1000) {
        diag.fps = Math.round(frames * 1000 / (t - t0));
        frames = 0; t0 = t;
        // Still struggling at 0.8? Drop further. A legible 20 fps beats a crisp 8.
        if (diag.fps > 0 && diag.fps < 14 && fbScale > 0.61) {
          fbScale = 0.6; diag.fbScale = fbScale;
          try {
            session.updateRenderState({
              baseLayer: new XRWebGLLayer(session, gl, { framebufferScaleFactor: fbScale })
            });
            diag.notes.push('reduced framebuffer to 0.6 after ' + diag.fps + ' fps');
          } catch (e) { /* keep rendering at the current scale */ }
        }
      }
      render(pose, layer, frame);
    }

    initGL();
    // Render below native resolution. Phone AR is fill-rate bound and the camera feed behind
    // the rug hides the difference; 0.8 is a standard AR default, not a compromise.
    fbScale = 0.8;
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl, { framebufferScaleFactor: fbScale }) });
    diag.fbScale = fbScale;
    status('Starting…', '');

    session.addEventListener('end', function () {
      if (statusTick) clearInterval(statusTick);
      diag.space = spaceNote;
      try { document.dispatchEvent(new CustomEvent('rugar:xr-diag', { detail: diag })); }
      catch (e) { /* ignore */ }
      overlay.remove();
      if (opts.onEnd) opts.onEnd();
    });

    // `local-floor` is specified as gravity-aligned with its origin at floor level; `local`
    // has platform-defined orientation. Prefer the one with a guarantee.
    return Promise.all([
      session.requestReferenceSpace('local-floor')
        .then(function (sp) { spaceNote = 'local-floor'; return sp; })
        .catch(function () {
          spaceNote = 'local';
          return session.requestReferenceSpace('local');
        }),
      session.requestReferenceSpace('viewer')
    ]).then(function (spaces) {
      refSpace = spaces[0]; viewerSpace = spaces[1];
      hasPlanes = typeof XRPlane !== 'undefined' &&
        session.enabledFeatures ? session.enabledFeatures.indexOf('plane-detection') >= 0
                                : typeof XRPlane !== 'undefined';
      return Promise.all([
        session.requestHitTestSource({ space: viewerSpace }),
        session.requestHitTestSourceForTransientInput
          ? session.requestHitTestSourceForTransientInput({ profile: 'generic-touchscreen' })
              .catch(function () { return null; })
          : null
      ]);
    }).then(function (sources) {
      hitSource = sources[0];
      transientSource = sources[1];
      try { glBinding = new XRWebGLBinding(session, gl); }
      catch (e) { glBinding = null; diag.notes.push('XRWebGLBinding unavailable: ' + e.message); }
      // Ask up front rather than discovering it by throwing once per frame.
      if (session.enabledFeatures && session.enabledFeatures.indexOf('depth-sensing') < 0) {
        depthAvailable = false;
        diag.depth = 'not granted by session';
        els.occl.textContent = 'Occlusion: n/a';
        els.occl.disabled = true;
      }
      diag.space = spaceNote;
      rescan();
      session.requestAnimationFrame(onFrame);
      return session;
    });
  }

  window.RugARXR = { supported: supported, start: start,
    _pickFloor: pickFloor, _area: polygonArea, _basis: basisModel, _tilt: tiltDeg, _correct: correct };
})();
