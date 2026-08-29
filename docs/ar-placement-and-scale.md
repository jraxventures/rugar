# Controlling AR placement and scale

Two failure modes decide whether shoppers trust this feature: **the rug floating in mid-air**,
and **the shopper pinch-zooming it to a size that isn't real**. The second is already solved.
The first needs work we had already scoped for other reasons.

All findings below were read out of the shipped `@google/model-viewer` 4.3.1 bundle, not from
documentation.

---

## 1. Accidental scaling — already locked

`ar-scale="fixed"` is set on the AR bridge (`ensureBridge()` in `rugar.js`). Verified behaviour:

| Platform | What model-viewer emits | Effect |
|---|---|---|
| iOS Quick Look | appends `#allowsContentScaling=0` to the USDZ object URL | pinch-to-resize disabled |
| Android Scene Viewer | `resizable=false` on the `intent://arvr.google.com/scene-viewer/1.2` URL | resize disabled |
| WebXR (Chrome Android) | model-viewer places at 1:1 and ignores scale gestures | true size preserved |

Two caveats worth knowing before you promise it:

- **Rotation and repositioning stay enabled on all three.** That is correct for a rug — people
  do want to spin it and slide it — and there is no flag to disable rotation. Turning that off
  would mean owning the WebXR session (§3).
- **Scene Viewer is Google's UI.** It honours `resizable=false` today; we don't control that
  surface. Quick Look's `allowsContentScaling` is a documented URL fragment and is the more
  durable of the two.

## 1b. Device reality check

Tested on a **Galaxy S22 Ultra**. Worth being precise about what that device is, because it
changes the diagnosis:

- **No LiDAR, no ToF.** No Galaxy S-series has one; Samsung dropped ToF after the S20 Ultra.
  The S22 Ultra's *laser autofocus assist* is a single-point rangefinder for camera focus — it
  produces no depth map and feeds nothing to ARCore.
- **But it is a 2022 flagship**, fully ARCore-certified, and among the better-supported devices
  for the **ARCore Depth API** (software depth-from-motion, no depth sensor required).

So poor AR here is **not** a hardware ceiling. It is the path we were taking. That raises the
expected return on owning the session rather than writing the result off as an old-phone problem.

## 1c. The Android path was silently crippled

`ar-modes="webxr scene-viewer quick-look"` looks like it provides a fallback. It did not.

Scene Viewer runs as a **separate Android app** and is handed the model as
`intent://arvr.google.com/scene-viewer/1.2?…&file=<url>`. Our GLB was a `blob:` URL, which is
scoped to the page's origin — the Scene Viewer app cannot fetch it. Scene Viewer was therefore
**unreachable**, leaving model-viewer's minimal WebXR reticle as the only Android path, with no
onboarding and no fallback.

**Fixed:** each generated GLB is now POSTed to `/api/asset`, which content-addresses it and
returns a real https URL (`model/gltf-binary`). Scene Viewer works from that. This is exactly
the Edge-Bake fallback the cost model already budgets (~$3/month for the full catalogue) — the
architecture anticipated it; we simply had not wired it.

## 2. Mid-air placement — causes

1. **Plane detection hasn't converged when the user taps.** By far the most common. The user
   raises the phone and taps immediately; ARKit/ARCore has no plane yet.
2. **The hit-test returns a feature point, not a plane.** Sparse feature points float.
3. **model-viewer requests hit-test as an *optional* feature.** In the bundle:
   `requestSession("immersive-ar", { requiredFeatures: [], optionalFeatures: ["hit-test", …] })`.
   A session can therefore start on a device where hit-test is unavailable, and placement
   degrades to a fixed distance in front of the camera — which *is* mid-air, by construction.
4. **Quick Look with no anchoring hint** will accept whatever surface it finds, including
   vertical ones.

## 3. The levers, by platform

### iOS Quick Look — no runtime control at all

Worth stating plainly: **Quick Look owns the AR session.** We hand it a USDZ and get no
callbacks, no anchor management, no placement hooks. Safari does not support WebXR
`immersive-ar`, so on iPhone there is no alternative web path — the only way to get true floor
lock on iOS is a native app.

That is why the reported symptom splits the way it does: placement is good (our plane anchoring
works), but **dragging re-anchors** and can float, and we cannot intercept that. Within Quick
Look the only mitigations are to make first placement good enough that dragging is rarely
needed. The plane-anchoring and explicit `extent` below are what we can do; they will not
eliminate drag-float.

