/**
 * RugAR — embeddable AR rug visualizer.
 *
 * WHY THIS IS SMALL: ripxotic's AR pipeline exists because a car is 2.29M triangles and
 * iOS rebuilds an UNCOMPRESSED USDZ on-device at tap time (see ripxotic tools/make-ar-model.ts).
 * A rug is a flat extruded outline — 12 triangles for a rectangle, ~380 for a 96-segment
 * round. There is no triangle budget to manage, no simplification, no per-SKU model pipeline.
 *
 * So the AR asset is assembled IN THE BROWSER, per view, from two inputs the retailer's own
 * page already has: the top-down rug photo and the selected size. The photo is fetched
 * cross-origin straight from the retailer's CDN and its JPEG/PNG bytes are copied verbatim
 * into the GLB — never decoded, never re-encoded, never uploaded. That is the whole reason
 * marginal COGS rounds to zero: no rug image byte ever transits our infrastructure.
 *
 * Shapes are handled as GEOMETRY, not as an alpha mask on the texture. A round rug is a
 * clipped disc, not a rectangle with transparent corners. That keeps us on opaque JPEG
 * (smaller than PNG, and what the retailer already serves) and avoids ever touching a canvas.
 *
 * Public API:
 *   RugAR.configure({ sku, name, imageUrl, width, length, shape, thickness, ... })
 *   RugAR.open()  /  RugAR.close()
 */
