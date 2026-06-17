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

---

## 1. Decoupled headless runtime (Cline SDK)

Cline's 2026 rewrite extracted the agent loop into an **SDK runtime** — a shared service
that the VS Code extension, CLI, and other surfaces subscribe to, rather than a loop baked
into the UI. Their stated wins: simplified loop, tighter context management, better
feedback/error handling.

**Orin already does this** — `runLoop` is headless and emits to a sink (`src/agent/events.ts`),
and the TUI is just one subscriber (§5). This is validation, not a change. **Action:** keep
the discipline; resist letting TUI concerns (e.g. the `/sandbox` swap in #48) leak loop
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
`explore`/`review`/`general` presets with `pickTools([...])` are the same idea as mode→tool-group
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

This is a strong, *currently-missing* Orin capability and it's directly relevant to the #48
`/sandbox` discussion: shadow-git checkpoints give the **main agent** a safety net **on the
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
so a repo can teach the agent its conventions. This is *exactly* Orin's Phase 10 `before_prompt`
hook + a `CONVENTIONS.md` — the SPEC already names this as the hook's canonical use. **Action:**
when Phase 10 lands, ship a built-in `before_prompt` handler that reads a project rules file
(`AGENTS.md` already exists in this repo — natural fit) and appends it. No new design needed;
this just confirms the hook shape is right.

## 9. MCP governance (→ Phase 11)

Both expose MCP as a first-class capability; Roo gates it as its own **`mcp` tool group** so a
mode can be denied MCP entirely. Orin's Phase 11 (#10) already plans to route every MCP tool
through the approval gate and `before_tool` hook (untrusted-by-default). The borrowable idea is
**group-level MCP gating** — let a preset/mode turn MCP off wholesale, not just per-tool —
which composes with the preset tool-filtering in #36.

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
5. **Phase 10** — ship a built-in `before_prompt` rules-file handler (read `AGENTS.md`).

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
