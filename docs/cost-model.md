# RugAR — hosting & COGS model

**Customer:** ORGTX / RugStudio — **anchor customer**, so every fixed cost lands on this deal.
**Prices:** Cloudflare list, at time of writing. Re-verify before contracting.
**Traffic:** three scenarios, agreed as reasonable for a site of this size. These are
assumptions, not measurements — the first thing the pilot should produce is the real number.

| Scenario | Widget loads / mo | AR activations / mo (~10%) |
|---|---:|---:|
| Conservative | 250,000 | 25,000 |
| Base | 1,000,000 | 100,000 |
| Aggressive | 4,000,000 | 400,000 |

---

## 1. The headline: infrastructure is not the cost

Because the AR asset is assembled in the browser from the retailer's own CDN image, our servers
carry **one static JS file and one analytics beacon**. Nothing scales with rug images, because
we never touch them.

### Option ① Edge-Thin — variable cost

| Line | Unit price | Conservative | Base | Aggressive |
|---|---|---:|---:|---:|
| Snippet delivery (Workers Static Assets) | free, unmetered | $0 | $0 | $0 |
| Tenant config (baked into the per-tenant JS) | free | $0 | $0 | $0 |
| Rug imagery | *their* Cloudinary egress | $0 | $0 | $0 |
| AR asset generation | in-browser | $0 | $0 | $0 |
| Beacon requests | $0.30/M over 10M incl. | $0 | $0 | $0 |
| Analytics Engine writes | $0.25/M | $0.07 | $0.28 | $1.10 |
| **Variable total** | | **$0.07** | **$0.28** | **$1.10** |

Even at 4M widget loads a month, variable infrastructure is **about a dollar**.

### Fixed infrastructure (per month)

| Line | Cost |
|---|---:|
| Cloudflare Workers Paid | $5 |
| Domain / DNS (amortised) | $1 |
| Error tracking (Sentry Team) | $26 |
| Uptime & synthetic monitoring | $10 |
| Secrets, CI, misc | $5 |
| **Fixed total** | **~$47** |

> **Infrastructure COGS ≈ $50/month at any of the three scenarios.**

### Option ② Edge-Bake — the "expensive" architecture

Pre-baking GLB + USDZ for the **entire 350,000-SKU catalogue** (×1.2 shapes = 420,000 asset
pairs, ~514 KB each):

| Line | Calculation | Cost |
|---|---|---:|
| R2 storage, full catalogue | 216 GB × $0.015 | **$3.24/mo** |
| R2 egress | R2 charges none | **$0** |
| Class A writes (one-time) | 840k × $4.50/M | $3.78 once |
| Generation CPU (one-time) | 138M CPU-ms × $0.02/M | $2.76 once |
| Image ingress | 107 GB, free on Cloudflare | $0 |
| Class B reads @ Base | 300k × $0.36/M | $0.11/mo |

Lazily generated (only ~10–15% of a long-tail catalogue sees traffic in a month), storage starts
nearer **$0.50/mo** and grows toward $3.24.

> **Option ② adds ~$4/month.** The architecture that *sounds* expensive is a rounding error.

### Option ③ Full SaaS — added infrastructure

Off-catalogue image hosting for 50,000 SKUs at ~2 MB all-in ≈ 100 GB → **$1.50/mo**. D1 catalogue
at this scale is inside the included tier. Total added infra: **~$25/month**.

**Option ③'s cost is not infrastructure. It is people.** See §2.

---

## 2. The cost that is actually real

At this scale, servers are noise. The genuine recurring costs are labour.

| Line | Hours/mo | Rate | Cost/mo |
|---|---:|---:|---:|
| Maintenance engineering — AR platform regressions (iOS/Android ship Quick Look, Scene Viewer and WebXR changes that break things), retailer template drift, CDN changes | 10–16 | $125 | $1,250–2,000 |
| Support & account management | 4–6 | $125 | $500–750 |
| On-call / incident allowance | — | — | $200 |
| **Labour total** | | | **$2,000–2,950** |

Maintenance engineering is not padding. Quick Look and Scene Viewer both have a track record of
regressions on OS releases, and a widget living inside someone else's template breaks when that
template changes. Budget for it or it becomes an unbudgeted fire.

### Two COGS numbers, and why the distinction decides the pricing

Standard SaaS accounting puts hosting, support and customer success in COGS, and product/
maintenance engineering in R&D — *below* the gross-margin line.

| Basis | Monthly | What it is for |
|---|---:|---|
| **Gross-margin COGS** (infra + support) | **~$650** | The number to quote as gross margin |
| **Fully-loaded cost** (+ maintenance eng.) | **~$2,650** | The number that decides the walk-away price |

> **This is the single most important line in this document.** "3–10× margin" means
> **$1,950–$6,500/mo** on the gross basis, but **$8,000–$26,500/mo** on the fully-loaded basis.
> Choosing the basis, not the multiplier, is what sets the price.

### Anchor-customer effect

RugStudio is customer #1, so they carry 100% of fixed cost. At ten customers the $47 infra and
the $2,000 maintenance amortise, and per-customer fully-loaded COGS falls to roughly **$800/mo**.
Margin on the same price roughly triples. **Price this deal on anchor economics, not on the
platform economics you hope to have in two years** — but know the second number, because it is
the floor you can defend if they push hard.

---

## 3. Cost of the off-catalogue options

| | A: they upload | B: we host images | B+: AR microsite | C: full shopping UX |
|---|---|---|---|---|
| Our build (one-time) | $0 | ~$18k (3–4 wks) | ~$25k (4–5 wks) | $90–150k (3–6 mo) |
| Added infra / mo | $0 | +$2 | +$5 | +$25 |
| Added ops / mo | $0 | ~$400 | ~$400 | $3,000–4,000 |
| Their effort | high | low | low | none |
| Carries payments/tax/fraud/PCI | no | no | **no** | **yes** |

**C is a different company, not a bigger feature.** Once you take the cart you take chargebacks,
sales tax nexus across their states, fraud, and returns support. Steer to **B+**: it gives
off-catalogue rugs a real URL with AR and a lead form, at ~20% of C's build and none of its
liability.

---

## 4. Cost scaling — the shape to take into the meeting

- **Cost does not scale with AR usage.** 16× the traffic changes the bill by about $1.
- **Cost does not scale with catalogue size** in Edge-Thin, and scales at
  **~$0.0000077 per SKU-shape per month** in Edge-Bake.
- **Cost scales with customers and with support load** — i.e. with headcount.

The practical consequence: **any pricing metric tied to clicks or SKUs is a value metric, not a
cost-recovery metric.** That is fine, and normal in SaaS — but it must be chosen and defended on
value, because a cost-based defence will not survive the first procurement question.
