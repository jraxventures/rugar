# RugAR

Embeddable AR rug visualisation, repurposed from the ripxotic AR delivery stack for a
rug/carpet retailer (ORGTX / RugStudio, 350,000 SKUs).

## Why this is small

ripxotic's `tools/make-ar-model.ts` exists because a car is 2.29M triangles and iOS rebuilds an
uncompressed USDZ on-device at tap time. **A rug is 12 triangles.** That whole pipeline is
irrelevant here, so the AR asset is assembled in the browser, per view, in ~0.5 ms — from the
retailer's own CDN image, whose bytes are copied into the GLB without ever being decoded.

No rug image byte transits our infrastructure. That is what takes marginal COGS to ~zero.

## Layout

```
demo/            readable source — this is the deliverable to review
  index.html       mock RugStudio PDP (real ARA587P data: 5 sizes, 4 shapes, real prices)
  assets/rugar.js  the widget: geometry, GLB writer, USDZ writer, AR bridge, room preview
  assets/rugar-xr.js  custom WebXR session with a locked floor (lazy, Android only)
  assets/rugar.css widget styles (namespaced .rugar-*, safe on a host page)
  assets/site.css  demo page styles only — not part of the widget
  vendor/          model-viewer 4.3.1 (self-hosted for local dev)
dist/            minified build; standalone.html inlines everything into one file
docs/            spec, cost model, pricing strategy
```

## Run locally

```bash
python3 -m http.server 8099 --directory demo
```

Open `http://localhost:8099`. On a phone, "View in Your Room" goes **straight into AR**; on a
desktop it hands off by QR.

## Build

```bash
ESB=../ripxotic-site/node_modules/.bin/esbuild
$ESB demo/assets/rugar.js --minify --target=es2017 --outfile=dist/assets/rugar.js
```

Sizes: base snippet **21.6 KB raw / 8.5 KB gzipped**; the WebXR session module
(`rugar-xr.js`) is a further **15.7 KB / 6.5 KB gz**, loaded lazily and only on Android.

`dist/` is committed deliberately. This repo has no build tooling of its own — esbuild is
borrowed from the sibling `ripxotic-site` checkout — so a fresh clone could not otherwise
reproduce the deployable demo.

## Test locally, without a phone

```bash
python3 -m http.server 8099 --directory demo
```

- `/` — the mock product page with AR.
- `/sim.html` — runs the **real** floor-selection and height-correction code from `rugar-xr.js`
  against scripted scenarios, including the two failures seen on a Galaxy S22 Ultra (a pillar
  moulding winning over the floor; a squat/stand jump lifting the rug). No AR, no ARCore — it
  exercises the decision logic, which is the part that was getting them wrong.

For the AR itself there is no substitute for a device: plug the phone in over USB and use
`chrome://inspect` for a full DevTools session against the live AR run.

## Verified

- All 5 shapes produce GLBs that parse under `@gltf-transform`'s reader.
- `model-viewer` measures the 5'3"×7'7" model at 1.6002 × 0.00635 × 2.3114 m
  = exactly **63″ × 0.25″ × 91″**.
- Size parser handles 12 real-world formats (`5'3"x7'7"`, `8x10`, `27 x 45`, `6'7" Round`, …).
- Floor selection: 6/6 — rejects a pillar moulding, and rejects a spurious sliver *below* the
  floor (the case that disproves a "lowest plane wins" rule).
- Floor basis: 5/5 — all four rug corners stay coplanar with the detected floor to ~1e-8 m at
  any tilt or rotation.
- Height correction: 6/6 — absorbs genuine refinement at ~2 cm/s, and moves **0.00 cm** when a
  25 cm plane jump is reported.

Device-tested on a Galaxy A17 (entry-level), which surfaced three defects — see
`docs/ar-placement-and-scale.md` §10. Two were mine: a depth call that threw every frame
without ever latching off, and `local-floor` never being requested as a feature.

**Not fully verified:** the AR session on capable hardware. Nothing in a desktop browser exercises ARCore
or ARKit, so the on-device behaviour of the USDZ anchoring, the floor lock and the depth
occlusion is unproven until run on hardware. The in-AR overlay reports live diagnostics for
exactly this reason, and a diagnostics blob is emitted to the page when a session ends.

## Known gaps for production

- **Depth occlusion in the custom WebXR session.** Scene Viewer mode has occlusion; RugAR mode
  has the floor lock. Merging the two is the next piece — see `docs/ar-placement-and-scale.md`.
- Worker for beaconing, tenant config/licensing, and the Edge-Bake fallback path.
- `/api/extract` (the pasted-URL SKU resolver) is a demo/onboarding convenience served by a
  small Python service; in production it is a Worker, and a live integration doesn't need it.
- Per-size imagery where the retailer has it (texture is currently fitted to the selected size).
