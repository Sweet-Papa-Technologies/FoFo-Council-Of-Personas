# Council of Personas — Cost Analysis & Pricing

_Measured 2026-06-21 from a real run (4 advisors + peer review + Devil's Advocate +
Chairman). Token counts are empirical; prices are current public rates (mid-2026)._

## Per-run token profile (measured)

| Stage | Model (tier) | Input tok | Output tok |
|---|---|--:|--:|
| 3× advisor seats | Gemini 3.5 Flash | 714 | 3,763 |
| 1× advisor seat | DeepSeek V3.2 (Vertex MaaS) | 238 | 1,254 |
| 4× peer review | Gemini 3.1 Flash-Lite | 21,258 | 4,111 |
| Devil's Advocate | Gemini 3.1 Flash-Lite | 5,255 | 691 |
| Chairman | Gemini 3.1 Pro | 6,156 | 1,225 |
| **Total** | | **~33,400** | **~10,350** |

Peer review dominates **input** (each of 4 reviewers reads the other 3 essays);
the advisor seats dominate **output** (each writes a ~1.2k-token essay).

## Rates used (per 1M tokens)

| Model | Input | Output |
|---|--:|--:|
| Gemini 3.5 Flash (council seats) | $1.50 | $9.00 |
| Gemini 3.1 Flash-Lite (review + DA) | $0.25 | $1.50 |
| Gemini 3.1 Pro (chairman) | $2.00 | $12.00 |
| DeepSeek V3.2 (Vertex MaaS) | $0.56 | $1.68 |
| Tavily advanced search | 2 credits × $0.008 = **$0.016 / search** | |

Sources: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) ·
[DeepSeek V3.2 on Vertex](https://cloudprice.net/models/vertex_ai/deepseek-ai/deepseek-v3.2-maas) ·
[Tavily pricing](https://www.tavily.com/pricing).

## Per-run cost

| Stage | Cost |
|---|--:|
| 3× Gemini-flash seats | $0.0349 |
| 1× DeepSeek seat | $0.0022 |
| 4× peer review | $0.0115 |
| Devil's Advocate | $0.0024 |
| Chairman (Pro) | $0.0270 |
| Cloud Run compute | ~$0.002 (negligible) |

- **~$0.08** — typical (no web research)
- **~$0.11** — grounded (research on: brief into 6 roles + 1 Tavily search)
- **~$0.19** — heavy (long question, verbose answers, a retry)

**Cost drivers:** ~80% of the bill is the **advisors' output** (long essays at Flash's
$9/1M output) + the **Pro Chairman**. Peer review and the DeepSeek seat are nearly free.

### Cost-reduction levers
- **Cap advisor answer length** — the single biggest saving (it's the largest output line).
- **Chairman on Flash** instead of Pro — ~$0.02/run off, at some synthesis-quality cost.
- `summary_only` does **not** save money — the essays are still generated, just not returned.
- Batch mode is 50% off but 24h latency → not viable for interactive use.

## Pricing for viability

Raw inference ≈ $0.10/run. For a healthy **~75–80% gross margin**, price each run at
**~$0.40–0.50 effective** (4–5×).

- **Don't charge per single query** — Stripe's $0.30 flat fee destroys micro-charges.
  Use credit packs or a subscription.
- **Free trial:** 3 runs (~$0.30 CAC).
- **Credit packs:** $10 → 25 runs ($0.40) · $25 → 75 ($0.33) · $50 → 175 ($0.29).
- **Pro subscription:** $29/mo, 100 runs (~$0.29 rev/run, cost ~$10 → ~65% margin),
  overage $0.40/run.
- **Team:** $99/mo, ~400 runs.

Floor for real margin: **$29/mo or ~$0.40/run**. Go higher when bundling the grounded mode.

## Cost monitoring (set up 2026-06-21)

- **Cloud Billing budget** "Council of Personas (fofoapps)" — $50/mo, scoped to project
  `fofoapps-934be` (#851869525836), email alerts at 50% / 90% / 100%.
- **Caveat:** that project also hosts **fofoclip** and **Sense**, so the budget tracks
  *total project spend*, not Council-only. For clean per-product attribution:
  - a **dedicated GCP project** for Council (best — isolates billing/IAM/quotas), or
  - **BigQuery billing export** filtered by service (Vertex AI vs. Generative Language API).