### iOS USDZ — what we can set

USDZ carries Apple's "preliminary" anchoring schema:

```
preliminary:anchoring:type          = "plane"
preliminary:planeAnchoring:alignment = "horizontal"
```

Set these and Quick Look will only anchor the rug to a detected **horizontal** plane, which
removes the mid-air and wall cases directly.

**model-viewer's on-device GLB→USDZ conversion does not emit them**, and there is no attribute
to make it. The only way to set them is to generate the USDZ ourselves.

> This makes the custom USDZ writer a **correctness fix, not just a size optimisation.** It was
> already on the roadmap to drop model-viewer's ~1 MB dependency down to ~8 KB; it now also buys
> the single most effective fix for mid-air placement on iPhone. It should move up the list.
>
> It needs validating on a real iPhone — I can generate and inspect the USDZ, but I cannot
> confirm Quick Look's behaviour without a device.

### Android WebXR — requires owning the session

Replacing model-viewer's AR path with our own WebXR session gives us:

- **`hit-test` as a `requiredFeature`**, so a device that can't do it fails loudly with an
  explanation instead of silently placing the rug in the air.
- **Normal filtering** — reject any candidate pose whose surface normal is more than ~15° off
  vertical. A rug never goes on a wall or a sloped surface.
- **Floor-plausibility filtering** — require the hit to sit roughly 0.6–2.2 m below the camera.
  That is where a floor is when someone is holding a phone; a tabletop or countertop is not.
- **A minimum plane extent** (~1.5 m²) before the place button becomes active. A 9'×12' rug
  needs real detected floor, not a postage stamp.
- **A reticle and a "move your phone to scan the floor" prompt**, so the tap only becomes
  possible once placement will actually succeed. This alone removes cause #1.
- **`depth-sensing`** — the S22 Ultra supports the ARCore Depth API, so this is available and
  gives both real occlusion and a far better floor estimate than hit-test alone.

**Floor selection — corrected.** An earlier draft of this document said to take `min(y)`, the
lowest horizontal plane. **That is wrong**, and device testing proved it: the rug was observed
latching onto a flat *moulding ledge running along a pillar*, then snapping back to the floor
when moved. A moulding is horizontal, is tiny, and is not even the lowest thing in the room —
which shows the selector has no area gate at all and is simply taking whatever plane the
reticle ray happens to hit.

Area is the discriminator, not height. A pillar moulding is ~0.1 m², a window sill ~0.2 m², a
chair seat ~0.4 m², a coffee table ~0.5 m², a sofa ~1.2 m² — a living-room floor is 8–20 m².
Nothing else in a room comes close. Ranking:

1. Horizontal and upward-facing (`XRPlane.orientation === 'horizontal'`).
2. **Reject anything under ~1.5–2 m².** This one gate eliminates mouldings, sills, seats and
   tables outright.
3. Of the survivors, **largest polygon area wins.** That is the floor.
4. Tie-break *only* when two candidates are within ~10% area of each other: take the lower Y.
   This handles a floor detected as two separate patches.
5. Sanity check: 0.6–2.2 m below the camera.
6. **Freeze on accept.** No re-evaluation unless the user explicitly asks.

**Why an anchor alone is not enough — the squat test.** The most diagnostic report from device
testing: *lock the rug to the floor, squat down, then slowly stand up, and the rug lifts off the
floor.*

That is not the object drifting relative to the plane. It is **the plane's own pose being
revised.** Squatting radically changes the viewing angle and parallax on the floor; as you rise,
ARCore refines its plane-height estimate, and everything anchored to that *plane trackable*
moves with it.

So the anchor must not be attached to the plane. Capture the accepted pose once into the
`local` reference space and render there, ignoring every subsequent plane update. VIO drift over
a few seconds of movement is centimetres; plane re-estimation error is 10–30 cm. Freezing in
world space is the difference.
3. **On drag, do NOT re-run a hit-test.** Intersect the screen ray with the *frozen* floor plane
   (plain ray-plane maths) and move only in X/Z. Y never changes after lock. This is what kills
   drag-float outright, and it is the single highest-value line of the whole design.
4. Offer an explicit **"Re-scan floor"** control so re-assessment is a deliberate user action,
   never something ARCore does on its own mid-session.

### Android Scene Viewer — occlusion was suppressed, lock is not available

**Occlusion (fixed).** model-viewer force-disables depth occlusion on every Scene Viewer launch:

```js
s.has("disable_occlusion") || s.set("disable_occlusion","true")
```

