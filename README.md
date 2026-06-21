<div align="center">

<img src="assets/banner.png" alt="Council of Personas — one question, many minds, one synthesis" width="100%" />

<p>
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="#the-pipeline"><b>Pipeline</b></a> ·
  <a href="docs/CONFIGURATION.md"><b>Config</b></a> ·
  <a href="docs/MODELS-AND-GROUNDING.md"><b>Models &amp; grounding</b></a> ·
  <a href="docs/MCP.md"><b>MCP</b></a> ·
  <a href="docs/COST-ANALYSIS.md"><b>Cost</b></a>
</p>

<p>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-bcc3ff?style=flat-square" />
  <img alt="Node ≥ 22" src="https://img.shields.io/badge/node-%E2%89%A5%2022-2e3a8c?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-bcc3ff?style=flat-square" />
  <img alt="Backend: Hono" src="https://img.shields.io/badge/api-Hono-7c3aed?style=flat-square" />
  <img alt="Frontend: Quasar" src="https://img.shields.io/badge/ui-Quasar%20%C2%B7%20Vue%203-57e0a8?style=flat-square" />
  <img alt="Models: Gemini + Vertex" src="https://img.shields.io/badge/models-Gemini%20%2B%20Vertex%20(multi--lineage)-ffd479?style=flat-square" />
  <img alt="MCP server" src="https://img.shields.io/badge/MCP-server-7c3aed?style=flat-square" />
</p>

</div>

Ask one question. A **council of advisors** — each with a different system prompt,
optionally on **different model lineages** — answer **in parallel**, **critique and
rank** each other, a **Devil's Advocate** attacks wherever they converge, and a
**Chairman** synthesizes the final answer with a confidence/cruxes calibration.

The point is *spread*: four genuinely adversarial seats (a skeptic, a visionary, a
pragmatist, a domain expert) run hot (temp ~0.9) so they disagree, then a cold
(temp ~0.3) Chairman reconciles them. Seats can run on **different base models**
(Gemini + Claude/DeepSeek/… via Vertex) so a "unanimous" verdict isn't just one
model echoing itself, and the whole council can **ground in live web facts**.

```
┌────────────────────────────────────────────────────────────────────┐
│  Q ─► (optional: one shared web-research brief — Tavily)            │
│        Red Team ┐                                                   │
│        Visionary├─ fan-out (parallel, streamed live)                │
│        Operator ├─ peer review (anonymized cross-ranking)           │
│        Expert   ┘                                                   │
│                 └─► Devil's Advocate (attacks the consensus)        │
│                          └─► Chairman ─► synthesis (pinned top)     │
└────────────────────────────────────────────────────────────────────┘
```

<div align="center">
  <img src="assets/screenshot.png" alt="Council of Personas — the command-station UI: pinned Chairman synthesis above a grid of adversarial persona cards" width="100%" />
</div>

