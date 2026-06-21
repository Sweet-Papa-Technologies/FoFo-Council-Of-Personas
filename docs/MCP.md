# MCP Server

The council is an **MCP server** (`server/src/mcp.ts`) exposing one tool,
`convene_council`. It runs over **stdio** (local, for Claude Code/Desktop) or
**Streamable HTTP** (hosted, for claude.ai web and remote Claude Code).

## The `convene_council` tool

Runs the full pipeline (fan-out → peer review → Devil's Advocate → Chairman) and
returns the result.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `question` | string (required) | — | The question to put to the council. |
| `peer_review` | bool | config | Run the peer-review / ranking stage. |
| `web_search` | bool | `false` | Native model search grounding (Gemini). |
| `research` | bool | `false` | Inject one shared Tavily web-research brief into every advisor, the Devil's Advocate, and the Chairman. |
| `summary_only` | bool | `false` | Return only the Chairman synthesis + ranking, omitting the full advisor essays. |
| `output_format` | `markdown` \| `json` \| `html` | `markdown` | See below. |

### Output formats

- **`markdown`** (default) — Chairman synthesis pinned on top, a research indicator
  line, peer-ranking table, then the advisor essays (omitted if `summary_only`).
- **`json`** — structured per-seat objects (`members`, `chairman`, `devils_advocate`,
  `rankings`, `research`) so the calling agent renders its own UI.
- **`html`** — self-contained, theme-neutral, collapsible `<details>` per advisor,
  no scripts, XSS-escaped. Renders inside artifact/visualizer surfaces.

### Errors & progress

- **Structured errors** are returned to the caller (missing-key / 4xx / 5xx hints),
  and a hard error if every seat **and** the Chairman fail. Research failures are
  **soft** (the run proceeds ungrounded; the `research` field shows it didn't ground).
- **Progress:** if the client passes a `progressToken` in `_meta`, the tool emits
  `notifications/progress` per stage (dispatching → advisor k/N → peer review →
  devil's advocate → chairman → done). Degrades gracefully if unsupported.

## Connecting

### Claude Code / Claude Desktop (local stdio)

This repo ships `.mcp.json`, so **Claude Code picks the server up automatically** in
the project (approve once). Runs `npm run mcp` over stdio, reads your key from the
Keychain/`.env`.

### Hosted — remote Claude Code (static bearer)

The Streamable-HTTP server (`npm run mcp:http` / `MCP_HTTP=1`) is containerized and
deployed to Cloud Run:

```
https://council-mcp-851869525836.us-central1.run.app/mcp
```

Gated by `MCP_BEARER_TOKEN` (Secret Manager `council-mcp-token`, also in Keychain):

```bash
TOKEN=$(security find-generic-password -s council-of-personas -a MCP_BEARER_TOKEN -w)
claude mcp add --transport http council \
  https://council-mcp-851869525836.us-central1.run.app/mcp \
  --header "Authorization: Bearer $TOKEN"
```

### claude.ai web (Custom Connector — OAuth)

The server is also a minimal **OAuth 2.1 Authorization Server** (`server/src/oauth.ts`):
RFC 9728 / 8414 discovery, Dynamic Client Registration, PKCE-S256, and stateless
signed-JWT tokens — single-user-gated by one **consent passphrase**.

Connect: claude.ai → **Settings → Connectors → Add custom connector** → paste the
`/mcp` URL → run the OAuth flow → on the consent page enter the passphrase (Keychain
`OAUTH_PASSPHRASE` / Secret Manager `council-oauth-passphrase`) → **Authorize**. The
static bearer path still works in parallel.

## Stateless design (why deploys don't break the connector)

The HTTP server runs in **stateless** Streamable-HTTP mode (`sessionIdGenerator:
undefined`): a fresh server + transport per request, no in-memory session map, no
session validation. A new Cloud Run revision (deploy) or instance recycle therefore
serves any request transparently — stale `Mcp-Session-Id`s are ignored instead of
being `404`'d, so **the connector survives deploys with no reconnect**. `GET`/`DELETE`
on `/mcp` return `405` (no server-initiated stream in stateless mode); `POST`
JSON-RPC and per-request progress notifications are unchanged.

Tradeoff: no server-initiated push between requests. The council is request/response,
so this costs nothing today; a future long-lived subscription feature would want an
external session store (Redis/Firestore).

## Deploy / redeploy

```bash
gcloud run deploy council-mcp --source . \
  --project fofoapps-934be --region us-central1
```

Builds from the `Dockerfile` (`tsx`, no build step), ships a new revision. Secrets
are wired from Secret Manager (`council-gemini-key`, `council-mcp-token`,
`council-oauth-secret`, `council-oauth-passphrase`, `council-tavily-key`). Full IaC in
[`infra/`](../infra/) (Terraform) + [`cloudbuild.yaml`](../cloudbuild.yaml); see
[DEPLOYMENT pointers in infra/README.md](../infra/README.md). Cost monitoring &
budget: [COST-ANALYSIS.md](COST-ANALYSIS.md).