That is why the rug rendered *on top of* real furniture on Android instead of disappearing under
it. The guard reads parameters off our own `src` URL, so carrying `?disable_occlusion=false` on
the hosted model URL is the only way to opt back in. Now shipped. The S22 Ultra supports the
ARCore Depth API, so occlusion is genuinely available once it stops being suppressed.

**Lock (not available).** Device testing settled this: Scene Viewer — Google's own app, with
ARCore's best tuning — still does not lock to the floor. That is decisive. The absence of a lock
is not a deficiency in our WebXR usage; **neither Android path exposes one.** Owning the session
is the only route, and the squat test above says exactly what that session must do.

## 4. The advantage we have that a general AR viewer doesn't

A generic furniture viewer must support tables, walls, shelves and floors, so it cannot reject
many candidate surfaces. **A rug is always on the floor and always horizontal.** That lets us be
far more aggressive than a general viewer: reject every non-horizontal plane outright, and snap
to the lowest confident horizontal plane in the room. Constraint is the feature here.

## 5. What not to do

Commercial AR SDKs (8th Wall, Zappar and similar) give more placement control and better
tracking, and they are **priced per view**. Our marginal cost per AR session is currently about
$0.0000025 — one analytics write. Moving to a per-view SDK changes that by orders of magnitude
and turns a near-zero variable cost into the dominant line item, which would invalidate the
pricing model in `pricing-strategy.md`.

That is a business decision wearing a technical costume. If placement quality ever justifies it,
re-run the cost model first.

## 5b. The custom session — BUILT

`demo/assets/rugar-xr.js` (9.5 KB raw / 4.1 KB gzipped, lazily loaded only on Android when
selected). Raw WebGL — the rug is a textured quad, so no 3D library is involved.

| Behaviour | Implementation |
|---|---|
| Floor selection | Area-ranked. ≥1.5 m² gate, largest wins, lower-Y tie-break only within 10% area, 0.6–2.2 m below camera |
| The lock | Pose captured once into `local` space; `floorY` is never written again |
| Drag | Transient-input hit-test supplies **X and Z only**; Y is structurally unable to change |
| Rotate | Two-finger, from the angle between both fingers' world-space hits |
| Onboarding | Scan prompt with live m² readout; Place disabled until a real floor qualifies |
| Re-assessment | Only via an explicit "Re-scan floor" button |
| hit-test | **Required**, not optional — fails with an explanation rather than placing mid-air |
| No plane-detection | Falls back to a dwell test: height steady for 1.8 s, lower-quartile sample |

**Verified without a device:** the floor selector passes 6/6 unit tests, including the pillar
moulding and a spurious sliver *below* the floor — the latter being the case that proves the
earlier `min(y)` design would have failed.

**Not verified:** the session itself. Nothing in a desktop browser can exercise ARCore.

**Deliberately not included: depth occlusion.** It needs a GPU depth-texture shader that cannot
be validated off-device, and a wrong one makes the rug vanish entirely rather than degrade. So
the two Android modes currently trade off — Scene Viewer has occlusion but cannot lock; RugAR
locks but does not occlude. Once the lock is confirmed on hardware, occlusion is the next piece.

## 6. Status and order of work

**Built:** the custom USDZ writer, wired to `ios-src` and switchable at runtime
(`?usdz=mv`, or the on-page toggle) so both iOS paths can be compared on one device.
Container constraints are verified mechanically; the USD content itself is not, because no
USD parser is available off-device — hence the toggle.

1. ~~Custom USDZ writer with horizontal plane anchoring~~ — **done; needs a device test.**
2. **Own the WebXR session** with normal + floor-plausibility filtering and a scan-the-floor
   reticle — fixes Android, and is where most of the remaining quality lives.
3. Leave Scene Viewer as the untuned fallback.
4. Re-test on real devices after each. None of this is verifiable in a desktop browser.

---

## 7. Occlusion by floor segmentation, not depth

The depth route was parked because a GPU depth shader can't be validated off-device. There is a
better route for **this specific product**, and it is worth recording properly.

**The insight.** A rug is coplanar with the floor. So we never need to know how far away the
couch is — only which pixels are floor. Run a lightweight semantic segmentation model
(MediaPipe/TFLite class; ADE20K includes a floor class), render the rug on the locked plane as
now, then composite it **only where the mask says floor**. Every non-floor pixel hides the rug,
so it passes under furniture, behind table legs, and stops at the wall.