(function () {
  'use strict';

  var VERSION = '0.4.0';
  var IN2M = 0.0254;
  var ROUND_SEGMENTS = 96;

  // ---------------------------------------------------------------- units

  /**
   * Parse a retail size string into inches. Retailers write sizes a dozen ways and the
   * snippet has to survive all of them, because we are reading whatever their PDP renders:
   *   "5'3\"x7'7\""  "8x10"  "2' X 8'"  "6'7\" Round"  "27 x 45"  "5.3 x 7.6"
   * Bare numbers under 30 are read as FEET (nobody sells a 5-inch rug); 30+ as inches,
   * which is how their own "27 x 45" runner listings read.
   */
  function parseSize(str, shape) {
    if (str == null) return null;
    var s = String(str)
      .replace(/[′’]/g, "'")     // prime / curly apostrophe -> foot mark
      .replace(/[″”]/g, '"')     // double prime / curly quote -> inch mark
      .replace(/[×]/g, 'x')           // multiplication sign
      .toLowerCase();
    // strip shape words so "6'7" round" parses as a single dimension
    s = s.replace(/\b(round|square|runner|rectangle|rectangular|oval|octagon|octagonal)\b/g, ' ');
    var parts = s.split(/\s*x\s*/).map(function (p) { return p.trim(); }).filter(Boolean);
    if (!parts.length) return null;

    function measure(p) {
      var m;
      if ((m = p.match(/(\d+(?:\.\d+)?)\s*'\s*(\d+(?:\.\d+)?)?\s*"?/)))
        return { v: parseFloat(m[1]) * 12 + (m[2] ? parseFloat(m[2]) : 0), explicit: true };
      if ((m = p.match(/(\d+(?:\.\d+)?)\s*"/))) return { v: parseFloat(m[1]), explicit: true };
      if ((m = p.match(/(\d+(?:\.\d+)?)/))) return { v: parseFloat(m[1]), explicit: false };
      return { v: NaN, explicit: false };
    }

    var a = measure(parts[0]);
    var b = parts.length > 1 ? measure(parts[1]) : a;   // "6'7" Round" -> square bounds
    var w, l, feet;
    // A bare number carries no unit, and the two dimensions must be judged TOGETHER:
    // "8x10" is feet, "27 x 45" is inches. Deciding per-value misreads the 27 in a 27x45
    // runner as 27 FEET. Rugs top out near 18', so that is the crossover.
    if (a.explicit && b.explicit) { w = a.v; l = b.v; }
    else if (!a.explicit && !b.explicit) {
      feet = Math.max(a.v, b.v) <= 18;
      w = a.v * (feet ? 12 : 1); l = b.v * (feet ? 12 : 1);
    } else {                                    // mixed, e.g. 5' x 84
      w = a.explicit ? a.v : (a.v <= 18 ? a.v * 12 : a.v);
      l = b.explicit ? b.v : (b.v <= 18 ? b.v * 12 : b.v);
    }
    if (!isFinite(w) || !isFinite(l) || w <= 0 || l <= 0) return null;
    return { width: w, length: l, shape: shape || inferShape(w, l) };
  }

  function inferShape(w, l) {
    var ratio = Math.max(w, l) / Math.min(w, l);
    if (ratio >= 2.2) return 'runner';
    if (ratio <= 1.05) return 'square';
    return 'rectangle';
  }

  function formatSize(w, l, shape) {
    function f(n) {
      var ft = Math.floor(n / 12), i = Math.round(n - ft * 12);
      if (i === 12) { ft += 1; i = 0; }
      return i ? ft + "'" + i + '"' : ft + "'";
    }
    if (shape === 'round') return f(w) + ' Round';
    if (shape === 'square') return f(w) + ' Square';
    return f(w) + ' x ' + f(l);
  }

  // ---------------------------------------------------------------- geometry

  /**
   * The rug's footprint as an ordered outline in the XZ (floor) plane. Every shape reduces
   * to one convex polygon, so a single extrude path below handles all of them — a rectangle
   * is just a 4-point outline and a round rug a 96-point one.
   *
   * Winding matters: glTF is Y-up right-handed, and this order is the one that makes the
   * top-face triangle fan produce +Y normals (verified per-shape). Reverse it and the rug
   * renders black in Quick Look because you are looking at its backfaces.
   */
  function outlineFor(shape, w, l) {
    var hw = w / 2, hl = l / 2, pts = [], i, a;
    if (shape === 'round' || shape === 'oval') {
      for (i = 0; i < ROUND_SEGMENTS; i++) {
        a = (i / ROUND_SEGMENTS) * Math.PI * 2;
        pts.push([hw * Math.cos(a), -hl * Math.sin(a)]);
      }
      return pts;
    }
    if (shape === 'octagon') {
      var k = 1 / Math.cos(Math.PI / 8);   // inscribe the octagon in the w x l bounding box
      for (i = 0; i < 8; i++) {
        a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        pts.push([hw * k * Math.cos(a), -hl * k * Math.sin(a)]);
      }
      return pts;
    }
    return [[-hw, -hl], [-hw, hl], [hw, hl], [hw, -hl]];
  }

  /**
   * Extrude the outline to `t` metres. Two primitives, because the pile face and the
   * backing/edge are different materials: the face carries the rug photo, the rest is a
   * dark binding. Splitting them also means the photo's UVs never have to cover the sides.
   */
  function buildGeometry(shape, w, l, t) {
    var o = outlineFor(shape, w, l), n = o.length, hw = w / 2, hl = l / 2, i;

    var fp = [], fn = [], fu = [], fi = [];
    for (i = 0; i < n; i++) {
      fp.push(o[i][0], t, o[i][1]);
      fn.push(0, 1, 0);
      fu.push((o[i][0] + hw) / w, (o[i][1] + hl) / l);   // v=0 at the far edge
    }
    for (i = 1; i < n - 1; i++) fi.push(0, i, i + 1);

    var bp = [], bn = [], bi = [];
    for (i = 0; i < n; i++) { bp.push(o[i][0], 0, o[i][1]); bn.push(0, -1, 0); }
    for (i = 1; i < n - 1; i++) bi.push(0, i + 1, i);     // reversed -> -Y

    var base = n;
    for (i = 0; i < n; i++) {
      var p0 = o[i], p1 = o[(i + 1) % n];
      var nx = -(p1[1] - p0[1]), nz = (p1[0] - p0[0]);
      var m = Math.hypot(nx, nz) || 1; nx /= m; nz /= m;
      bp.push(p0[0], t, p0[1], p1[0], t, p1[1], p1[0], 0, p1[1], p0[0], 0, p0[1]);
      for (var k = 0; k < 4; k++) bn.push(nx, 0, nz);
      bi.push(base, base + 2, base + 1, base, base + 3, base + 2);
      base += 4;
    }

    return {
      face: { p: new Float32Array(fp), n: new Float32Array(fn), u: new Float32Array(fu), i: new Uint16Array(fi) },
      body: { p: new Float32Array(bp), n: new Float32Array(bn), i: new Uint16Array(bi) },
      tris: (fi.length + bi.length) / 3,
      verts: (fp.length + bp.length) / 3
    };
  }

  // ---------------------------------------------------------------- GLB

  var FLOAT = 5126, USHORT = 5123, ARRAY_BUF = 34962, ELEM_BUF = 34963;
  function pad4(n) { return (n + 3) & ~3; }

  /**
   * Hand-written GLB serializer. three.js + GLTFExporter is ~600KB; our geometry is a
   * known convex extrusion, so emitting the container directly costs ~120 lines and keeps
   * the snippet in the tens of kilobytes. On a widget that runs on someone else's product
   * page, that difference is the difference between shippable and not.
   */
  function buildGlb(geo, imageBytes, mimeType, opts) {
    var views = [], accessors = [], chunks = [], offset = 0;

    function putView(arr, target) {
      var bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      var padding = pad4(offset) - offset;
      if (padding) { chunks.push(new Uint8Array(padding)); offset += padding; }
      chunks.push(bytes);
      var v = { buffer: 0, byteOffset: offset, byteLength: bytes.length };
      if (target) v.target = target;
      offset += bytes.length;
      views.push(v);
      return views.length - 1;
    }

    function putAccessor(arr, type, comp, components, target, withBounds) {
      var a = { bufferView: putView(arr, target), componentType: comp, count: arr.length / components, type: type };
      if (withBounds) {
        var mn = [], mx = [], c;
        for (c = 0; c < components; c++) { mn.push(Infinity); mx.push(-Infinity); }
        for (var j = 0; j < arr.length; j++) {
          c = j % components;
          if (arr[j] < mn[c]) mn[c] = arr[j];
          if (arr[j] > mx[c]) mx[c] = arr[j];
        }
        a.min = mn; a.max = mx;
      }
      accessors.push(a);
      return accessors.length - 1;
    }

    var fP = putAccessor(geo.face.p, 'VEC3', FLOAT, 3, ARRAY_BUF, true);
    var fN = putAccessor(geo.face.n, 'VEC3', FLOAT, 3, ARRAY_BUF, false);
    var fU = putAccessor(geo.face.u, 'VEC2', FLOAT, 2, ARRAY_BUF, false);
    var fI = putAccessor(geo.face.i, 'SCALAR', USHORT, 1, ELEM_BUF, false);
    var bP = putAccessor(geo.body.p, 'VEC3', FLOAT, 3, ARRAY_BUF, true);
    var bN = putAccessor(geo.body.n, 'VEC3', FLOAT, 3, ARRAY_BUF, false);
    var bI = putAccessor(geo.body.i, 'SCALAR', USHORT, 1, ELEM_BUF, false);
    var imgView = putView(imageBytes, 0);

    var json = {
      asset: { version: '2.0', generator: 'RugAR ' + VERSION },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: opts.name || 'Rug' }],
      meshes: [{
        name: 'Rug',
        primitives: [
          { attributes: { POSITION: fP, NORMAL: fN, TEXCOORD_0: fU }, indices: fI, material: 0 },
          { attributes: { POSITION: bP, NORMAL: bN }, indices: bI, material: 1 }
        ]
      }],
      materials: [
        // roughness 0.92: wool/polypropylene pile is almost fully diffuse. Anything glossier
        // reads as vinyl under Quick Look's default lighting.
        { name: 'RugFace', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.92 } },
        { name: 'RugBacking', pbrMetallicRoughness: { baseColorFactor: [0.16, 0.15, 0.14, 1], metallicFactor: 0, roughnessFactor: 1 } }
      ],
      textures: [{ sampler: 0, source: 0 }],
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
      images: [{ bufferView: imgView, mimeType: mimeType || 'image/jpeg' }],
      bufferViews: views,
      accessors: accessors,
      buffers: [{ byteLength: offset }]
    };

    var jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    var jsonPadded = pad4(jsonBytes.length);
    var binPadded = pad4(offset);
    var total = 12 + 8 + jsonPadded + 8 + binPadded;

    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true);           // "glTF"
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonPadded, true);
    dv.setUint32(16, 0x4E4F534A, true);          // "JSON"
    out.set(jsonBytes, 20);
    for (var s = 20 + jsonBytes.length; s < 20 + jsonPadded; s++) out[s] = 0x20;  // pad JSON with spaces
    var binStart = 20 + jsonPadded;
    dv.setUint32(binStart, binPadded, true);
    dv.setUint32(binStart + 4, 0x004E4942, true); // "BIN"
    var w = binStart + 8;
    for (var c = 0; c < chunks.length; c++) { out.set(chunks[c], w); w += chunks[c].length; }

    return out;
  }

  // ---------------------------------------------------------------- USDZ

  /**
   * Write the iOS AR payload ourselves instead of letting model-viewer convert the GLB
   * on-device.
   *
   * The size win is real (~8KB of code here versus model-viewer's ~1MB) but it is not the
   * reason. The reason is PLACEMENT: USDZ carries Apple's preliminary anchoring schema —
   *
   *     preliminary:anchoring:type           = "plane"
   *     preliminary:planeAnchoring:alignment = "horizontal"
   *
   * — which tells Quick Look to anchor only to a detected HORIZONTAL plane. That removes the
   * two failure modes that make shoppers distrust AR: the rug hanging in mid-air, and the rug
   * landing on a wall. model-viewer's on-device conversion emits neither attribute and exposes
   * no way to add them, so generating the USDZ ourselves is the only route to them.
   *
   * A USDZ is a ZIP with two hard constraints: every entry STORED (never deflated), and every
   * entry's DATA offset aligned to 64 bytes. Alignment is achieved by padding the local
   * header's extra field. Get either wrong and Quick Look rejects the file silently.
   */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256), c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function fmtVec(arr, n, digits) {
    var out = [], i, j, parts;
    for (i = 0; i < arr.length; i += n) {
      parts = [];
      for (j = 0; j < n; j++) parts.push(+arr[i + j].toFixed(digits));
      out.push('(' + parts.join(', ') + ')');
    }
    return out.join(', ');
  }

  function extentOf(p) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], i, c, v;
    for (i = 0; i < p.length; i += 3) {
      for (c = 0; c < 3; c++) { v = p[i + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
    }
    for (c = 0; c < 3; c++) { mn[c] = +mn[c].toFixed(6); mx[c] = +mx[c].toFixed(6); }
    return '[(' + mn.join(', ') + '), (' + mx.join(', ') + ')]';
  }

  function meshBlock(name, g, material, flipV) {
    var counts = [], i;
    for (i = 0; i < g.i.length; i += 3) counts.push(3);
    var uv = '';
    if (g.u) {
      // USD's texture origin is bottom-left; glTF's is top-left. Without this flip the rug
      // renders mirrored front-to-back against the 2D preview.
      var v = new Float32Array(g.u.length);
      for (i = 0; i < g.u.length; i += 2) { v[i] = g.u[i]; v[i + 1] = flipV ? 1 - g.u[i + 1] : g.u[i + 1]; }
      uv = '\n        texCoord2f[] primvars:st = [' + fmtVec(v, 2, 5) + '] (interpolation = "vertex")';
    }
    return '\n    def Mesh "' + name + '"\n    {' +
      '\n        uniform token subdivisionScheme = "none"' +
      '\n        float3[] extent = ' + extentOf(g.p) +
      '\n        int[] faceVertexCounts = [' + counts.join(', ') + ']' +
      '\n        int[] faceVertexIndices = [' + Array.prototype.join.call(g.i, ', ') + ']' +
      '\n        point3f[] points = [' + fmtVec(g.p, 3, 6) + ']' +
      '\n        normal3f[] normals = [' + fmtVec(g.n, 3, 4) + '] (interpolation = "vertex")' +
      uv +
      '\n        rel material:binding = </Rug/Looks/' + material + '>' +
      '\n    }\n';
  }

  function usdaFor(geo, textureName) {
    return '#usda 1.0\n(\n    defaultPrim = "Rug"\n    metersPerUnit = 1\n    upAxis = "Y"\n)\n\n' +
      'def Xform "Rug" (\n    prepend apiSchemas = ["Preliminary_AnchoringAPI"]\n)\n{\n' +
      '    token preliminary:anchoring:type = "plane"\n' +
      '    token preliminary:planeAnchoring:alignment = "horizontal"\n' +
      meshBlock('Face', geo.face, 'RugFace', true) +
      meshBlock('Body', geo.body, 'RugBacking', false) +
      '\n    def Scope "Looks"\n    {\n' +
      '        def Material "RugFace"\n        {\n' +
      '            token outputs:surface.connect = </Rug/Looks/RugFace/Surface.outputs:surface>\n' +
      '            def Shader "Surface"\n            {\n' +
      '                uniform token info:id = "UsdPreviewSurface"\n' +
      '                color3f inputs:diffuseColor.connect = </Rug/Looks/RugFace/Tex.outputs:rgb>\n' +
      '                float inputs:metallic = 0\n' +
      '                float inputs:roughness = 0.92\n' +
      '                token outputs:surface\n            }\n' +
      '            def Shader "Tex"\n            {\n' +
      '                uniform token info:id = "UsdUVTexture"\n' +
      '                asset inputs:file = @' + textureName + '@\n' +
      '                float2 inputs:st.connect = </Rug/Looks/RugFace/Uv.outputs:result>\n' +
      '                token inputs:wrapS = "clamp"\n                token inputs:wrapT = "clamp"\n' +
      '                float3 outputs:rgb\n            }\n' +
      '            def Shader "Uv"\n            {\n' +
      '                uniform token info:id = "UsdPrimvarReader_float2"\n' +
      '                token inputs:varname = "st"\n                float2 inputs:fallback = (0, 0)\n' +
      '                float2 outputs:result\n            }\n        }\n\n' +
      '        def Material "RugBacking"\n        {\n' +
      '            token outputs:surface.connect = </Rug/Looks/RugBacking/Surface.outputs:surface>\n' +
      '            def Shader "Surface"\n            {\n' +
      '                uniform token info:id = "UsdPreviewSurface"\n' +
      '                color3f inputs:diffuseColor = (0.16, 0.15, 0.14)\n' +
      '                float inputs:metallic = 0\n                float inputs:roughness = 1\n' +
      '                token outputs:surface\n            }\n        }\n    }\n}\n';
  }

  /** STORED-only ZIP with 64-byte-aligned entry data — the USDZ container contract. */
  function zipUsdz(entries) {
    var locals = [], central = [], offset = 0, i;

    for (i = 0; i < entries.length; i++) {
      var name = entries[i].name, data = entries[i].data;
      var nameBytes = new TextEncoder().encode(name);
      // Pad the extra field so (localHeader + name + extra) lands on a 64-byte boundary.
      var extra = (64 - ((offset + 30 + nameBytes.length) % 64)) % 64;
      var head = new Uint8Array(30 + nameBytes.length + extra);
      var dv = new DataView(head.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 10, true);           // version needed
      dv.setUint16(8, 0, true);            // method 0 = stored
      dv.setUint32(14, crc32(data), true);
      dv.setUint32(18, data.length, true); // compressed == uncompressed
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, extra, true);
      head.set(nameBytes, 30);

      var cd = new Uint8Array(46 + nameBytes.length);
      var cdv = new DataView(cd.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 10, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint32(16, crc32(data), true);
      cdv.setUint32(20, data.length, true);
      cdv.setUint32(24, data.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);

      locals.push(head, data);
      central.push(cd);
      offset += head.length + data.length;
    }

    var cdOffset = offset, cdSize = 0;
    for (i = 0; i < central.length; i++) cdSize += central[i].length;
    var eocd = new Uint8Array(22);
    var edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, entries.length, true);
    edv.setUint16(10, entries.length, true);
    edv.setUint32(12, cdSize, true);
    edv.setUint32(16, cdOffset, true);

    var total = cdOffset + cdSize + 22, out = new Uint8Array(total), w = 0;
    for (i = 0; i < locals.length; i++) { out.set(locals[i], w); w += locals[i].length; }
    for (i = 0; i < central.length; i++) { out.set(central[i], w); w += central[i].length; }
    out.set(eocd, w);
    return out;
  }

  function buildUsdz(geo, imageBytes, mime) {
    var texName = 'rug.' + (mime === 'image/png' ? 'png' : 'jpg');
    var usda = new TextEncoder().encode(usdaFor(geo, texName));
    // The default layer must be the FIRST entry in the archive.
    return zipUsdz([{ name: 'rug.usda', data: usda }, { name: texName, data: imageBytes }]);
  }

  // ---------------------------------------------------------------- image

  /**
   * Rewrite a retailer CDN URL to the derivative we actually want. RugStudio serves through
   * Cloudinary, so their PDP URL arrives pre-baked with display transforms
   * (b_rgb:FFFFFF,c_pad,h_640,w_400) that pad the rug onto a white card — exactly wrong for a
   * texture, which needs to be edge-to-edge. We drop their transform chain and substitute ours.
   *
   * f_jpg is NOT a preference, it is a constraint: glTF core and USDZ accept JPEG and PNG only.
   * f_auto would hand us WebP/AVIF (about half the bytes, and what we DO use for the 2D preview
   * below) but that needs the EXT_texture_webp extension, which Quick Look does not implement —
   * the rug would silently render untextured on iPhone.
   *
   * Origins we do not recognise are passed through untouched and simply have to be
   * pre-trimmed by the retailer.
   */
  function optimizeImageUrl(url, px, forTexture) {
    try {
      var u = new URL(url, location.href);
      if (u.hostname !== 'res.cloudinary.com') return url;
      var parts = u.pathname.split('/');
      var ui = parts.indexOf('upload');
      if (ui < 0) return url;
      // Strip THEIR transform components, whatever shape they arrive in. A PDP link carries
      // a long chain (b_rgb:FFFFFF,c_pad,h_640,w_400/…); an og:image carries a short one
      // (f_auto,q_auto) and NO version segment. Keying off the version segment alone would
      // leave `f_auto` chained after ours on the og:image form — and f_auto serves WebP, which
      // glTF cannot carry, so the rug would render untextured on iPhone.
      // A transform component is comma-joined `xx_value` pairs; a path segment is not. Never
      // touch the final segment, or `s_ara587p-5.jpg` gets eaten as an `s_` transform.
      var rest = parts.slice(ui + 1);
      var TRANSFORM = /^[a-z]{1,4}_[^,/]+(?:,[a-z]{1,4}_[^,/]+)*$/;
      var IMAGEFILE = /\.(?:jpe?g|png|webp|avif|gif)$/i;
      var i = 0;
      while (i < rest.length - 1 && !IMAGEFILE.test(rest[i]) && TRANSFORM.test(rest[i])) i++;
      var tail = rest.slice(i).join('/');
      var fmt = forTexture ? 'f_jpg' : 'f_auto';
      var tf = 'e_trim,c_limit,w_' + px + ',' + fmt + ',q_auto:good';
      return u.origin + parts.slice(0, ui + 1).join('/') + '/' + tf + '/' + tail;
    } catch (e) { return url; }
  }

  /**
   * Pull the rug photo as raw bytes. This is the only network call the widget makes for
   * content, it goes DIRECT to the retailer's CDN, and the bytes are copied into the GLB
   * without ever being decoded. No canvas, no re-encode, no upload — which is both why it
   * is fast (~3ms of assembly) and why our marginal cost per view is effectively zero.
   */
  function fetchImageBytes(url) {
    return fetch(url, { mode: 'cors', credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('image fetch failed: HTTP ' + r.status);
      var ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      if (ct !== 'image/jpeg' && ct !== 'image/png') ct = 'image/jpeg';
      return r.arrayBuffer().then(function (b) { return { bytes: new Uint8Array(b), mime: ct }; });
    });
  }

  // ---------------------------------------------------------------- state

  var CFG = {
    sku: null, name: 'Rug', imageUrl: null,
    width: 63, length: 91, shape: 'rectangle', thickness: 0.25,
    sizes: [], brand: '', price: null,
    textureWidth: 1400,
    // Generate the iOS payload with our own writer (plane-anchored, scale-locked) instead of
    // letting model-viewer convert the GLB on-device. ?usdz=mv forces the old path so the two
    // can be compared on the same phone.
    customUsdz: true,
    // Scene Viewer runs in a SEPARATE Android app and is handed the model as `&file=<url>`.
    // A blob: URL is scoped to this page's origin, so Scene Viewer cannot fetch it — which
    // means a browser-generated GLB silently leaves WebXR as the ONLY Android path. Posting
    // the GLB to an endpoint that returns a real https URL is what re-enables Scene Viewer,
    // and it is the same Edge-Bake fallback the architecture already budgets for.
    assetEndpoint: null,
    arModes: 'webxr scene-viewer quick-look',
    // 'model-viewer' = model-viewer owns the AR session (WebXR or Scene Viewer).
    // 'rugar'        = our own WebXR session with a locked floor (assets/rugar-xr.js).
    xrEngine: 'model-viewer',
    xrUrl: 'assets/rugar-xr.js',
    modelViewerUrl: 'vendor/model-viewer.min.js',
    beacon: null, tenant: 'demo'
  };

  var state = { blobUrl: null, seq: 0, stats: null, mvReady: false, building: false };
  var els = {};

  var IS_MOBILE = /android|iphone|ipad|ipod/i.test(navigator.userAgent);

  function activeSize() {
    return { width: CFG.width, length: CFG.length, shape: CFG.shape };
  }

  // ---------------------------------------------------------------- AR asset

  var imageCache = {};   // url -> Promise<{bytes,mime}>  (per page-view; the CDN handles the rest)

  function getImage(url) {
    if (!imageCache[url]) {
      imageCache[url] = fetchImageBytes(url).catch(function (e) { delete imageCache[url]; throw e; });
    }
    return imageCache[url];
  }

  /**
   * Rebuild the AR payload for the current selection.
   *
   * EAGERLY, on every size/shape change — never at tap time. iOS only honours activateAR()
   * inside the user gesture that triggered it, so if the model-viewer src is still resolving
   * when the finger lands, AR silently no-ops. ripxotic learned this the hard way
   * (see its src/viewer/ar-share.ts); the same rule applies here.
   */
  function rebuild() {
    if (!CFG.imageUrl) return Promise.resolve(null);
    var seq = ++state.seq;
    var sz = activeSize();
    var texUrl = optimizeImageUrl(CFG.imageUrl, CFG.textureWidth, true);
    state.building = true;
    notify('preparing');

    return getImage(texUrl).then(function (img) {
      if (seq !== state.seq) return null;            // superseded by a newer selection
      var t0 = (performance && performance.now) ? performance.now() : Date.now();
      var geo = buildGeometry(sz.shape, sz.width * IN2M, sz.length * IN2M, CFG.thickness * IN2M);
      var glb = buildGlb(geo, img.bytes, img.mime, { name: CFG.name });
      var t1 = (performance && performance.now) ? performance.now() : Date.now();

      var usdz = null, t2 = t1;
      if (CFG.customUsdz) {
        usdz = buildUsdz(geo, img.bytes, img.mime);
        t2 = (performance && performance.now) ? performance.now() : Date.now();
      }

      state.geo = geo;
      if (CFG.xrEngine === 'rugar' && typeof createImageBitmap === 'function') {
        createImageBitmap(new Blob([img.bytes], { type: img.mime }))
          .then(function (bm) { if (seq === state.seq) state.bitmap = bm; })
          .catch(function () { state.bitmap = null; });
      }
      if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
      if (state.iosUrl) URL.revokeObjectURL(state.iosUrl);
      state.blobUrl = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
      state.iosUrl = usdz ? URL.createObjectURL(new Blob([usdz], { type: 'model/vnd.usdz+zip' })) : null;
      state.stats = {
        tris: geo.tris, verts: geo.verts,
        imageBytes: img.bytes.length, glbBytes: glb.length,
        usdzBytes: usdz ? usdz.length : 0,
        buildMs: Math.round((t1 - t0) * 100) / 100,
        usdzMs: usdz ? Math.round((t2 - t1) * 100) / 100 : 0,
        iosPath: usdz ? 'RugAR USDZ (horizontal plane anchor)' : 'model-viewer on-device conversion',
        textureUrl: texUrl
      };
      state.building = false;

      var mv = els.mv;
      // Set the ATTRIBUTE, not just the property: the bridge is created before the
      // model-viewer module has necessarily been upgraded, and a property assigned to a
      // not-yet-upgraded custom element shadows the accessor it is meant to drive.
      state.hostedUrl = null;
      publishGlb(glb, seq);
      if (mv) {
        mv.setAttribute('src', state.blobUrl);
        // ios-src takes precedence over model-viewer's own GLB->USDZ conversion, so this is
        // the hook that puts OUR plane-anchored payload in front of Quick Look. model-viewer
        // still appends #allowsContentScaling=0 to it because ar-scale is fixed.
        if (state.iosUrl) mv.setAttribute('ios-src', state.iosUrl);
        else mv.removeAttribute('ios-src');
      }
      renderDevPanel();
      notify('ready');
      return state.stats;
    }).catch(function (err) {
      state.building = false;
      state.error = err && err.message ? err.message : String(err);
      renderDevPanel();
      notify('error');
      return null;
    });
  }

  /**
   * Hand the generated GLB to the asset endpoint and swap model-viewer onto the returned
   * https URL. The blob stays the src until this resolves, so WebXR is never blocked waiting
   * on a network round trip — the upload only unlocks the Scene Viewer path.
   */
  function publishGlb(bytes, seq) {
    if (!CFG.assetEndpoint) return;
    fetch(CFG.assetEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'model/gltf-binary' },
      body: bytes
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (seq !== state.seq || !d || !d.url) return;
      var u = new URL(d.url, location.href);
      // model-viewer FORCE-DISABLES depth occlusion on every Scene Viewer launch:
      //     s.has("disable_occlusion") || s.set("disable_occlusion","true")
      // That is why the rug renders on top of real furniture on Android instead of
      // disappearing under it. The guard reads the params off OUR src URL, so carrying the
      // parameter here is the only way to opt back in. The S22 Ultra supports the ARCore
      // Depth API, so occlusion is genuinely available once it stops being suppressed.
      u.searchParams.set('disable_occlusion', 'false');
      state.hostedUrl = u.toString();
      if (els.mv) els.mv.setAttribute('src', state.hostedUrl);
      if (state.stats) state.stats.hostedUrl = state.hostedUrl;
      renderDevPanel();
    }).catch(function () { /* Scene Viewer stays unavailable; WebXR is unaffected */ });
  }

  /**
   * Preload the custom-session module. It MUST be resident before the AR button is tapped:
   * navigator.xr.requestSession() needs transient user activation, so a dynamic import at tap
   * time breaks the gesture chain and the session is refused. Same discipline as the GLB and
   * as model-viewer itself.
   */
  function ensureXrModule() {
    if (window.RugARXR) return Promise.resolve();
    if (state.xrLoading) return state.xrLoading;
    state.xrLoading = new Promise(function (res, rej) {
      var sc = document.createElement('script');
      sc.src = CFG.xrUrl;
      sc.onload = res;
      sc.onerror = function () { rej(new Error('rugar-xr.js failed to load')); };
      document.head.appendChild(sc);
    });
    return state.xrLoading;
  }

  function xrReady() {
    return !!(window.RugARXR && state.geo && state.bitmap);
  }

  function ensureModelViewer() {
    if (state.mvReady) return Promise.resolve();
    if (window.customElements && window.customElements.get('model-viewer')) {
      state.mvReady = true; return Promise.resolve();
    }
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.type = 'module';
      s.src = CFG.modelViewerUrl;
      s.onload = function () { state.mvReady = true; res(); };
      s.onerror = function () { rej(new Error('model-viewer failed to load')); };
      document.head.appendChild(s);
    });
  }

  /** Tell the host page where the AR payload stands, so its own button can disable itself
   *  while a new size is being assembled. Fires rugar:preparing / rugar:ready / rugar:error. */
  function notify(phase) {
    try {
      document.dispatchEvent(new CustomEvent('rugar:' + phase, {
        detail: { sku: CFG.sku, shape: CFG.shape, width: CFG.width, length: CFG.length,
                  stats: state.stats || null, error: state.error || null }
      }));
    } catch (e) { /* older browsers without CustomEvent constructor */ }
  }

  function report(event, extra) {
    if (!CFG.beacon) return;
    var body = JSON.stringify({
      t: CFG.tenant, e: event, sku: CFG.sku,
      w: CFG.width, l: CFG.length, shape: CFG.shape, ts: Date.now(), x: extra || null
    });
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(CFG.beacon, body);
      else fetch(CFG.beacon, { method: 'POST', body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* a blocked beacon must never affect the viewer */ }
  }

  // ---------------------------------------------------------------- room preview

  /**
   * The 2D preview is CSS 3D, not WebGL. A rug is planar, so a perspective-transformed image
   * on a rotated floor plane IS a correct projection of it — there is nothing for a renderer
   * to add. That keeps the desktop path at zero library bytes.
   *
   * The sofa is a sibling of the rug INSIDE the same floor plane (rotateX(-90deg) stands it
   * perpendicular to the floor), so both share one pixels-per-inch scale. That is the whole
   * point of the preview: an 84" sofa next to a 5'3"x7'7" rug shows a shopper, honestly, that
   * the rug they picked will not reach their coffee table. Wrong-size is the #1 cause of rug
   * returns, and rugs are heavy freight — this panel is the return-rate argument.
   */
  // STAGE_* is the design surface we scale to the host's width; FLOOR_* is the (much larger)
// ground plane inside it, sized so its own edges never enter the frame.
var STAGE_W = 1600;
  var PPI = 9, FLOOR_W = 6000, FLOOR_H = 2600;
  // Depths are measured in floor pixels from the floor plane's NEAR edge. The rug is
  // anchored by its centre and the sofa is pinned at a fixed depth, so changing size moves
  // the rug and leaves the furniture where it is — which is what makes the comparison
  // honest. Anchoring the rug's near edge instead would slide an 8'x10' off the bottom.
  var RUG_CENTRE_U = 1250, SOFA_FRONT_U = 1880;
  var SOFA_W = 84, SOFA_D = 36, SOFA_H = 30;

  function layoutRoom() {
    if (!els.rug) return;
    // Uniformly scale the fixed 1600x1000 design surface to whatever width the host page
    // gives us. Every 3D constant stays a stable design-space number this way, instead of
    // needing to be recomputed per breakpoint.
    if (els.room && els.roomInner && els.room.clientWidth) {
      els.roomInner.style.transform = 'scale(' + (els.room.clientWidth / STAGE_W) + ')';
    }
    var w = CFG.width, l = CFG.length, shape = CFG.shape;
    var rw = w * PPI, rl = l * PPI;
    var left = (FLOOR_W - rw) / 2;
    var top = FLOOR_H - (RUG_CENTRE_U + rl / 2);   // element top = the rug's FAR edge

    els.rug.style.width = rw + 'px';
    els.rug.style.height = rl + 'px';
    els.rug.style.left = left + 'px';
    els.rug.style.top = top + 'px';
    els.rug.style.borderRadius = (shape === 'round' || shape === 'oval') ? '50%' : '2px';
    els.rug.style.clipPath = shape === 'octagon'
      ? 'polygon(29.3% 0,70.7% 0,100% 29.3%,100% 70.7%,70.7% 100%,29.3% 100%,0 70.7%,0 29.3%)' : 'none';

    var sw = SOFA_W * PPI, sd = SOFA_D * PPI;
    els.sofa.style.width = sw + 'px';
    els.sofa.style.height = sd + 'px';
    els.sofa.style.left = (FLOOR_W - sw) / 2 + 'px';
    els.sofa.style.top = (FLOOR_H - (SOFA_FRONT_U + sd)) + 'px';
    els.sofaBack.style.height = (SOFA_H * PPI) + 'px';

    els.scaleNote.textContent = formatSize(w, l, shape) + '  ·  shown against a standard 84" sofa';
  }

  // ---------------------------------------------------------------- AR bridge

  /**
   * The <model-viewer> that owns the GLB and hands it to Quick Look / Scene Viewer / WebXR.
   * It lives directly in the page body, NOT inside any dialog, and is created as soon as the
   * widget is configured — because the AR button must be able to fire activateAR()
   * synchronously inside its own click. Anything that has to be created, loaded or awaited
   * at tap time makes iOS silently ignore the request.
   */
  function ensureBridge() {
    if (els.mv) return;
    var mv = document.createElement('model-viewer');
    mv.setAttribute('ar', '');
    mv.setAttribute('ar-modes', CFG.arModes);
    mv.setAttribute('ar-placement', 'floor');
    mv.setAttribute('ar-scale', 'fixed');   // a rug has ONE true size; never let AR resize it
    mv.setAttribute('shadow-intensity', '1');
    // The bridge is a 1px, fully transparent element, so model-viewer's default lazy
    // loading may never decide it is "visible enough" to fetch the model — and AR would
    // then activate against nothing. Force the load, and reveal without waiting.
    mv.setAttribute('loading', 'eager');
    mv.setAttribute('reveal', 'auto');
    mv.className = 'rugar-bridge';
    document.body.appendChild(mv);
    els.mv = mv;
    if (state.blobUrl) mv.setAttribute('src', state.blobUrl);
  }

  function arReady() {
    return !!(els.mv && els.mv.canActivateAR && state.blobUrl);
  }

  /**
   * The button's whole job: on a phone, go straight into AR. No preview, no dialog, no
   * intermediate step. The desktop path exists only because a desktop has no camera —
   * it hands the shopper the page on their phone instead.
   */
  function launch() {
    report('ar_activate');
    // Our own session first when selected. Called synchronously so requestSession() still sees
    // the user activation from this click.
    if (IS_MOBILE && CFG.xrEngine === 'rugar' && xrReady()) {
      window.RugARXR.start({
        geometry: state.geo,
        texture: state.bitmap,
        onEnd: function () { document.dispatchEvent(new CustomEvent('rugar:xr-end')); }
      }).catch(function (e) {
        state.error = 'AR session refused: ' + (e && e.message ? e.message : e);
        renderDevPanel();
        if (arReady()) els.mv.activateAR();   // fall back rather than leaving a dead button
      });
      return;
    }
    if (IS_MOBILE && arReady()) {
      els.mv.activateAR();     // MUST stay synchronous inside the gesture
      return;
    }
    openHandoff();
  }

  // ---------------------------------------------------------------- desktop handoff

  function h(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function buildUI() {
    if (els.root) return;
    var root = h('div', 'rugar-modal');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Open this rug in AR on your phone');
    root.innerHTML =
      '<div class="rugar-backdrop"></div>' +
      '<div class="rugar-panel">' +
        '<header class="rugar-head">' +
          '<div><p class="rugar-brand"></p><h2 class="rugar-title"></h2></div>' +
          '<button class="rugar-close" aria-label="Close">&#10005;</button>' +
        '</header>' +
        '<div class="rugar-handoff"></div>' +
        '<div class="rugar-controls">' +
          '<div class="rugar-group"><span class="rugar-label">Size</span><div class="rugar-sizes"></div></div>' +
        '</div>' +
        '<div class="rugar-stage">' +
          '<p class="rugar-stage-cap">Meanwhile, here it is at true scale against a standard 84&quot; sofa</p>' +
          '<div class="rugar-room"><div class="rugar-room-inner">' +
            '<div class="rugar-wall"></div>' +
            '<div class="rugar-floorwrap"><div class="rugar-floor">' +
              '<div class="rugar-boards"></div>' +
              '<div class="rugar-sofa"><span class="rugar-sofa-seat"></span><span class="rugar-sofa-back"></span></div>' +
              '<div class="rugar-rug"><div class="rugar-rug-img"></div></div>' +
            '</div></div>' +
          '</div><p class="rugar-scale-note"></p></div>' +
        '</div>' +
        '<button class="rugar-devtoggle">Developer view</button>' +
        '<pre class="rugar-dev" hidden></pre>' +
      '</div>';

    document.body.appendChild(root);
    els.root = root;
    els.title = root.querySelector('.rugar-title');
    els.brand = root.querySelector('.rugar-brand');
    els.room = root.querySelector('.rugar-room');
    els.roomInner = root.querySelector('.rugar-room-inner');
    els.sofa = root.querySelector('.rugar-sofa');
    els.sofaBack = root.querySelector('.rugar-sofa-back');
    els.rug = root.querySelector('.rugar-rug');
    els.rugImg = root.querySelector('.rugar-rug-img');
    els.sizes = root.querySelector('.rugar-sizes');
    els.handoff = root.querySelector('.rugar-handoff');
    els.scaleNote = root.querySelector('.rugar-scale-note');
    els.dev = root.querySelector('.rugar-dev');

    root.querySelector('.rugar-close').addEventListener('click', close);
    root.querySelector('.rugar-backdrop').addEventListener('click', close);
    root.querySelector('.rugar-devtoggle').addEventListener('click', function () {
      els.dev.hidden = !els.dev.hidden;
      renderDevPanel();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && els.root && els.root.classList.contains('open')) close();
    });
    syncPanel();
  }

  function renderSizes() {
    if (!els.sizes) return;
    els.sizes.innerHTML = '';
    var list = CFG.sizes && CFG.sizes.length ? CFG.sizes
      : [{ label: formatSize(CFG.width, CFG.length, CFG.shape), width: CFG.width, length: CFG.length, shape: CFG.shape }];
    list.forEach(function (s) {
      var b = h('button', 'rugar-chip');
      if (Math.abs(s.width - CFG.width) < 0.6 && Math.abs(s.length - CFG.length) < 0.6 && s.shape === CFG.shape) b.classList.add('active');
      b.innerHTML = '<span>' + s.label + '</span>' + (s.price != null ? '<em>$' + s.price + '</em>' : '');
      b.addEventListener('click', function () {
        CFG.width = s.width; CFG.length = s.length; CFG.shape = s.shape;
        if (s.price != null) CFG.price = s.price;
        renderSizes(); layoutRoom(); rebuild();
        report('size_change');
        document.dispatchEvent(new CustomEvent('rugar:size', { detail: activeSize() }));
      });
      els.sizes.appendChild(b);
    });
  }

  function openHandoff() {
    buildUI();
    els.root.classList.add('open');
    document.body.style.overflow = 'hidden';
    report('handoff');
    var preparing = IS_MOBILE && !arReady();
    els.handoff.innerHTML =
      '<div class="rugar-qr">' +
        '<img src="qr.png" alt="" onerror="this.style.display=\'none\'">' +
        '<div>' +
          '<strong>' + (preparing ? 'Getting AR ready…' : 'Point your phone at this') + '</strong>' +
          '<p>' + (preparing
            ? 'One moment — then tap “View in Your Room” again.'
            : 'AR needs a phone camera. Scan the code, or open this page on your device, and it goes straight into your room.') + '</p>' +
          '<code>' + location.href.replace(/</g, '&lt;') + '</code>' +
        '</div>' +
      '</div>';
    renderSizes(); layoutRoom(); renderDevPanel();
  }

  function close() {
    if (!els.root) return;
    els.root.classList.remove('open');
    document.body.style.overflow = '';
  }

  window.addEventListener('resize', function () {
    if (els.root && els.root.classList.contains('open')) layoutRoom();
  });

  function renderDevPanel() {
    if (!els.dev || els.dev.hidden) return;
    var s = state.stats || {};
    els.dev.textContent =
      '// what the product page passes us on every change\n' +
      'RugAR.configure(' + JSON.stringify({
        sku: CFG.sku, name: CFG.name, imageUrl: CFG.imageUrl,
        width: CFG.width, length: CFG.length, shape: CFG.shape, thickness: CFG.thickness
      }, null, 2) + ');\n\n' +
      '// generated in-browser, this view\n' +
      (state.error ? 'ERROR: ' + state.error + '\n' :
        'triangles      ' + s.tris + '\n' +
        'vertices       ' + s.verts + '\n' +
        'rug photo      ' + (s.imageBytes / 1024).toFixed(1) + ' KB   (fetched direct from the retailer CDN)\n' +
        'GLB payload    ' + (s.glbBytes / 1024).toFixed(1) + ' KB\n' +
        'USDZ payload   ' + (s.usdzBytes ? (s.usdzBytes / 1024).toFixed(1) + ' KB  (+' + s.usdzMs + ' ms)' : 'not generated') + '\n' +
        'assembly time  ' + s.buildMs + ' ms\n' +
        'iOS AR path    ' + (s.iosPath || '') + '\n' +
        'AR modes       ' + CFG.arModes + '\n' +
        'Android engine ' + (CFG.xrEngine === 'rugar'
          ? 'RugAR custom session — floor locked, no occlusion yet' + (xrReady() ? ' (ready)' : ' (preparing)')
          : 'model-viewer (' + CFG.arModes.split(' ')[0] + ')') + '\n' +
        'Scene Viewer   ' + (s.hostedUrl ? 'available, occlusion re-enabled\n               ' + s.hostedUrl : 'unavailable — blob src cannot be read by the Scene Viewer app') + '\n' +
        'AR scale       locked (allowsContentScaling=0 / resizable=false)\n' +
        'bytes via our servers   0\n\n' +
        'texture: ' + (s.textureUrl || '') + '\n');
  }

  function syncPanel() {
    if (!els.root) return;
    els.title.textContent = CFG.name;
    els.brand.textContent = [CFG.brand, CFG.sku ? 'SKU ' + CFG.sku : ''].filter(Boolean).join('  ·  ');
    if (els.rugImg && CFG.imageUrl) els.rugImg.style.backgroundImage = 'url("' + optimizeImageUrl(CFG.imageUrl, 900, false) + '")';
    renderSizes(); layoutRoom();
  }

  // ---------------------------------------------------------------- public API

  function configure(opts) {
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) CFG[k] = opts[k];
    if (els.mv && els.mv.getAttribute('ar-modes') !== CFG.arModes) els.mv.setAttribute('ar-modes', CFG.arModes);
    if (opts && opts.size) {
      var p = parseSize(opts.size, opts.shape);
      if (p) { CFG.width = p.width; CFG.length = p.length; CFG.shape = p.shape; }
    }
    (CFG.sizes || []).forEach(function (s) {
      if (s.width == null && s.label) {
        var q = parseSize(s.label, s.shape);
        if (q) { s.width = q.width; s.length = q.length; s.shape = s.shape || q.shape; }
      }
    });
    state.error = null;
    ensureBridge();
    // On a phone, pull the AR runtime down immediately rather than at tap time. The tap has
    // to reach activateAR() with everything already resolved, so this cost is paid up front,
    // on idle, once per page. (Production removes this dependency entirely by writing the
    // USDZ ourselves — see the spec; it is ~8KB against model-viewer's ~1MB.)
    if (IS_MOBILE && CFG.xrEngine === 'rugar') ensureXrModule().catch(function () {});
    if (IS_MOBILE) {
      var pre = function () { ensureModelViewer().catch(function () {}); };
      if (window.requestIdleCallback) requestIdleCallback(pre, { timeout: 2500 }); else setTimeout(pre, 300);
    }
    syncPanel();
    renderDevPanel();
    return rebuild();
  }

  // ?usdz=mv  -> model-viewer's on-device conversion (the old path)
  // ?usdz=1|on -> ours (the default)
  try {
    var q = (location.search.match(/[?&]usdz=([^&]*)/) || [])[1];
    if (q) CFG.customUsdz = !/^(mv|0|off|no)$/i.test(q);
  } catch (e) { /* no location in non-browser contexts */ }

  window.RugAR = {
    version: VERSION,
    configure: configure,
    launch: launch,
    open: openHandoff,
    close: close,
    isMobile: function () { return IS_MOBILE; },
    _internals: { parseSize: parseSize, buildGeometry: buildGeometry, buildGlb: buildGlb, buildUsdz: buildUsdz, optimizeImageUrl: optimizeImageUrl, formatSize: formatSize }
  };

  // Auto-init from a data-attribute snippet, so a retailer can integrate without writing JS.
  document.addEventListener('DOMContentLoaded', function () {
    var el = document.querySelector('[data-rugar-sku]');
    if (!el) return;
    configure({
      sku: el.getAttribute('data-rugar-sku'),
      name: el.getAttribute('data-rugar-name') || 'Rug',
      imageUrl: el.getAttribute('data-rugar-image'),
      size: el.getAttribute('data-rugar-size'),
      shape: el.getAttribute('data-rugar-shape') || undefined
    });
    el.addEventListener('click', launch);
  });
})();
