# RugAR — AR rug visualisation as an embeddable service

**Date:** 2026-08-27  **Status:** design, validated by working prototype
**Prospect:** ORGTX / RugStudio (350,000 SKUs, multiple physical stores centralising on rugstudio.com)
**Prototype:** `demo/` — live, verified on desktop and mobile

---

## 1. The insight that determines the whole economic model

ripxotic's AR pipeline (`tools/make-ar-model.ts`) exists because a Lotus Emira is **2.29 million
triangles**, and iOS rebuilds an *uncompressed* USDZ on-device at tap time. The full-resolution
model produced a 200 MB tap-time payload that Quick Look rejected. Solving that required
per-material simplification, a triangle budget, and a per-SKU sidecar build pipeline.

**None of that applies to a rug.** A rug is a flat extruded outline:

| Shape | Triangles | GLB payload |
|---|---:|---:|
| Rectangle / square / runner | 12 | ~251 KB |
| Octagon | 28 | ~252 KB |
| Round (96-segment) | 380 | ~267 KB |

Every one of those payloads is >99% **rug photograph**. The geometry is ~2 KB.

Two facts verified against RugStudio's live site make this decisive:

1. **Their images are already on Cloudinary and serve `access-control-allow-origin: *`.**
   A browser can fetch them cross-origin, and we can copy the JPEG bytes into a GLB without
   decoding them. No image byte ever has to transit our infrastructure.
2. **Their own spec sheet publishes pile thickness as "approx: 1/4 inch."** The depth we need
   is data they already have.

Therefore the AR asset can be assembled **client-side, per view, in under a millisecond**
(measured: 0.5–0.7 ms). There is no model pipeline, no per-SKU preparation, and no per-SKU
storage. Marginal cost per AR session rounds to zero.

## 2. Architecture

```
rugstudio PDP  ──<script src="…/t/rugstudio/v1.js" async>──►  our edge (one static file)
      │
      │  RugAR.configure({ sku, imageUrl, width, length, shape, thickness })
      │  ── fired on every size / shape change
      ▼
  [ snippet — 14.3 KB raw, 6.0 KB gzipped ]
      ├─ fetch the rug photo DIRECT from res.cloudinary.com   (CORS *, their egress)
      ├─ assemble GLB in-browser: extrude(outline, ¼") + embed JPEG bytes verbatim
      ├─ mobile  → model-viewer → Quick Look (iOS) / WebXR + Scene Viewer (Android)
      └─ desktop → QR handoff to the phone
      │
      └─ one beacon per AR activation ──► Worker ──► Analytics Engine
```

### Design decisions that matter

**Shape is geometry, not an alpha mask.** A round rug is a clipped disc, not a rectangle with
transparent corners. This keeps us on opaque JPEG — which is what the retailer already serves,
and roughly half the bytes of PNG — and means we never touch a canvas or decode an image.

**`f_jpg` is a correctness constraint, not a preference.** Cloudinary's `f_auto` would hand us
AVIF at ~121 KB versus JPEG's ~254 KB. But glTF core and USDZ accept JPEG and PNG only; WebP
needs `EXT_texture_webp`, which Quick Look does not implement. Requesting AVIF for the AR
texture would render the rug **untextured on iPhone**. AVIF is used for the 2D preview, where
it is safe.

**The AR payload is built eagerly, never at tap time.** iOS only honours `activateAR()` inside
the user gesture that triggered it. Anything awaited at tap time makes AR silently no-op. The
same discipline ripxotic documents in `src/viewer/ar-share.ts`.

**We hand-write the GLB rather than using three.js.** The geometry is a known convex extrusion,
so serialising the container directly costs ~120 lines. three.js + GLTFExporter is ~600 KB;
our whole snippet is 6 KB gzipped. On a widget that runs on someone else's product page, that
difference decides whether it is shippable.

**Desktop preview uses CSS 3D, not WebGL.** A rug is planar, so a perspective-transformed image
on a rotated floor plane *is* a correct projection. Zero library bytes. The sofa is a sibling
of the rug inside the same floor plane, so both share one pixels-per-inch scale — an 84" sofa
is drawn 84" wide. That is what makes the size comparison honest rather than decorative.

**`ar-scale="fixed"`.** A rug has one true size. Letting the user pinch-resize it in AR would
destroy the only thing the feature is for.