This is the same constraint-exploitation as the floor lock: a general AR viewer cannot assume
its object lies on one known plane, so it needs metric depth. We can, so we don't. For a rug the
mask is a strictly binary question, which is a far easier problem than depth estimation and has
crisper edges at object boundaries.

**Platform reality — this is NOT one code path across iOS and Android on the web.**

| Target | Frame access | Compositing hook | Segmentation occlusion |
|---|---|---|---|
| Android, our WebXR session | yes, via the `camera-access` feature | ours | **works** |
| iOS Safari | none — no WebXR `immersive-ar` | n/a | **impossible** |
| iOS Quick Look | none — system viewer, black box | none | **impossible** |
| iOS native app | ARKit frames | ours | works |

Quick Look hands us no frames and no draw hook, so occlusion parity on iPhone requires a
**native app**. That is a roadmap and pricing input, not a detail: today iOS gets ARKit's own
occlusion (good on LiDAR-equipped Pro models, weaker without), and matching Android's
segmentation occlusion means leaving the web on iOS.

**Cost.** The model is a static asset of a few MB, served from the edge and cached. On
Cloudflare's static-asset tier that is unmetered, so it does **not** disturb the near-zero
marginal COGS in `cost-model.md` — worth stating plainly, because a multi-megabyte model sounds
like it should. The real costs are battery/thermal (inference competes with ARCore for the GPU;
10–15 fps with temporal smoothing is the sane target, not 30) and the engineering itself.

**Known failure modes to budget for:** mask edges crawl without temporal smoothing; an existing
rug or mat may be classified as floor (mostly benign here — drawing over it is the desired
result); low light degrades the mask; and `camera-access` needs explicit permission and is not
universally available.


---

## 8. Occlusion — what was built, and why not the model (yet)

**Shipped: a depth-derived floor mask, in the custom Android session.**

The reason it is not a semantic model is worth stating, because the segmentation argument is
correct and this still follows from it. The insight that makes segmentation work — *the rug is
coplanar with the floor, so every pixel is a binary floor/not-floor question* — means comparing
scene depth against the rug's own fragment depth yields **the same mask**, since the rug sits at
floor depth. Identical result, with:

| | depth mask (shipped) | semantic model |
|---|---|---|
| Bytes to download | **0** | several MB |
| Inference budget | none | 10–15 fps, competes with ARCore for GPU |
| Licensing | none | model-dependent |
| Thin objects (chair legs) | depends on depth resolution | better |
| Beyond depth range (~5 m) | fails | works |
| Dark rooms | degrades | degrades |

So depth is the cheaper hypothesis and it ships today. If it proves inadequate the diagnostics
will say *why*, and the semantic mask drops into the same shader slot.

**Built with the untestability in mind**, since none of this can be exercised off-device:
- `Occlusion: on/off` toggle in the AR overlay — instant A/B on the phone.
- `Mask` debug view — renders the computed mask instead of the rug (red = occluded, green =
  floor, blue tint = decoded metres). A wrong depth decode shows up as visible nonsense rather
  than as a mysteriously invisible rug.
- `OCCL_BIAS` of 5 cm, because the floor sits at essentially the rug's own depth; without slack
  the rug occludes against the very surface it lies on and flickers away.
- Every failure degrades to *no occlusion*, never to a blank screen.
- Session request retries without `depth-sensing` if the runtime refuses the dictionary — an
  optional feature must not cost us the session.

**Diagnostics** are emitted on session end (`rugar:xr-diag`) and shown on the page with a copy
button: depth availability/resolution/scale, plane count, chosen and mapped floor area, tilt,
floor height, corrections applied, jumps rejected, fps, GL context and texture dimensions.

## 9. Building a SLAM engine in-house — the arithmetic

Raised as a final option. The honest answer is that it is economically indefensible at this
customer's volume.

A markerless web SLAM engine means visual-inertial odometry in WASM: feature detection and
tracking, IMU fusion (with per-device calibration), pose estimation, bundle adjustment, plane
fitting — at 30 fps on a phone. On iOS it is harder still, because Safari gates `DeviceMotion`
behind a permission prompt and rate-limits it. This is a specialist computer-vision team for
12–24 months; it is what the commercial vendors spent years and serious funding building.

Against that, licensing costs roughly **$6.6k/year** at 1¢/view and 55k iOS sessions a month,
or ~$33k/year at 5¢. A build of even $600k pays back in **twenty to ninety years**.

