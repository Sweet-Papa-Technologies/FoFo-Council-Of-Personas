---
name: council-of-personas
description: >-
  Convene a "Council of Personas" — adversarial AI advisors (Red Team / Skeptic,
  Visionary, Operator / Pragmatist, Domain Expert), all powered by Gemini, that
  answer a question in parallel, peer-review and rank each other, then a Chairman
  synthesizes a final recommendation. Use when the user wants a panel / council /
  board of diverse expert perspectives, adversarial stress-testing of a decision,
  plan, or design, multiple independent takes on a hard question, or a synthesized
  recommendation with tradeoffs and a concrete next step. Runs headless (no web UI)
  and returns Markdown (default) or JSON.
---

# Council of Personas (headless)

This skill consults a council of **Gemini** personas and returns their synthesized
advice. Because the council runs on a *different* model than you, it's a genuine
second opinion — useful for decisions, architecture/design reviews, strategy calls,
or any question that benefits from clashing viewpoints rather than one voice.

## When to use it

Trigger when the user asks for things like:
- "convene the council on …", "ask the council …", "what does the council think …"
- "get me a panel / board of advisors on …", "I want multiple perspectives on …"
- "stress-test this decision / plan / design", "red-team this", "steelman and critique …"
- "give me the optimistic, pragmatic, and skeptical takes on …"

Don't use it for simple factual lookups or tasks you can answer directly — it's for
questions where adversarial breadth + synthesis adds real value (and it costs ~20–60s
and several Gemini calls per run).

## How to run

From the repository root, run (this is the project copy of the skill; the personal
install copy already has an absolute path baked in):

```bash
npm run --silent council -- "THE USER'S QUESTION" --quiet
```

- **stdout** is a ready-to-show Markdown report: the **Chairman's Synthesis** first,
  then a peer-review ranking table, then each persona's full answer inside collapsible
  `<details>` sections.
- Quote the Chairman's Synthesis to the user prominently. Mention the ranking and offer
  the per-persona details; expand a persona's section if the user wants to dig in.
- The run takes ~20–60s (it's 4 advisors + peer review + a Chairman call). If your shell
  tool has a short timeout, allow up to 120s.

### Options

- `--json` — emit structured JSON instead of Markdown:
  `{ question, peer_review, chairman:{content,error}, members:[{name,accent,status,answer,ranking}], rankings:[{rank,name,points,appearances}] }`.
  Use this when you want to *use* the result programmatically (e.g. fold a specific
  persona's point into your own work) rather than just display it.
- `--no-review` — skip the peer-review stage (faster, ~15–30s, no ranking table).
- Drop `--quiet` if you want live progress on stderr (not needed when a tool captures output).

## Configuration

The council needs an API key, read from the macOS Keychain or a `.env` file. If the
command fails with **"No API key found"**, tell the user to either run
`npm run secrets:set` (Keychain) or set `GEMINI_API_KEY=…` in `.env`
(free key: https://aistudio.google.com/apikey). The roster, model tiers, and whether
peer review is on by default all live in `council.yaml` — no code changes needed.

## Example

User: "Should we migrate our test suite from Jest to Vitest?"

```bash
npm run --silent council -- "Should we migrate our test suite from Jest to Vitest?" --quiet
```

Then present the Chairman's recommendation + next step, summarize where the advisors
agreed vs. clashed, and offer to expand any single advisor's full argument.
