# Documentation plan

> Tracking epic: [#132 — Project documentation overhaul](https://github.com/thetombrider/coding_agent/issues/132).
> This file is the durable plan; the issues are the executable work items.

## Why

Orin's code is well-structured and the top-level prose is strong, but the
documentation is uneven. Today we have:

- **`README.md`** — an excellent feature overview + quick start. (Has drifted
  slightly from the code — e.g. its tool list mentions `delegate_read` but not
  the shipped `task` and `todowrite` tools.)
- **`SPEC.md`** — the design rationale and a **phased build plan**. It describes
  the *intended* system and what's *planned*, not the system as it exists today.
- **`CONTRIBUTING.md`** / **`AGENTS.md`** — contributor workflow and
  environment caveats.
- **`docs/reference/cline-kilo.md`** — a reference study of comparable agents.
- **`docs/media/`** — screenshots.

What's missing is the **middle layer**: a navigable docs tree, a description of
the *current* architecture for someone reading the code, and consolidated
reference + operator material (config schema, tool reference, CLI/commands,
providers, telemetry, sessions, hooks, sandbox, troubleshooting).

## Principles

1. **Code is the source of truth.** Every doc cites exact `file:symbol`
   references and is "done" only when it matches the code. Where a schema or
   list lives in code (config in `src/config/config.ts`, tool args in the Zod
   schemas, model-facing tool text in `src/tools/*.txt`), the doc points at it
   rather than re-deriving it.
2. **Describe the present, not the plan.** The new architecture guide documents
   what's built; `SPEC.md` remains the forward-looking design doc. They
   cross-link but don't duplicate.
3. **Audience-first structure.** Users, operators, and contributors each have a
   clear entry point.
4. **Keep prose out of code and code out of prose.** Mirror the existing
   convention (tool descriptions in `.txt`) — docs explain *why* and *how to
   use*, not re-paste implementation.

## Target structure

```
docs/
  README.md              # index / nav (#120)
  DOCUMENTATION_PLAN.md  # this file
  architecture/
    README.md            # current system, module map, data flow, diagrams (#121)
  guides/                # operator + feature guides
    providers.md         # using + adding providers (#125)
    telemetry.md         # local metrics + OTLP traces (#126)
    sessions.md          # session log, resume, compaction (#127)
    hooks.md             # lifecycle hooks + authoring (#128)
    sandbox.md           # E2B remote execution (#129)
    troubleshooting.md   # troubleshooting + FAQ (#130)
  reference/
    configuration.md     # config.json schema + env vars (#122)
    tools.md             # all 10 tools (#123)
    cli.md               # CLI flags + slash commands (#124)
    cline-kilo.md        # existing reference study
  media/                 # existing screenshots
```

Root-level `README.md`, `SPEC.md`, `CONTRIBUTING.md`, `AGENTS.md`, `LICENSE`
stay where they are (conventional) and are cross-linked from `docs/README.md`.
`AGENTS.md` additionally gets a minimal pointer to the docs conventions so the
next agent that edits the code keeps the docs in sync (#133, applied last).

## Work items

Each maps to a GitHub issue under epic **#132**.

### Foundation
- **#120 — Documentation site structure & index.** Create `docs/README.md`, the
  `docs/` tree above, and link it from the root README.
- **#121 — Architecture & internals guide.** Describe the current system:
  data model (`src/types.ts`), the agent loop (`src/agent/loop.ts`), a
  module-by-module map of `src/`, an end-to-end turn lifecycle, and Mermaid
  component + sequence diagrams.

### Reference
- **#122 — Configuration reference.** Full `config.json` schema, every env var,
  precedence rules, and `~/.orin/` file locations — anchored to
  `src/config/config.ts`.
- **#123 — Tool reference.** All ten tools (`read`, `write`, `edit`, `bash`,
  `grep`, `find`, `ls`, `delegate_read`, `task`, `todowrite`): args, approval
  behavior, mutate vs read-only, child/E2B gating.
- **#124 — CLI flags & slash-command reference.** Invocation modes
  (interactive / `--headless` / `--chat` / `--faux`), every flag from
  `src/main.ts`, every command from `src/tui/commands.ts`.
- **#125 — Provider guide.** The registry model, using OpenRouter/Regolo, the
  model picker, and a full checklist for adding a provider.

### Operator / feature guides
- **#126 — Telemetry & observability guide.** Local metrics pipeline + JSONL
  schema, cost model, OTLP span hierarchy and config, backend recipes (Langfuse
  et al.).
- **#127 — Sessions, persistence & compaction guide.** JSONL session format,
  resume/browse, context compaction thresholds, todo durability.
- **#128 — Hooks guide.** The hook points and payloads, built-in hooks, the
  observer channel, and a worked authoring example.
- **#129 — Remote execution / E2B sandbox guide.** The Workspace abstraction,
  setup, what runs where, and limitations.

### Support & maintenance
- **#130 — Troubleshooting & FAQ.** Symptom → cause → fix for the known failure
  modes (Bun-not-Node, TTY, provider-not-configured, the test API-key quirk, …).
- **#131 — README sync, CHANGELOG & doc-maintenance conventions.** Reconcile the
  README with the code, add `CHANGELOG.md`, and tell contributors which doc to
  update for which change.
- **#133 — Minimal docs-convention pointers in `AGENTS.md`** *(do last).* A few
  lines pointing the next agent at `docs/README.md` + `DOCUMENTATION_PLAN.md`,
  the "update the doc when you change the behavior" rule, and the source-of-truth
  anchors (config in `src/config/config.ts`, tool args in the Zod schemas, tool
  text in `src/tools/*.txt`, flags in `src/main.ts`, commands in
  `src/tui/commands.ts`). Kept minimal — pointers, not a copy of the conventions
  (those live in `CONTRIBUTING.md` and this file). **Sequenced last**, after the
  docs it references exist, so the links aren't dangling.

## Suggested sequencing

1. **#120** first — establishes the tree everything else lands in.
2. **#131's README sync** early — cheap and fixes user-visible drift.
3. **Reference docs (#122–#125)** and **guides (#126–#129)** in parallel; these
   are mostly independent.
4. **#121 (architecture)** and **#130 (troubleshooting)** draw on the rest, so
   they settle late.
5. **#133 (AGENTS.md pointers)** is **strictly last** — it links the shipped
   docs, so it only makes sense once v1 of the `docs/` tree is in place.

## Definition of done (per doc)

- Cites exact `file:symbol` references; no claim unverified against the code.
- No dead links; reachable from `docs/README.md`.
- States its audience and what it does *not* cover (with a link to where that
  lives).
- Any embedded schema/list notes its in-code source of truth.
