# Configuration Reference

Everything the Council reads at runtime: environment/secrets, `council.yaml`, and
the per-run overrides (UI / CLI / MCP / HTTP) with their precedence. For models &
grounding specifically, see [MODELS-AND-GROUNDING.md](MODELS-AND-GROUNDING.md); for
the MCP tool, [MCP.md](MCP.md).

## Environment / secrets

Resolution order is **macOS Keychain → `.env`/process env**. A Keychain entry wins,
so a team can share a `.env` and override one value locally. Keychain entries live
under the service name **`council-of-personas`**. On non-macOS the Keychain is
skipped and `.env` is used.

```bash
npm run secrets:set     # store keys in the Keychain interactively
npm run secrets:show    # show what's set and where each resolves from
npm run secrets:clear   # remove from the Keychain (.env untouched)
```

| Setting | Required | Env names (any) | Meaning |
|---|---|---|---|
| LLM API key | **yes** | `GEMINI_API_KEY`, `LLM_API_KEY`, `LITELLM_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY` | Sent as `Authorization: Bearer <key>`. A free Gemini key (`AIza…`) is the easy path. |
| Base URL | no | `LLM_BASE_URL`, `LITELLM_BASE_URL`, `OPENAI_BASE_URL` | Any OpenAI-compatible endpoint. Defaults to Gemini (`…/v1beta/openai`) when only a key is set. |
| Council model | no | `COUNCIL_MODEL`, `LLM_MODEL` | Default model for council members (the "medium" tier). Defaults to `gemini-2.5-flash`. |
| **Tavily key** | no | `TAVILY_API_KEY`, `TAVILY_KEY` | Enables the provider-agnostic `research` grounding. Set via env or the Keychain (service `council-of-personas`) with `npm run secrets:set`. See [grounding](MODELS-AND-GROUNDING.md#research-tavily). |
| `PORT` | no | — | API/MCP port (default `8787` API, `8788` MCP HTTP). |
| `COUNCIL_CONFIG` | no | — | Path to the roster file (default `./council.yaml`). |
| `VERTEX_PROJECT` | no | — | Your GCP project for Vertex model calls. Resolved from env, `GOOGLE_CLOUD_PROJECT`, or the Keychain (service `council-of-personas`) — no hardcoded default. |
| `VERTEX_LOCATION` | no | — | Vertex location (default `global`). |
| `MCP_HTTP` | no | — | `1` serves the MCP server over Streamable HTTP instead of stdio. |
| `MCP_BEARER_TOKEN` | no | — | Static bearer that gates the hosted MCP endpoint (Claude Code). |
| `OAUTH_HMAC_SECRET`, `OAUTH_PASSPHRASE` | no | — | Enable the built-in OAuth AS for claude.ai web (both must be set). |

Vertex calls authenticate with **ADC** (no key): the Cloud Run runtime service
account in prod, or `gcloud auth application-default login` locally.

## `council.yaml`

Re-read **per run** — edits apply with no restart. Three top-level keys:
`settings`, `council`, `chairman`, plus an optional `devils_advocate`.

### `settings`

| Key | Default | Meaning |
|---|---|---|
| `peer_review` | `true` | Run stage 2 (anonymized cross-ranking). |
| `devils_advocate` | `true` | Run the standing anti-framing dissent stage. |
| `research` | `false` | Inject one shared Tavily web-research brief into every role. Needs a Tavily key. |
| `web_search` | `false` | Default native model grounding (Gemini Google Search) for seats that don't set `search`. |
| `review_model` | — | Model for the peer-review stage (the "fast" tier). |
| `council_temperature` | `0.9` | Seats run hot for spread. |
| `chairman_temperature` | `0.3` | Chairman runs cold for consistency. |

### `council` (a list of seats)

```yaml
council:
  - name: "Red Team / Skeptic"      # required
    system_prompt: |                # required
      You are the RED TEAM ...
    # optional per-seat overrides:
    model: "vertex:anthropic:claude-sonnet-4-6"  # override COUNCIL_MODEL (see MODELS doc)
    temperature: 1.1                # override settings.council_temperature
    search: true                    # native grounding for this seat
    accent: red                     # UI: red|purple|green|gold|blue or hex
    icon: warning                   # UI: material icon name
    tagline: The Skeptic            # UI: subtitle
```

Add a seat by appending another block — the next run picks it up, auto-labels it
`Advisor A/B/C…` for anonymized review, and sizes the UI to fit.

### `chairman`

Same shape as a seat (`name`, `system_prompt`, optional `model`/`temperature`).
Runs cold and synthesizes; its prompt produces Consensus / Conflicts / Blind Spots
/ Recommendation / Next Step / **Confidence & Cruxes**, must flag any override of a
higher-ranked advisor, and must not call an incomplete panel "unanimous".

### `devils_advocate` (optional)

Same shape as a seat. If omitted, a built-in default prompt is used. Runs after the
council on the fast tier; finds where the council is converging and argues the
strongest case against it, surfacing the crux. Gated by `settings.devils_advocate`.

## Per-run overrides & precedence

The same run can be tuned live without editing `council.yaml`:

| Capability | UI (Global Settings) | CLI (`npm run council`) | MCP `convene_council` | HTTP `/api/council/run` |
|---|---|---|---|---|
| Peer review | toggle | `--no-review` / `--review` | `peer_review` | `peer_review` |
| Devil's Advocate | — | `--no-devil` / `--devil` | — (always per config) | `devils_advocate` |
| Native search | per-seat toggles | `--search` / `--no-search` | `web_search` | `search_overrides`, `chairman_search` |
| Tavily research | — | `--research` / `--no-research` | `research` | `research` |
| Per-role model | dropdowns + reset | — | — | `council_model`, `review_model`, `chairman_model` |
| Attachments | 📎 composer | — | — | `attachments[]` |

**Search precedence (native):** `--search` (blanket) → per-seat UI override →
persona/chairman `search:` → `settings.web_search`.

**Research:** explicit run flag (`research: true`) → `settings.research`. Research is
**best-effort** — a missing/invalid key or a failed search never aborts a run; it
proceeds ungrounded and the outcome is surfaced.