It only becomes rational if the engine itself is the product, licensed across many customers at
scale — a different company than the one being priced in `pricing-strategy.md`. For this deal:
license it, or accept Quick Look's limits on iOS.

---

## 10. Entry-level Android: what the Galaxy A17 diagnostics showed

First run on genuinely low-end hardware (Galaxy A17, Android 10, Chrome 149). The diagnostics
blob earned its keep — it found three defects, two of them mine, that no amount of desktop
testing would have surfaced.

```json
{"space":"local", "depth":"error: Depth sensing feature is not supported by the session.",
 "planes":5, "chosenArea":5.09, "mappedArea":11.92, "tiltDeg":0, "floorY":-2.0183,
 "corrections":64, "jumpsRejected":110, "fps":8}
```

**1. `getDepthInformation` was throwing every frame — and was never latched off.** On a device
without depth-sensing this constructs, throws, catches and string-concatenates a DOMException
once per view per frame, indefinitely. A self-inflicted performance fault dressed up as a
device limitation. Now: `session.enabledFeatures` is consulted up front, and any failure
disables depth permanently for the session.

**2. `local-floor` was never actually requested.** The code called
`requestReferenceSpace('local-floor')` and fell back on rejection — but the feature was absent
from `optionalFeatures`, so it could never be granted and the fallback fired every time. The
comment in the source even claimed it was requested. `space:"local"` in the diagnostics is the
proof. Fixed in both request paths.

**3. 110 rejections against 64 corrections — the rug had stopped tracking the floor.** The
jump-rejection rule assumed disagreement is transient. Sustained disagreement is not an
artefact; it is ARCore having genuinely re-estimated the floor, and refusing it forever strands
the rug at a stale height. Now: continuous disagreement for longer than `RELOCK_MS` (2.5 s) is
accepted as a real re-estimate.

**Performance changes:** MSAA disabled (12 triangles gain nothing from it and budget GPUs pay
full fill-rate cost), `framebufferScaleFactor` 0.8 by default, dropping automatically to 0.6 if
measured fps stays under 14. A legible 20 fps beats a crisp 8.

### The strategic finding

Even with all of the above fixed, **an entry-level phone is a poor host for a browser-based
WebXR session.** Scene Viewer is a native Android app with access to optimisations a WebGL
canvas in Chrome cannot reach, and it will outperform our session on this class of device by a
wide margin.

That argues for **routing by device capability rather than picking one Android path**:

| Device class | Path | Trade |
|---|---|---|
| Capable Android (S22-class and up) | RugAR session | floor lock, occlusion where depth exists |
| Entry-level Android | Scene Viewer | usable frame rate, no lock |
| iOS | Quick Look | ARKit's own tracking; no lock available |

The honest read is that the floor lock is a **premium-device feature**. On hardware where
ARCore itself is struggling, the right answer is not a better lock — it is handing the session
to the platform's own optimised viewer and accepting what it gives.


---

## 11. Device-tier routing (A17 follow-up)

Second A17 run, after the depth/local-floor/relock fixes: **Scene Viewer was faster, smoother
and better overall — and best with "object blending" OFF.**

That last detail matters, because the code was forcing blending ON. `disable_occlusion=false`
was added to fix the S22 Ultra rendering the rug *over* furniture. On the A17 it is the wrong
call: no depth sensor, weak compute, so ARCore's software depth costs frames and adds artefacts.
**One global default is wrong for one of these phones whichever way it is set.**

So both the AR path and the blending flag are now chosen by device tier:

| | entry-level (A17) | capable (S22 Ultra) |
|---|---|---|
| Android path | Scene Viewer | RugAR session |
| Scene Viewer blending | off | on |
| Floor lock | not available | yes |

Tier comes from `navigator.deviceMemory` (Chrome buckets it, so a 4 GB budget phone reports 4
and a 12 GB flagship reports 8), falling back to core count. Core count alone cannot separate
them — budget SoCs ship eight weak cores. Both can be overridden by hand in the demo for A/B.

### What this means commercially

**The floor lock is a premium-device feature.** On hardware where ARCore itself is struggling,
the answer is not a better lock — it is handing the session to the platform's own optimised
native viewer and accepting what it gives.

That is worth establishing before the customer meeting. If RugStudio's shoppers skew toward
budget Android, most of them will land on Scene Viewer, and the differentiator is the
zero-onboarding catalogue coverage rather than placement quality. **Ask them for device-mix
data from their analytics** — it changes what should be demoed and what should be promised.