### Verified behaviour

`model-viewer` independently reports the generated model as **1.6002 m × 0.00635 m × 2.3114 m**
= exactly **63″ × 0.25″ × 91″** for the 5'3"×7'7" selection. All five shapes parse cleanly under
`@gltf-transform`'s reader.

### Known limitation: texture aspect vs. selected size

Rug photography is shot once per SKU and reused across sizes. ARA587P's photo is 1:1.374
(trimmed), but its 8'×10' is 1:1.25 and its 5'3"×7'7" is 1:1.444. We fit the texture to the
selected size's aspect, so a pattern is mildly stretched on sizes far from the photographed one.
This is standard practice across the category and is invisible for abstract/distressed patterns
(most of the catalogue). It is visible on strict geometrics and bordered orientals. If the
retailer supplies per-size imagery, we use it — the `imageUrl` parameter is already per-call.

## 3. Architecture options costed

| | ① Edge-Thin | ② Edge-Bake | ③ Full SaaS |
|---|---|---|---|
| AR asset built | in browser | in a Worker, cached in R2 | as ② |
| Device coverage | modern mobile | universal | universal |
| Shareable asset URL | no | yes | yes |
| Infra COGS / mo | ~$50 | ~$54 | ~$80 |
| Build | done | +2–3 wks | +3–6 mo |

**Recommendation: ① as the product, ② as an automatic fallback.** >90% of sessions cost nothing;
the fallback tail is cheap and buys universal coverage plus permalink assets for email/ads.

### Cache policy — a correction to the brief

The brief proposed caching generated assets for one week. **Expiring costs more than keeping.**
R2 storage is $0.015/GB-month; one cached asset pair is ~514 KB ≈ **$0.0000077/month**. A weekly
expiry throws away work that costs essentially nothing to retain and forces regeneration of the
long tail forever.

Instead: key the cache on the **source image's ETag** (Cloudinary already returns a strong one),
retain indefinitely, and revalidate stale-while-revalidate. Same freshness guarantee, none of
the re-work.

## 4. Off-catalogue SKUs

Rugs not on rugstudio.com need a home. The brief's options A/B/C, plus one it does not contain:

- **A — they upload to their own site.** Our cost: zero. Their cost: merchandising labour.
  *Preferred where they will do it.*
- **B — we host images, integrate their existing site.** ~3–4 weeks; +$2/mo infra; ~$400/mo
  content QA. Good middle path.
- **B+ — hosted AR catalogue microsite, browse-and-inquire (new).** A branded URL for
  off-catalogue rugs with AR, a lead form, and no cart. Avoids payments, tax, fraud, PCI, and
  returns entirely — roughly 20% of ③'s build for most of its benefit.
- **C — we build full shopping UX.** 3–6 months and a different product. *Steer to B+.*

## 5. Build status

Working and verified: GLB writer (5 shapes, validated against a real glTF reader), size parser
(12 real-world formats), Cloudinary transform rewriting, straight-to-AR mobile path, desktop QR
handoff, CSS-3D true-scale preview, developer view.

Not built (production work), in priority order:

1. ~~Hand-written USDZ writer~~ — **BUILT.** Emits horizontal plane anchoring
   (`preliminary:anchoring:type="plane"`), the main fix for rugs placing mid-air on iPhone,
   and is handed to Quick Look via `ios-src` so model-viewer's own conversion is bypassed.
   Costs 1.8 KB gzipped. Container validated (STORED, 64-byte-aligned, default layer first,
   texture bytes unaltered) but **USD semantics are not machine-verified** — it ships behind a
   toggle for on-device A/B. See `../ar-placement-and-scale.md`.
2. **Our own WebXR session** on Android — hit-test as a required feature, surface-normal and
   floor-plausibility filtering, and a scan-the-floor reticle.
3. Worker for beaconing, tenant config/licensing, and the Edge-Bake fallback.
4. Per-size imagery where the retailer has it.

Also built since: a server-side **SKU resolver** (`/api/extract`) that turns a pasted product-page
URL into name + image. It exists because rugstudio.com serves its HTML without CORS, so a browser
cannot read a PDP — their *images* do send CORS, which is why the AR asset itself still needs no
server of ours. The resolver is an onboarding/demo convenience; a live integration passes the same
data straight to `RugAR.configure()`.
