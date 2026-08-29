# RugAR — pricing strategy

**For:** business partner, to decide viability and take to ORGTX / RugStudio.
**Reads with:** `cost-model.md`. The two COGS bases defined there drive everything here.

---

## 1. Recommendation in one paragraph

Price on **platform fee tiered by catalogue size, with a generous included AR-session band as a
guardrail rather than a meter, plus a per-store licence** that captures their multi-store
footprint. Land RugStudio at **$6,500/month + $18,000 one-time integration**, after a
**90-day paid pilot at $2,500/month** that produces the conversion and return-rate numbers which
justify the full price. Do **not** price per click.

---

## 2. Why not per click

The brief floated "base fee + every click." It is the intuitive option and it is the wrong one.

**It is indefensible on cost.** Our marginal cost per AR session is roughly **$0.0000025** — one
analytics write. Charging $0.02/session is an ~8,000× markup on a cost basis. That is fine right
up until a procurement analyst asks what it costs us to serve, and then it is a credibility
problem in a renewal negotiation.

**It pays the retailer to hide the feature.** Per-click makes their marginal cost rise with
engagement. The rational response is to de-emphasise the button — destroying the exact behaviour
we are selling. Never make the customer's cost scale with the thing you want them to do more of.

**It makes the invoice unpredictable.** A viral TikTok becomes a shock bill and a churn
conversation. Finance teams renew predictable line items.

**Keep the band, drop the meter.** Include a generous session allowance and charge overage only
far above it. That protects us from a pathological case without turning engagement into a tax.

## 3. Why catalogue size and stores

- **SKU count is the number they already anchor on.** They told you "350,000 SKUs" unprompted.
  Pricing on a number the customer volunteers is pricing on a metric they have already accepted.
- **It is stable and predictable in both directions**, and it is the honest driver of our
  onboarding and support cost.
- **Per-store captures value we would otherwise give away.** They operate multiple physical
  stores centralising on rugstudio.com. The same widget lets an in-store associate put a rug on
  the customer's floor from a tablet — and lets a customer photograph their own room at home and
  see it in-store. That is a second, separate value pool. Charge for it.

## 4. The tiers

| Tier | SKUs | Included AR sessions/mo | Price/mo |
|---|---:|---:|---:|
| Launch | 25,000 | 250,000 | $1,500 |
| Growth | 100,000 | 1,000,000 | $3,500 |
| **Enterprise** | **350,000+** | **4,000,000** | **$6,500** |

**Add-ons**
| Item | Price |
|---|---|
| One-time integration & onboarding | **$18,000** |
| In-store licence, per physical location | **$150/mo** |
| Off-catalogue image hosting (option B) | **$500/mo per 25,000 SKUs** |
| Hosted AR catalogue microsite (option B+) | **$1,200/mo** + $25,000 build |
| Session overage above band | **$0.015** per AR session |

RugStudio lands on **Enterprise — $6,500/mo, $78,000/yr**, plus $18,000 one-time.

### Margin check against both COGS bases

| Basis | COGS/mo | Multiple at $6,500 | Margin |
|---|---:|---:|---:|
| Gross (infra + support) | $650 | **10.0×** | 90% |
| Fully loaded (+ maintenance eng.) | $2,650 | **2.5×** | 59% |

At the top of the requested 3–10× band on the gross basis, and still a healthy 59% operating
contribution after every real cost — in year one, as the anchor customer carrying all fixed cost.
At ten customers the fully-loaded multiple rises to roughly **8×**.

### Negotiating room

| Price/mo | Fully-loaded multiple | Read |
|---:|---:|---|
| $6,500 | 2.5× | Ask. Defensible on value. |
| $5,000 | 1.9× | Comfortable. |
| $4,000 | 1.5× | Acceptable with a 2-year term or a case study. |
| **$2,500** | **0.94×** | **Walk-away.** Below this you fund their AR out of pocket in year one. |

The $2,500 floor is exactly the pilot price — deliberately. The pilot is sold at cost.

## 5. The value argument (fill in their real numbers)

Do **not** lead with our costs. Lead with returns. Rugs are heavy freight and wrong-size is the
top reason they come back.

**The model — illustrative inputs, to be replaced with theirs:**

```
Online revenue                     $30,000,000 / yr
Average order value                $250              → 120,000 orders/yr
Baseline return rate               18%               → 21,600 returns/yr
Net cost per return                $60               (freight both ways, restock, markdown)

Return-rate reduction from AR      2 pts (18% → 16%) → 2,400 fewer returns
                                                     → $144,000 / yr saved

Conversion lift                    0.5% relative     → $150,000 incremental revenue
  at 40% gross margin                                → $60,000 / yr gross profit

                                        Annual value ≈ $200,000
                                        RugAR at $78,000/yr  →  ~2.6× return
```

**These are illustrative, not measured.** Present them as a model with their inputs, and say so
plainly — a fabricated statistic that gets checked costs more than it earns. The honest and more
persuasive move is: *"here is the model; the pilot fills in your real numbers."*

Secondary value to raise if it lands: fewer wrong-size returns also means less freight damage,
less warehouse re-handling, and a measurable drop in "does this look right in my room" support
contacts.

## 6. Recommended deal shape

1. **90-day paid pilot — $2,500/mo.** Top ~5,000 SKUs. Success criteria agreed in writing up
   front: AR engagement rate, conversion delta on AR-exposed sessions, return-rate delta on
   AR-assisted orders. Instrumented from day one — the beacon already exists.
2. **Convert to Enterprise at $6,500/mo** with a 12-month term, pilot fee credited against the
   $18,000 integration.
3. **Expand** into per-store in-store licences and the off-catalogue microsite once the core is
   proven.

This sequence matters: the pilot is priced at our walk-away number, which is cheap for us to
carry and easy for them to approve without a committee — and it produces the measured numbers
that make $6,500 an easy yes instead of an argument.

## 7. What would change this

- **If their traffic is materially below the Conservative scenario**, the value case weakens and
  Growth ($3,500) becomes the right landing tier.
- **If they want C (full shopping UX)**, price it as a separate services engagement, not a tier.
  Do not absorb payments, tax and fraud liability into a SaaS subscription.
- **If a competitor is already quoting per-SKU**, do not follow them into it; 350,000 SKUs makes
  any per-SKU number either absurd for them or worthless for us. Compete on the fact that we
  need **zero per-SKU onboarding** — which is the demo's core claim, and true.
