# Models & Grounding

How seats are assigned models (including **non-Gemini lineages** via Vertex), and
the two ways the council grounds answers in live facts (**native search** and the
provider-agnostic **Tavily research** tool).

---

## Model tiers (Gemini defaults)

The council uses three tiers matched to how hard each stage is:

| Stage | Tier | Default model | Where it's set |
|---|---|---|---|
| Council members | medium | `gemini-3.5-flash` | `COUNCIL_MODEL` (Keychain/env) |
| Peer review + Devil's Advocate | fast | `gemini-3.1-flash-lite` | `settings.review_model` |
| Chairman | hard | `gemini-3.1-pro-preview` | `chairman.model` |

A single seat can pin its own `model:` in `council.yaml`; the UI (Global Settings →
Models) can also pick per-role models live, saved in the browser and sent per-run.

## Model variance (non-Gemini lineages via Vertex)

> **Why:** when every seat shares one base model, a "unanimous" verdict is partly
> substrate echo, not independent agreement. Running ≥1 seat on a different lineage
> makes agreement mean something.

A seat opts into a Vertex lineage **purely via its `model:` string** — two schemes,
both handled by `server/src/vertex.ts` (direct Vertex AI, no proxy):

```yaml
model: "vertex:anthropic:claude-sonnet-4-6"            # Anthropic Messages API (Claude)
model: "vertex:openai:deepseek-ai/deepseek-v3.2-maas"  # Vertex MaaS (OpenAI-compatible)
```

- `vertex:anthropic:<id>` → Claude on Vertex (`:streamRawPredict`), supports images.
- `vertex:openai:<id>` → any Vertex MaaS model (DeepSeek, Qwen, Llama, gpt-oss, …)
  via the OpenAI-compatible `endpoints/openapi/chat/completions`.

Non-Gemini seats have no native search, so they ground via the **`research`** flag
(Tavily) below.

### Current default mapping (`council.yaml`)

| Seat | Lineage |
|---|---|
| Operator / Pragmatist | Gemini |
| Visionary | Gemini |
| Red Team / Skeptic | Gemini (Claude target — see quota note) |
| **Domain Expert** | **DeepSeek V3.2** (Vertex MaaS) |
| Chairman | Gemini Pro (Claude target — see quota note) |

The lineage menu lives at the bottom of `council.yaml`.

### Authentication & IAM (ADC, no keys)

Vertex calls use **Application Default Credentials** via `google-auth-library`:

- **Prod (Cloud Run):** the runtime service account needs `roles/aiplatform.user`
  (already granted). The SA's project is the quota project automatically.
- **Local:** `gcloud auth application-default login`. The provider sends
  `x-goog-user-project` so user ADC has a quota project.

Config: `VERTEX_PROJECT` (your project — env, `GOOGLE_CLOUD_PROJECT`, or Keychain; no default), `VERTEX_LOCATION` (default
`global` — where Claude 4.6 and the MaaS models live).

### Enabling models & verified IDs

Enable the Vertex API and discover current model IDs:

```bash
gcloud services enable aiplatform.googleapis.com --project=<PROJ>
# list a publisher's models
TOK=$(gcloud auth print-access-token)
curl -s -H "Authorization: Bearer $TOK" -H "x-goog-user-project: <PROJ>" \
  "https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/deepseek-ai/models?pageSize=100"
```

**Verified callable on `global` (2026-06-21):**

```
vertex:openai:deepseek-ai/deepseek-v3.2-maas
vertex:openai:qwen/qwen3-235b-a22b-instruct-2507-maas
vertex:openai:qwen/qwen3-next-80b-a3b-instruct-maas
vertex:openai:openai/gpt-oss-120b-maas
```

**Claude note:** `vertex:anthropic:claude-sonnet-4-6` / `claude-opus-4-6` are
**enabled** but the `global` base-model quota is **0** by default → `429`. Request an
increase in **Vertex AI → Quotas → "online prediction requests per base model"** for
the `anthropic-claude-*` base model, then flip the seat's `model:` — no code change.
Not yet on `global`: `meta/llama-*-maas`, `mistralai/*` (need a specific region).

### Reliability

MaaS lineages flake more than Gemini. Each seat **retries once** on an empty or
errored response, then is marked failed (excluded from peer review/ranking; the
Chairman treats it as a missing voice). If a lineage flakes too often, swap that
seat to a steadier one (Qwen, gpt-oss) in one line.

---

## Grounding

Two independent mechanisms; either or both can be on.

### Native search (Gemini)

Live Google Search grounding via Gemini's native API. Per-seat: `search: true` in
`council.yaml`, or `settings.web_search: true` globally, or the UI per-seat toggles,
or CLI `--search`. The web sources used are shown under that advisor's card / in the
CLI/JSON output. Only works on Gemini seats.

### Research (Tavily)

**Provider-agnostic** grounding so non-Gemini seats **and the Chairman** reason from
the same evidence (closing the gap where a grounded advisor is right but an
ungrounded synthesis hallucinates).

- One **LLM-distilled** search query per run (not the raw prompt — avoids Tavily's
  400-char cap and grounds better), one Tavily search, **cached/deduped**, the brief
  injected into every advisor + Devil's Advocate + Chairman.
- **Best-effort:** a missing/invalid key or a failed search **never aborts the run** —
  it proceeds ungrounded and the outcome is surfaced (`research` field / a one-line
  indicator showing the query + source count, or a warning).
- **Key:** `TAVILY_API_KEY` env, or the macOS Keychain (service `council-of-personas`). In prod,
  Secret Manager `council-tavily-key` → `TAVILY_API_KEY`.
- **Enable:** `settings.research: true`, MCP `research: true`, CLI `--research`, or
  HTTP `research`.

Cost: ~$0.016 per run (1 advanced Tavily search) + a small distillation call. See
[COST-ANALYSIS.md](COST-ANALYSIS.md).
