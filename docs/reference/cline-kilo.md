# Reference study: Cline & Kilo Code

> Issue #47. Companion to SPEC.md's three primary references (pi, nanocoder, opencode).
> This studies two more production agents — **Cline** and **Kilo Code** — for patterns
> and best practices relevant to Orin's phases. As with the SPEC references, the goal is
> to mirror the *approach*, not copy code (both are open source; Cline is Apache-2.0,
> Kilo/Roo are Apache-2.0).

## Methodology & honesty note

This study is drawn from the projects' official docs, engineering blogs, DeepWiki
indexes, and a few raw source files (Roo's diff and condense modules read directly).
It is an **architecture/patterns** study, not a line-by-line source audit — the
sandboxed environment blocked fetching most rendered doc/blog hosts, and the GitHub MCP
scope is limited to this repo, so I could not browse the Cline/Kilo trees file-by-file.
Where a specific file/symbol is named for *those* repos, treat it as a pointer to verify
after a local clone, not a confirmed line reference. All `src/...` references to **Orin**
are exact. Follow-up: clone `cline/cline` and `RooCodeInc/Roo-Code` / `Kilo-Org/kilocode`
locally to confirm the diff-apply and subtask internals before implementing Phases 6 and 8.

## Lineage (why two repos, one study)

```
Claude Dev (mid-2024) → Cline → Roo Code → Kilo Code
```

Kilo is a fork of Roo, which is a fork of Cline. They share a skeleton (XML-ish tool
calls, a single agent loop, Plan/Act, MCP) but have diverged on the parts most useful to
us: **Cline** leads on edit reliability, checkpoints, and context condensing; **Roo/Kilo**
lead on **modes** (per-role tool restriction) and **orchestrator/subtasks** — directly
relevant to Orin's Phase 8 subagent work (#36, #37). Where Roo and Kilo agree, the Roo
source is cited because it's the shared implementation.

---

## Pattern map → Orin phases

| # | Pattern (Cline / Kilo) | Orin phase | Where in Orin | Status |
|---|------------------------|-----------|---------------|--------|
| 1 | Decoupled headless agent runtime (Cline SDK) | §5 loop | `src/agent/loop.ts`, `events.ts` | ✅ already aligned; confirms direction |
| 2 | Plan / Act separation + diff-preview-before-apply | Phase 4 | `src/approval/policy.ts` | ✅ aligned; one refinement |
| 3 | Robust diff editing: line hints, order-invariant multi-block, middle-out | Phase 6 | `src/edit/replacers.ts`, `src/tools/edit.ts` | ⚠️ partial — 3 concrete gaps |
| 4 | Modes + tool groups + `fileRegex` edit scoping | Phase 8 presets | `src/agent/presets.ts` (#36) | 🔜 informs design |
| 5 | Orchestrator / `new_task` / Boomerang subtasks | Phase 8 | `src/tools/task.ts` (#36/#37) | 🔜 strongest match |
| 6 | Checkpoints via shadow git | Phase 9 / safety | `src/workspace/*` | 💡 new idea → new issue |
| 7 | Auto-condense (summary replaces history, non-destructive) | Phase 7 | `src/agent/compaction.ts` | ⚠️ aligned; 2 refinements |
| 8 | Rules files injected into the system prompt (`.clinerules`) | Phase 10 | `src/hooks/*` `before_prompt` | ✅ hook already supports it |
| 9 | MCP tool group governance | Phase 11 | `src/mcp/*` (#10) | 🔜 informs governance |
| 10 | System-prompt assembly + `AGENTS.md` + env block + per-model variants | Phase 10 | `src/config/config.ts`, `src/hooks/*` | ⚠️ most minimal of six → #51 |
| 11 | Todo / task-list tool (`todowrite`), re-injected per turn | cross-cutting | not yet built | 💡 missing → #52 |

---

## 1. Decoupled headless runtime (Cline SDK)

Cline's 2026 rewrite extracted the agent loop into an **SDK runtime** — a shared service
that the VS Code extension, CLI, and other surfaces subscribe to, rather than a loop baked
into the UI. Their stated wins: simplified loop, tighter context management, better
feedback/error handling.

**Orin already does this** — `runLoop` is headless and emits to a sink (`src/agent/events.ts`),
and the TUI is just one subscriber (§5). This is validation, not a change. **Action:** keep
the discipline; resist letting TUI concerns (e.g. the removed mid-session sandbox toggle in #48) leak loop
semantics. A thin programmatic entrypoint that drives `runLoop` without the TUI would make
Orin embeddable the way the Cline SDK is — low-cost, high-leverage if headless/CI use is ever wanted.

## 2. Plan / Act + diff preview

Cline's **Plan** mode reads and reasons only; **Act** executes with per-step approval, and
every file change is shown as a **diff before applying** and every command is shown before
running. This is essentially Orin's Phase 4 approval modes (`normal` / `auto-accept` / `plan`).

**Refinement worth stealing:** Cline shows the diff *as the approval prompt itself* — the
human approves the exact rendered diff, not just "edit `foo.ts`? y/n". Orin renders diffs
(Phase 5) and gates edits (Phase 4); make sure the approval prompt for `edit`/`write`
embeds the rendered diff so approval and preview are the same surface.

## 3. Robust diff editing — the biggest concrete win

This is where Cline and Roo have invested the most, and where Orin's `src/edit/replacers.ts`
has clear gaps. Orin today ships the opencode-style matcher chain (`simpleMatch` →
`lineTrimmedMatch` → `blockAnchorMatch` → `whitespaceNormalizedMatch` →
`indentationFlexibleMatch` → `escapeNormalizedMatch` → `levenshteinMatch`, dispatched by
`findMatch`). That covers *whitespace/escape drift* on a single block. Cline/Roo add three
things Orin lacks:

1. **Line-number hints / anchors.** Roo's `MultiSearchReplaceDiffStrategy` accepts a
   `:start_line:` marker per search block. It tries an exact match at the hint first, then
   expands to a buffered window around it. This disambiguates **non-unique** `oldText` —
   exactly the case Orin's exact-unique matcher *rejects* today. Big reliability gain on
   repetitive code.
2. **Order-invariant multi-block apply with a running delta.** Multiple SEARCH/REPLACE
   blocks are sorted by line number and applied with a running offset so earlier edits don't
   invalidate later line numbers — and Cline's "order-invariant multi-diff apply" tolerates
   the model emitting blocks out of order. Orin's `edit` takes `{ edits: [...] }` but applies
   against the original with an exact-unique constraint; adopting the sorted-with-delta apply
   would let one `edit` call land several overlapping-region changes reliably.
3. **Middle-out fuzzy search + Levenshtein-normalized similarity threshold.** When the line
   hint fails, Roo searches **outward from the file midpoint** in both directions, scoring
   candidate chunks by Levenshtein similarity (0–1, default threshold 1.0 = exact, loosened
   under tolerance). Orin has `levenshteinMatch` but runs it as a last-resort whole-block
   scan; the middle-out scan with a tunable threshold is a more scalable version.

Plus two model-facing notes:
- **Per-model diff format.** Cline ships multiple block delimiters because models differ
  (`-----`/`+++++` vs `<<<<<`/`>>>>>`); Anthropic models do best with one, Gemini/xAI with
  another. Relevant once Orin grows beyond OpenRouter (the §6 provider issues #41–#46) or
  adds dumb-model support (Phase 8).
- **Diagnostic-rich failure.** On no-match, Roo returns similarity scores + surrounding
  context so the *model* can self-correct on the next turn. Orin's `findMatch` throws a name
  list; returning a structured "closest candidate + score" `isError` would feed Orin's
  self-correction path (`src/provider/tool-call-parser.ts`) far better.

**Action:** track as Phase 6 enhancements — line hints, sorted-delta multi-block apply, and
diagnostic-rich mismatch output are the three highest-value, well-scoped additions.

## 4. Modes + tool groups + `fileRegex` (→ Phase 8 presets)

Roo defines **modes** (Architect, Code, Debug, Ask, Orchestrator); each mode is bound to a
set of **tool groups** — `read`, `edit`, `command`, `browser`, `mcp` — that gate which tools
it may call. The `edit` group can carry a `fileRegex` restriction (e.g. `\.md$` → "this mode
may only edit markdown"). Kilo replaced the fixed groups with explicit **allow / ask / deny
glob rules**.

Maps directly onto Orin's Phase 8 **agent presets** (`src/agent/presets.ts` in #36): Orin's
`explore`/`review`/`implement` presets with `pickTools([...])` are the same idea as mode→tool-group
binding. Two things to borrow:
- **`fileRegex`-style edit scoping** for a preset, so a scoped subagent can be allowed to
  write *only* a subtree — a finer guard than the binary read-only/mutating split in #36.
- **Kilo's allow/ask/deny glob model** is essentially a richer approval policy; it's a good
  template if Orin's `src/approval/policy.ts` ever needs per-path granularity (and it composes
  with the `before_tool` hook from Phase 10).

## 5. Orchestrator / `new_task` / Boomerang — closest match to #36/#37

Kilo's **Orchestrator mode** (formerly Roo's **Boomerang Tasks**) is the most directly
relevant prior art for Orin's subagent/`task` tool. Mechanics (from Roo's tool + docs):

- A **`new_task(mode, message)`** tool spawns a subtask: a child agent run with its **own
  isolated conversation history** (not a slice of the parent's).
- The **parent pauses** while the child runs; on completion the child returns **only a
  summary** (via `attempt_completion`), and the parent **resumes with that summary** folded
  back in. This keeps the parent context clean — the child's step-by-step churn never enters it.
- Each subtask runs **in a chosen mode**, so it inherits that mode's tool-group restrictions.
- **Depth limit:** subagents **cannot spawn subagents** — only the primary agent creates
  subtasks (effectively depth 1).
- Roo/Kilo run subtasks **serially, in-process** — same runtime, no sandbox per child.

This is almost exactly the design already written into **#36**: nested `runLoop()`, fresh
child `AgentContext`, preset → tool subset, parent gets `lastAssistantText`, depth guard
(no recursive `task`). Cross-checks worth noting:

- **Validation:** Orin's #36 design matches Kilo on isolation-of-context, summary-return, and
  depth-1 — good signal the plan is sound.
- **Where Orin goes further (and should):** Kilo's parallelism story is weak — subtasks are
  serial and **share the host workspace via isolated *context* only**, not isolated
  *filesystem*. Orin's #37 (sandbox-per-child via E2B) is a genuine improvement: it's what
  lets children run **in parallel** without colliding on the working tree, which Kilo can't
  safely do. So Orin should *not* copy Kilo's "serial + shared tree" model for parallel work —
  the #37 sandbox-per-child rule is the right call, and this study reinforces it.
- **Borrow:** Kilo's `attempt_completion`-style **explicit "done + summary" signal** from the
  child is cleaner than implicitly grabbing the last assistant text. Consider a small
  convention that the child's final turn is a structured summary (result + optional diff/patch),
  which #37 already wants for folding parallel results back.

## 6. Checkpoints via shadow git (new idea — candidate issue)

Cline commits the **entire workspace** (including untracked files) to a **separate shadow git
repo** after each tool use, leaving the project's real git history untouched. Users can diff
and **restore to any checkpoint** within a task. Components: `CheckpointTracker` (git logic) +
`TaskCheckpointManager` (task coordination).

This is a strong, *currently-missing* Orin capability and it's directly relevant to #48
(mid-session sandbox toggle removed): shadow-git checkpoints give the **main agent** a safety net **on the
local tree** — per-tool snapshots + instant restore — **without** E2B's clone-from-origin
problems (lost uncommitted work, no edit flow-back). Sandbox isolation (Phase 9) and shadow
checkpoints solve *different* halves of "let the agent do risky things safely": sandbox =
contain blast radius for untrusted/parallel work; checkpoints = cheap undo for trusted local work.

**Action:** open a new issue — "Workspace checkpoints (shadow git) for local-tree undo" —
scoped to commit workspace state to `~/.orin/checkpoints/<session>` after each mutating tool,
with a `/restore` command. Complements rather than competes with #48 and Phase 9.

## 7. Context condensing (→ Phase 7 compaction)

Cline and Roo both summarize-then-replace when nearing the window. Concrete details from Roo's
`condense` module and Cline's docs:

- **Trigger:** a threshold as a fraction of the context window (Cline's `autoCondenseThreshold`,
  0–1; Roo enforces a minimum gap of ≥2 messages since the last summary). Cline's truncation
  headroom formula: `maxAllowedSize = max(contextWindow - 40_000, contextWindow * 0.8)`.
- **Summarize, don't just drop:** a dedicated **CONDENSE prompt** ("summarization-only — do
  NOT call tools") produces a structured summary that **preserves technical details, code
  changes, and decisions**.
- **Fresh-start replacement, non-destructive:** the summary (a single synthetic message)
  **replaces** prior turns for the API view; the originals are **tagged** (`condenseParent`)
  and filtered out by `getEffectiveApiHistory()` but **kept on disk** for rewind. Zero
  recent messages are retained verbatim in Roo's "fresh start" model.

Orin's `src/agent/compaction.ts` already does the core of this — `COMPACT_THRESHOLD = 0.85`,
a `SUMMARY_SYSTEM` prompt preserving "decisions, file paths, errors, current task state",
turn slicing (`sliceTurns`), large-tool-result elision (`>2000` tokens), and a keep-last-K/N
window. Two refinements from Cline/Roo:

1. **Decouple the API view from the on-disk log (non-destructive condense).** Orin persists
   full JSONL session logs (`src/session/log.ts`) — lean into that: compaction should be a
   *presentation-layer* transform over an untouched log, like Roo's `condenseParent` tagging +
   `getEffectiveApiHistory()`. This makes "rewind past a compaction" possible and keeps resume
   (#32) faithful.
2. **A manual `/compact` command.** Cline exposes `/smol` (= `/compact`) so users can condense
   on demand inside the same session (no handoff). Cheap to add to `src/tui/commands.ts` and
   genuinely useful before a big new sub-task. Orin already has the machinery; it just isn't
   user-triggerable.

Orin's **tool-result elision** (`ELIDED_PREFIX`, `>2000` token threshold) is a nice lever
Cline/Roo don't emphasize and pairs well with RTK (§2.1) — worth keeping.

## 8. Rules files in the system prompt (→ Phase 10 `before_prompt`)

Cline injects **`.clinerules`** markdown into the system prompt **before every interaction**
so a repo can teach the agent its conventions. This is *exactly* Orin's `before_prompt` hook +
an `AGENTS.md` — the SPEC names this as the hook's canonical use, and **the hook is already
shipped** (`src/hooks/registry.ts`, fired at `src/agent/loop.ts:210`). **Action:** ship a
built-in `before_prompt` handler that discovers and injects `AGENTS.md` (this repo already has
one — natural fit), registered in `src/hooks/install.ts`. No new infrastructure needed. See the
full six-agent comparison in §10 and tracking issue **#51**.

## 9. MCP governance (→ Phase 11)

Both expose MCP as a first-class capability; Roo gates it as its own **`mcp` tool group** so a
mode can be denied MCP entirely. Orin's Phase 11 (#10) already plans to route every MCP tool
through the approval gate and `before_tool` hook (untrusted-by-default). The borrowable idea is
**group-level MCP gating** — let a preset/mode turn MCP off wholesale, not just per-tool —
which composes with the preset tool-filtering in #36.

## 10. System-prompt management (all six agents → #51)

> This section broadens beyond Cline/Kilo to the three SPEC references too (**pi**,
> **nanocoder**, **opencode**), because "do these agents even have a system prompt, and how do
> they manage it?" only makes sense compared across the whole field. Short answer: **all six
> have one** — "no system prompt" isn't a thing for a serious agent. What differs is *size* and
> *how it's assembled*, on a spectrum from tiny/user-owned (Orin, pi) to large/dynamically
> composed per model (opencode, Cline, Roo/Kilo).

| Agent | Size | Assembly | Stored as | Project rules | Per-model | Per-role |
|-------|------|----------|-----------|---------------|-----------|----------|
| **Orin** (today) | tiny (1 line) | static string | config value (`config.ts:87`) | ❌ none | ❌ | ✅ sub-prompts only |
| **pi** | minimal | `buildSystemPrompt()` sections | code + `SYSTEM.md` | ✅ `AGENTS.md` | ❌ | ✅ agents |
| **nanocoder** | medium | composable section files | `source/app/prompts/sections/*` | ✅ `AGENTS.md` | ❌ | ✅ subagents |
| **opencode** | large | `prompt.ts` orchestrator | `.txt` per provider | ✅ `AGENTS.md`/`CLAUDE.md` | ✅ by model id | ✅ agents |
| **Cline** | large | code builder | `src/core/prompts/*` | ✅ `.clinerules` | ✅ diff format | ✅ Plan/Act |
| **Roo/Kilo** | large | section functions | code + override files | ✅ `.roo/rules` | ~ | ✅ modes |

**Per-agent detail**

- **opencode — most dynamic.** Orchestrator `session/prompt.ts` assembles: *provider header
  (optional spoofing) → a provider-specific prompt `.txt` chosen by model id (`anthropic.txt`
  for Claude, `beast.txt` for GPT/o1/o3, `gemini.txt`, `codex_header.txt` for GPT-5,
  `qwen.txt` fallback) → environment block (model, cwd, platform, date) → custom instructions →
  agent prompt → user `--system` override*. `instruction.ts` walks the tree for
  `AGENTS.md`/`CLAUDE.md` (project → package → global `~/.opencode/AGENTS.md`), scoped to each
  file's subtree.
- **Cline — large, rules-injected.** Built in code (tool descriptions, capabilities, MCP info,
  env details); `.clinerules` markdown injected before every interaction; Plan vs Act are
  different framings.
- **Roo/Kilo — most modular.** A **per-mode** prompt from named sections (`roleDefinition` +
  `markdownFormattingSection` + `getSharedToolUseSection` + `getToolUseGuidelinesSection` +
  `getCapabilitiesSection` + `getModesSection` + `getSkillsSection` + `getRulesSection` +
  `getSystemInfoSection` + `getObjectiveSection` + `addCustomInstructions`). Standouts:
  **conditional MCP inclusion** (only when the mode has the `mcp` group *and* a server is
  registered) and a full per-mode **override file**.
- **pi — minimal by design, but structured.** `buildSystemPrompt()`: identity → tool list
  (one-line snippets) → **guidelines that vary by which tools are actually available** →
  pi-doc refs (only when discussing pi) → project files wrapped as `<project_instructions
  path=...>` → skills → env (date, cwd). `AGENTS.md` loaded from `~/.pi/agent/`, parent dirs,
  cwd; `SYSTEM.md` replaces/appends the default; a `before_agent_start` hook exposes
  `systemPromptOptions` for programmatic rewriting.
- **nanocoder — composable sections.** Monolithic `main-prompt.md` was split into
  `source/app/prompts/sections/*` (identity, core principles, coding practices, file editing,
  tool rules, diagnostics, task management). `AGENTS.md` via `/init`, auto-loaded every session;
  `agents.config.json` augments or replaces built-in sections.

**Where Orin stands.** The most minimal of the six, deliberately: the whole system prompt is
one config string (`src/config/config.ts:87`, *"You are Orin, a coding agent…"*), user-overridable
via `~/.orin/config.json`, passed as `options.system` → `src/provider/stream.ts:90`. Two things
Orin already gets *right*: tool docs stay **out** of the system prompt (they ride the `tools`
param from `src/tools/*.txt`), and it already has **per-role sub-prompts** (`SUMMARY_SYSTEM`,
`DELEGATE_READ_SYSTEM`, and the `explore`/`review`/`implement` prompts in #36). What's missing vs
the others: `AGENTS.md` auto-loading, an environment block, sectioned assembly, and per-model
variants.

**Reusable best practices.** (1) Sectioned assembly beats a monolith — enables conditional
blocks (Roo's MCP-only-if-present). (2) Keep prompt text out of code in `.txt`/`.md` (Orin does
this for tools, not the base prompt). (3) `AGENTS.md` is the de-facto standard for project rules
— walk up the tree, scope to subtrees, load every session; **all five references support it,
Orin doesn't read its own**. (4) Inject a dynamic env block (cwd/date/model/platform). (5)
Per-model prompt variants matter once you support many providers. (6) Always provide an override
escape hatch (`--system`, `SYSTEM.md`, replace-mode) — Orin's config string covers this.

**Action:** the `before_prompt` hook is already shipped (§8), so the highest-value gap —
`AGENTS.md` injection + an environment block — is a built-in handler, not new infrastructure.
Tracked in **#51**; coordinate with #36 (per-preset prompts apply to child loops?) and #41–#46
(per-model/provider variants).

## 11. Todo / task-list tools and their relationship to version control (→ #52)

> Broadens to all references plus **Claude Code**, since the todo/task-list tool is one of the
> most universal agent primitives and the question "how does it relate to version control?" only
> resolves by comparing the field.

Every serious agent ships a **todo tool** — a structured, multi-step task list the model writes
and updates to anchor long work. It's the cheapest, highest-leverage planning primitive.

| Agent | Tool | Storage | In version control? |
|-------|------|---------|---------------------|
| **Claude Code** | `TodoWrite` | session memory, injected into the prompt after each tool call | ❌ ephemeral (dies on `/clear`) |
| **opencode** | `todowrite` / `todoread` | session state | ❌ |
| **Roo/Kilo** | `update_todo_list` | session/task state → **REMINDERS table in `environment_details`** each turn | ❌ |
| **Cline** | Focus Chain | **markdown file** in app globalStorage (not the repo); badge `3/8`; human-editable | ❌ (not in repo) |
| **nanocoder** | `/tasks` + tools | session task store | ❌ |
| **pi** | extensions only (`write_todos`/…) | varies (some add session persistence) | ❌ |

**The consistent contract.** A single **whole-list-replace** tool (not append); statuses
`pending | in_progress | completed | cancelled`; **exactly one `in_progress`** at a time; used only
for **3+ distinct steps** ("when in doubt, use it" — opencode); and **re-injected into context every
turn** so the model always sees its own plan. Several skip a separate `todoread` entirely because
the list is always present.

**The version-control relationship — the deliberate finding.** All of them keep the todo **out of
version control.** It's treated as *session-scoped working memory*, not project state — putting it in
the repo creates diff churn and merge conflicts. Even Cline, which stores the focus chain as a *file*,
puts it in **app storage, not the repo**, and keeps its real VC story in separate artifacts
(`.clinerules` = version-controlled rules; **shadow-git checkpoints** = workspace snapshots, see §6).
Todo and git stay in different lanes.

What the todo needs instead of git is **durability**, via three VC-adjacent seams:
1. **Survives compaction** — re-injected from a side store, so it's independent of the compacted
   history (Cline's focus chain "persists through summarizations"; Claude Code's list "survives even
   context compression").
2. **Survives resume** — rebuilt from the persisted session transcript.
3. **(Optional) checkpoint tie-in** — *only if* the list is materialized as a tree file would a
   workspace snapshot capture it, letting a restore also roll back plan state. Most agents don't do
   this; it's the one place a real VC tie-in exists.

**Design for Orin (#52).** Orin has no todo tool, but the substrate is in place. Recommended:
- A `todowrite` tool (`src/tools/todowrite.ts` + `.txt`), opencode-style contract, enforcing ≤1
  `in_progress`. No `todoread`.
- **Ephemeral session state by default** (a `todos` field on the session store / `AgentContext`),
  persisted to the session JSONL — *not* a repo file.
- **Per-turn re-injection via a built-in `before_prompt` handler** — the hook is already shipped
  (`src/hooks/registry.ts`, `src/agent/loop.ts:210`); register alongside the #51 AGENTS.md/env handler.
- **VC stance:** out of git by default, with an **optional `.orin/todo.md` export** for a
  human-editable, committable plan — the single real VC tie-in, and the one todo artifact a #50
  shadow-git checkpoint would capture.
- **Durability:** survive compaction (#5) and rebuild on resume (#32); **exclude from subagent
  presets** by default (#36, following opencode); render as a TUI progress widget (#33).

---

## Recommended follow-ups (concrete)

1. **Phase 6** — add to `src/edit/replacers.ts` / `edit.ts`: (a) `:start_line:` anchors,
   (b) sorted-with-running-delta multi-block apply, (c) diagnostic-rich mismatch `isError`
   feeding `tool-call-parser` self-correction. *(highest-value, well-scoped)*
2. **New issue** — Workspace checkpoints (shadow git) for local-tree undo + `/restore`;
   cross-link #48 and Phase 9 as complementary, not overlapping.
3. **Phase 7** — make compaction non-destructive over the JSONL log (Roo `condenseParent`
   pattern) and add a manual `/compact` command.
4. **Phase 8 (#36/#37)** — adopt `fileRegex`-style edit scoping for presets; add a structured
   child "done + summary/diff" completion convention; keep sandbox-per-child for parallel
   (do **not** copy Kilo's serial/shared-tree model).
5. **Phase 10 (#51)** — ship a built-in `before_prompt` handler that injects `AGENTS.md` +
   an environment block (cwd/date/model/platform); the hook is already shipped, so this is a
   handler + registration, not new infrastructure. See §10 for the six-agent comparison.
6. **Todo tool (#52)** — `todowrite` (session-scoped, ≤1 `in_progress`), re-injected each turn
   via the same `before_prompt` seam; kept out of git by default with an optional `.orin/todo.md`
   export as the one VC tie-in (captured by #50 checkpoints). Survive compaction (#5) / resume
   (#32); exclude from subagent presets (#36). See §11.

## Sources

- [Cline SDK: the upgraded agent runtime](https://cline.ghost.io/introducing-cline-sdk-the-upgraded-agent-runtime/)
- [Cline — Improving Diff Edits by 10%](https://cline.bot/blog/improving-diff-edits-by-10)
- [Cline docs — Checkpoints](https://docs.cline.bot/core-workflows/checkpoints) · [DeepWiki — Checkpoints & Snapshots](https://deepwiki.com/cline/cline/10.1-checkpoints-and-snapshots)
- [Cline docs — Auto Compact](https://docs.cline.bot/features/auto-compact) · [Cline — context engineering](https://cline.bot/blog/how-to-think-about-context-engineering-in-cline)
- [Roo Code — apply_diff tool](https://docs.roocode.com/advanced-usage/available-tools/apply-diff) · `RooCodeInc/Roo-Code` `src/core/diff/strategies/multi-search-replace.ts`
- [Roo Code — Boomerang Tasks](https://docs.roocode.com/features/boomerang-tasks) · [Kilo — Orchestrator Mode](https://kilo.ai/docs/basic-usage/orchestrator-mode) · [Kilo — New Task Tool](https://kilocode.ai/docs/features/tools/new-task)
- [Roo Code — Customizing Modes](https://docs.roocode.com/features/custom-modes/) · [Roo→Kilo migration (modes/permissions)](https://kilo.ai/articles/roo-to-kilo-migration-guide)
- `RooCodeInc/Roo-Code` `src/core/condense/` (CONDENSE prompt, `condenseParent`, `getEffectiveApiHistory`)
- [Kilo Code — Context Engineering explained](https://medium.com/@jasonyang.algo/context-engineering-explained-how-kilo-code-manages-context-a3126d97d44f)
- System prompts (§10): [opencode system prompts](https://github.com/bgauryy/open-docs/blob/main/docs/opencode/05-system-prompts.md) · [opencode prompt-assembly gist](https://gist.github.com/rmk40/cde7a98c1c90614a27478216cc01551f) · [Roo system-prompt generation (DeepWiki)](https://deepwiki.com/RooVetGit/Roo-Code/2.5-system-prompt-generation) · [pi `system-prompt.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts) · [nanocoder features](https://github.com/Nano-Collective/nanocoder/blob/main/docs/features/index.md)
- Todo tools (§11): [opencode `todowrite.txt`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/todowrite.txt) · [opencode tools docs](https://opencode.ai/docs/tools/) · [Roo `update_todo_list`](https://docs.roocode.com/advanced-usage/available-tools/update-todo-list) · [Roo Task Todo List](https://docs.roocode.com/features/task-todo-list) · [Cline Focus Chain](https://docs.cline.bot/features/focus-chain) · [Claude Code Tasks vs TodoWrite (DeepWiki)](https://deepwiki.com/FlorianBruniaux/claude-code-ultimate-guide/7.1-tasks-api-vs-todowrite)