- **Backend** — Node + TypeScript + [Hono](https://hono.dev), streaming over SSE.
  Model calls hit any **OpenAI-compatible** endpoint, **Gemini native**, or
  **Vertex AI** (Claude / DeepSeek / Qwen / …) — see [Models & grounding](docs/MODELS-AND-GROUNDING.md).
- **Frontend** — the Quasar (Vue 3) SPA in `app/`, a dark "command station" UI.
- **Config-driven** — edit `council.yaml` to change the roster, models, and
  grounding. No code changes. Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- **Three front-ends, one engine** — the web UI, a [headless CLI / Claude
  skill](#use-it-as-a-claude-skill-headless-no-web-ui), and an [MCP server](docs/MCP.md)
  (Claude Code, Claude Desktop, claude.ai web) all run the same council.

> **Do I need a LiteLLM proxy? No.** The app talks to any OpenAI-compatible endpoint.
> The simplest setup is a **free Gemini API key** and nothing else — the app defaults
> to Google's OpenAI-compatible endpoint automatically. Point it at a LiteLLM proxy,
> OpenAI, or anything else only if you *want* to. (The `LITELLM_*` env names are kept
> as aliases for back-compat; `LLM_*` and `GEMINI_API_KEY` work too.)

---

## Quick start

```bash
# 1. install backend deps (root) and confirm the Quasar app deps
npm install
npm --prefix app install      # pnpm/yarn/npm all fine; node_modules just needs to exist

# 2. give it an API key (pick ONE). The ONLY required thing for a new user is a key —
#    get a free Gemini key at https://aistudio.google.com/apikey
#    a) macOS Keychain (recommended on a Mac)
npm run secrets:set
#    b) or a .env file — one line is enough:  GEMINI_API_KEY=AIza...
cp .env.example .env && $EDITOR .env

# 3. run API + web together
npm run dev
```

With just a Gemini key set, everything else (endpoint + default model) is auto-filled —
no LiteLLM proxy, no base URL, no model required.

Then open the URL Quasar prints (default **http://localhost:9000**), type a question,
and watch the council answer in parallel → cross-rank → Chairman synthesis on top.

`npm run dev` runs two processes via `concurrently`:
- `dev:api` — the Hono API on **:8787** (`tsx watch`)
- `dev:web` — `quasar dev` on **:9000**, which proxies `/api` → the API

> Run them separately if you prefer: `npm run dev:api` and (in `app/`) `quasar dev`.

---

## Configuration / env vars

Only an **API key** is truly required. The most-used vars are below; the **full
reference** (every env var, all of `council.yaml`, and the per-run override
precedence) is in **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**.

| Setting | Required | Env names (any) | Meaning |
|---------|----------|-----------------|---------|
| API key | **yes** | `GEMINI_API_KEY`, `LLM_API_KEY`, `LITELLM_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY` | Sent as `Authorization: Bearer <key>`. A free Gemini key (`AIza…`) is the easy path. |
| Base URL | no | `LLM_BASE_URL`, `LITELLM_BASE_URL`, `OPENAI_BASE_URL` | Any OpenAI-compatible endpoint. **Defaults to Gemini** (`…/v1beta/openai`) when only a key is set. |
| Model | no | `COUNCIL_MODEL`, `LLM_MODEL` | Default model for the **council members** (the "medium" tier). Defaults to `gemini-2.5-flash`. A seat can override `model` in `council.yaml` (incl. non-Gemini lineages — see [Models](docs/MODELS-AND-GROUNDING.md)). |
| **Tavily key** | no | `TAVILY_API_KEY` (or the Keychain via `npm run secrets:set`) | Enables the provider-agnostic `research` grounding for every seat + Chairman. |
| `PORT` | no | — | API port (default `8787`). |
| `COUNCIL_CONFIG` | no | — | Path to the roster file (default `./council.yaml`). |
| `VERTEX_PROJECT` / `VERTEX_LOCATION` | no | — | GCP project / location for Vertex seats. Set `VERTEX_PROJECT` to your project (no default); `VERTEX_LOCATION` defaults `global`. |

### Where secrets come from

Resolution order is **Keychain → `.env`/env**. A Keychain entry wins, so you can keep
a shared `.env` for the team and override one value locally without editing files.

```bash
npm run secrets:set     # interactively store the 3 keys in the macOS Keychain
npm run secrets:show     # show what's set and where each value resolves from
npm run secrets:clear    # remove the keys from the Keychain (.env untouched)
```

Keychain entries live under the service name **`council-of-personas`** (visible in
Keychain Access). On non-macOS machines the Keychain is skipped and `.env` is used —
so `.env` is the portable path for teammates who don't use macOS.

> **Rotating keys.** If you use a Google AI / Gemini key, manage it at
> [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (or, for a
> gcloud-minted API key, `gcloud services api-keys list/delete --project=<your-project>`),
> then re-run `npm run secrets:set` to store the new value. Keychain values take
> precedence over `.env`.

### Models & lineage variance

Three Gemini tiers by default, matched to how hard each stage is:

| Stage | Tier | Default model |
|-------|------|-------|
| Council members | medium | `gemini-3.5-flash` (`COUNCIL_MODEL`) |
| Peer review + Devil's Advocate | fast | `gemini-3.1-flash-lite` (`settings.review_model`) |
| Chairman | hard | `gemini-3.1-pro-preview` (`chairman.model`) |

A seat can run on a **different base-model lineage** so "agreement" means something —
just set its `model:` to a Vertex model (`vertex:anthropic:…` for Claude,
`vertex:openai:…` for DeepSeek/Qwen/Llama/…). The default roster runs the **Domain
Expert on DeepSeek V3.2**. UI dropdowns (Global Settings → Models, with **Reset to
defaults**) pick per-role models live. **Full details — schemes, the verified lineage
menu, enabling models, the Claude quota note, and ADC/IAM — in
[docs/MODELS-AND-GROUNDING.md](docs/MODELS-AND-GROUNDING.md).**

### Grounding (live web facts)

Two independent mechanisms (either/both):

- **Native search** (Gemini) — per-seat `search: true`, `settings.web_search`, the UI
  toggles, or CLI `--search`. Sources show under each advisor's card. Gemini seats only.
- **Research** (Tavily) — **provider-agnostic**: one LLM-distilled query → one cached
  search → a shared brief injected into **every advisor, the Devil's Advocate, and the
  Chairman**, so non-Gemini seats and the synthesis layer ground from the same
  evidence. Best-effort (never aborts a run). Enable with `settings.research`, MCP
  `research`, or CLI `--research`; needs a Tavily key.

See [docs/MODELS-AND-GROUNDING.md#grounding](docs/MODELS-AND-GROUNDING.md#grounding).

### Attachments

Attach **images and documents** to a question with the 📎 button in the composer —
each council member sees them:

- **Images** (`png/jpg/webp/gif`) and **PDFs** go to the model as native multimodal
  input (via Gemini's API).
- **Text-ish docs** (`txt/md/csv/json/code/…`) are read and folded into the prompt as
  attached context — handy for pasting in, say, an exported Claude.ai conversation.

Up to 6 files, 10 MB each. (Binary attachments use Gemini's native API; on other
providers, images go through OpenAI-style `image_url` and text docs still work.)

Quick health check once the API is up:

```bash
curl -s localhost:8787/api/health | jq
# { "ok": true, "model": "gemini-pro", "seats": ["Red Team / Skeptic", …], "peer_review": true }
```

---

## The pipeline

0. **Research** (optional, `research`) — one LLM-distilled query → one cached Tavily
   search → a shared brief grounding every role. Best-effort; never aborts the run.
1. **Fan-out** — the question goes to every seat in parallel (`Promise.all`); each
   response streams into its own card. **If a seat errors or returns empty, it's
   retried with backoff (longer for 429/rate-limits), then marked failed and the run
   continues** — a single failure never sinks the run, and an empty answer is never
   shipped as a real one. The Chairman and Devil's Advocate retry the same way.
2. **Peer review** (`settings.peer_review`, default on) — each seat receives the
   *other* seats' answers anonymized (`Advisor A/B/C…`), critiques and ranks them with a
   strict `FINAL RANKING:` block parsed into a Borda-style tally. Failed seats are
   excluded.
3. **Devil's Advocate** (`settings.devils_advocate`, default on) — a cold pass finds
   where the council is converging and argues the strongest case against it (anti-framing
   guard), surfacing the crux. Its dissent is fed to the Chairman.
4. **Chairman** — one cold synthesizer call receives all answers, the ranking, and the
   dissent, and produces the final answer (Consensus / Conflicts / Blind Spots /
   Recommendation / Next Step / **Confidence & Cruxes**). It must flag any override of a
   higher-ranked advisor and must not call an incomplete panel "unanimous". Pinned on
   top, council collapsible below.

---

## Editing the council (`council.yaml`)

The roster is data, not code. Each seat:

```yaml
council:
  - name: "Red Team / Skeptic"
    system_prompt: |
      You are the RED TEAM ...
    # optional per-seat overrides:
    # model: "some-other-alias"   # override COUNCIL_MODEL for just this seat
    # temperature: 1.1            # override settings.council_temperature
    # accent: red                 # UI: red|purple|green|gold|blue (or a hex)
    # icon: warning               # UI: material icon name
    # tagline: The Skeptic        # UI: subtitle under the name
```

**Add a persona:** append another `- name: / system_prompt:` block under `council:`.
Save — the next run picks it up (the file is re-read per run, no restart needed). The
UI sizes itself to however many seats you define, auto-labels them Advisor A, B, C, …
for the anonymized peer-review stage, and assigns an accent color (falling back to a
palette if you don't set `accent`).

Global knobs under `settings:`:

```yaml
settings:
  peer_review: true          # stage 2 (anonymized cross-ranking)
  devils_advocate: true      # standing anti-framing dissent stage
  research: false            # provider-agnostic Tavily grounding (needs a key)
  web_search: false          # default native (Gemini) grounding for seats
  council_temperature: 0.9   # seats run hot for spread
  chairman_temperature: 0.3  # chairman runs cold for consistency
```

The `chairman:` block — and an optional `devils_advocate:` block — have the same
shape as a seat and support the same `model` / `temperature` overrides. See the full
`council.yaml` reference in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## Use it as a Claude Skill (headless, no web UI)

The same council runs headless from the command line and as a **Claude Code skill** —
so Claude (or any agent) can consult the council and get the synthesis back as text it
can show or act on, without opening the browser. Because the council runs on **Gemini**,
it's a genuine second opinion distinct from Claude.

```bash
# Markdown report (Chairman synthesis + ranking + collapsible per-persona answers)
npm run council -- "Should we migrate from Jest to Vitest?"

# Structured JSON for programmatic use
npm run council -- "Should we migrate from Jest to Vitest?" --json

# Faster: skip peer review and/or the Devil's Advocate
npm run council -- "..." --no-review --no-devil

# Ground every seat with live native search (Gemini)
npm run council -- "Best React state library right now?" --search

# Or provider-agnostic grounding (Tavily) — works for non-Gemini seats too
npm run council -- "Best React state library right now?" --research
```

Progress prints to **stderr**; the result prints to **stdout**, so it captures cleanly.

### Installing the skill

- **In this repo** — the skill at `.claude/skills/council-of-personas/` works whenever
  you run Claude Code from the project root. Nothing to install.
- **Everywhere** — make it available in every session, from any directory:

  ```bash
  npm run skill:install      # copies a path-resolved copy to ~/.claude/skills
  ```

Then start a new session and say *"convene the council on &lt;X&gt;"* / *"get me a panel of
perspectives on &lt;X&gt;"* / *"red-team this plan: &lt;X&gt;"*. Claude runs the CLI, then leads
with the Chairman's recommendation and offers the individual advisors' arguments.

> The skill reads the same key (Keychain/`.env`) and `council.yaml` as everything else.

---

## Use it from Claude via MCP

The council is also an **MCP server** (`server/src/mcp.ts`), so an AI client can call
it as a tool. One tool — **`convene_council`** — with params `question`,
`peer_review`, `web_search`, `research`, `summary_only`, and
`output_format` (`markdown` | `json` | `html`). It streams **progress
notifications** per stage and returns structured errors. **Full tool reference,
output formats, and the stateless design in [docs/MCP.md](docs/MCP.md).**

> **Deploys don't break the connector.** The HTTP server runs in **stateless** mode,
> so a new Cloud Run revision (or instance recycle) serves any request without a
> reconnect — stale sessions are ignored rather than rejected. (Details in the MCP doc.)

### Claude Code / Claude Desktop (local, no hosting)

This repo ships a `.mcp.json`, so **Claude Code picks the server up automatically**
when you're in the project (approve it once). It runs over stdio via `npm run mcp`
and reads your key from the Keychain/`.env` like everything else.

### Hosted (remote, for use anywhere)

The Streamable-HTTP transport (`npm run mcp:http`, or `MCP_HTTP=1`) is containerized
(`Dockerfile`) and deploys to **Cloud Run** (see [Infrastructure](#infrastructure-terraform--cloud-build)).
Once deployed, your endpoint looks like:

```
https://<your-cloud-run-host>/mcp
```

Gate it with a **bearer token** (`MCP_BEARER_TOKEN`, stored in Secret Manager as
`council-mcp-token` and in your Keychain). The Gemini key lives in Secret Manager
(`council-gemini-key`). Add it to Claude Code from any machine:

```bash
TOKEN=$(security find-generic-password -s council-of-personas -a MCP_BEARER_TOKEN -w)
claude mcp add --transport http council \
  https://<your-cloud-run-host>/mcp \
  --header "Authorization: Bearer $TOKEN"
```

### claude.ai web (Custom Connector — OAuth)

The server is also a minimal **OAuth 2.1 Authorization Server** (`server/src/oauth.ts`)
so it can be added as a **claude.ai custom connector** (paid plans). It implements
discovery (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`),
Dynamic Client Registration, PKCE-S256, and stateless signed-JWT tokens — all
single-user-gated by one **consent passphrase**.

To connect: claude.ai → **Settings → Connectors → Add custom connector** → paste the
`/mcp` URL above. claude.ai runs the OAuth flow and shows a consent page — enter the
passphrase (stored in Keychain as `OAUTH_PASSPHRASE`, and in Secret Manager as
`council-oauth-passphrase`) and click **Authorize**. Claude Code's static bearer token
still works too — both auth paths are accepted.

### Infrastructure (Terraform + Cloud Build)

The backend (APIs, Artifact Registry, the secrets, Cloud Run service + secret
wiring, IAM, and a push-to-deploy Cloud Build trigger) is codified in
[`infra/`](infra/) (Terraform) + [`cloudbuild.yaml`](cloudbuild.yaml). See
[`infra/README.md`](infra/README.md) for apply / import / CI setup. Quick redeploy
without Terraform: `gcloud run deploy council-mcp --source . --project your-gcp-project --region us-central1`.

---

## Layout

```
council.yaml          the roster (edit me)
.env.example          env template
.claude/skills/council-of-personas/SKILL.md   Claude Code skill (headless)
scripts/secrets.ts    Keychain CLI (set/show/clear)
scripts/install-skill.sh   install the skill into ~/.claude/skills
server/src/
  index.ts            Hono server + SSE endpoint
  cli.ts              headless CLI (Markdown / JSON) — used by the skill
  mcp.ts              MCP server (stdio + stateless Streamable HTTP)
  oauth.ts            minimal OAuth 2.1 AS (claude.ai custom connector)
  council.ts          pipeline: fan-out → review → devil's advocate → chairman
  llm.ts              streaming client (OpenAI-compat + Gemini native + Vertex routing)
  vertex.ts           direct Vertex AI provider (Claude / DeepSeek / Qwen / …)
  research.ts         Tavily research (provider-agnostic grounding)
  config.ts           env/Keychain + council.yaml loading
  secrets.ts          Keychain → env resolution
  queue.ts            single-consumer async queue (serializes SSE writes)
app/                  Quasar SPA — dark "command station" UI
  src/composables/useCouncil.ts   SSE client + reactive state
  src/composables/markdown.ts     tiny safe markdown renderer (synthesis)
  src/css/app.scss                design tokens + utility classes
  src/pages/index.vue             router shell
  src/pages/index/(index).vue     the council command interface
```

The UI implements a "Strategic Command Interface" design (dark, glassmorphic,
Geist/Inter/JetBrains Mono) — fixed roster sidebar, pinned Chairman synthesis hero,
terminal-style command input, and a bento grid of persona cards with per-archetype
accent colors and live status glows.

## Troubleshooting

- **"No API key found"** — set a key (`GEMINI_API_KEY=…` is enough) via
  `npm run secrets:set` or `.env`, then re-ask. Free key: https://aistudio.google.com/apikey
- **A card shows an error, others are fine** — that seat's call failed (bad model
  alias, rate limit, upstream error). The run still completes and the Chairman
  synthesizes from the seats that answered.
- **No tokens appear** — confirm the API is up (`curl localhost:8787/api/health`) and
  that the Quasar dev server is proxying `/api` (it does by default via `quasar.config.ts`).
- **`research` did nothing / warned** — set a Tavily key (`TAVILY_API_KEY` or Keychain
  the Keychain). Research is best-effort: with no/invalid key the run still
  completes ungrounded and the output says so.
- **A Vertex (Claude) seat 429s** — that base model's Vertex quota is 0; request an
  increase or use a verified lineage. See [Models & grounding](docs/MODELS-AND-GROUNDING.md).

---

## Documentation

| Doc | What's in it |
|---|---|
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every env var, all of `council.yaml`, per-run override precedence |
| [docs/MODELS-AND-GROUNDING.md](docs/MODELS-AND-GROUNDING.md) | Model tiers, Vertex lineage variance + setup, native search, Tavily research |
| [docs/MCP.md](docs/MCP.md) | The `convene_council` tool, output formats, progress, connecting (stdio/bearer/OAuth), stateless design, deploy |
| [docs/COST-ANALYSIS.md](docs/COST-ANALYSIS.md) | Measured per-run cost, pricing-for-viability, cost monitoring |
| [infra/README.md](infra/README.md) | Terraform apply / import / CI |
| [docs/BRANDING.md](docs/BRANDING.md) | Logo / palette / asset generation |

---

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The golden rule: keep it
config-driven (roster/models in `council.yaml`, secrets in the Keychain/`.env`) and make
both typechecks pass.

## License

[MIT](LICENSE) © Forrester Terry. Brand assets generated with Google's Nano Banana Pro;
see [docs/BRANDING.md](docs/BRANDING.md).

