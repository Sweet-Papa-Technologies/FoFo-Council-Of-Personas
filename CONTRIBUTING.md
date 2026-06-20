# Contributing to Council of Personas

Thanks for your interest! This is a small, focused project — contributions that keep it
simple and well-tested are very welcome.

## Getting set up

```bash
npm install                 # backend deps (root)
npm --prefix app install    # frontend deps (Quasar)
cp .env.example .env        # add an API key (GEMINI_API_KEY=… is enough)
npm run dev                 # API on :8787, web on :9000
```

A free Gemini key works out of the box: https://aistudio.google.com/apikey

## Project shape

Two front-ends over one orchestrator — see the [README](README.md#layout) for the file map.

- `server/src/council.ts` — the three-stage flow (fan-out → peer review → chairman).
  It's transport-agnostic: it emits events to a callback.
- `server/src/index.ts` wires those events to **SSE** (web); `server/src/cli.ts` wires
  them to **stdout** (CLI / Claude skill). New front-ends should reuse `runCouncil`, not
  reimplement it.
- `app/` is the Quasar SPA.

## Before you open a PR

```bash
npm run typecheck                 # server + scripts
npm --prefix app run typecheck    # Quasar app (vue-tsc)
```

Both must pass. Please also:

- **Keep it config-driven.** Roster, models, and temperatures live in `council.yaml`;
  secrets in the Keychain/`.env`. Don't hardcode models, keys, or personas in source.
- **Match the surrounding style** — small, readable functions; comments explain *why*.
- **Test model-touching changes** against a real endpoint (or the mock pattern in the
  PR discussion) and note what you ran.

## Good first contributions

- New personas or alternate `council.yaml` rosters (share them!).
- Additional output formats for the CLI.
- Accessibility / responsive polish on the SPA.
- Support for other OpenAI-compatible providers (document the base URL).

## Reporting bugs

Open an issue with: what you ran, what you expected, what happened, and the relevant
output (redact your API key). The `/api/health` JSON is a useful thing to include.

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
