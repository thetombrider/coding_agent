# Reference study: Charm Crush

> Issue #327. Companion to SPEC.md's primary references (pi, nanocoder, opencode) and
> [`docs/reference/cline-kilo.md`](cline-kilo.md). This studies **Crush** — Charm's
> production terminal coding agent — for patterns relevant to Orin. Crush is Go + Bubble
> Tea; Orin is TypeScript + OpenTUI. The goal is to mirror the *approach*, not copy code
> (Crush is FSL-1.1-MIT; verify license before any direct port).

## Methodology & honesty note

This study is drawn from Crush's `README.md`, `AGENTS.md`, `docs/hooks/README.md`, and a
shallow clone of `charmbracelet/crush` (July 2026) with selective reads of `internal/agent/`,
`internal/hooks/`, `internal/lsp/`, `internal/skills/`, `internal/permission/`, and
`internal/config/`. It is an **architecture/patterns** study, not a line-by-line audit.
Where a Crush file/symbol is named, treat it as a pointer to verify after a local clone.
All `src/...` references to **Orin** are exact.

## Positioning (why Crush matters)

Crush sits in the same product category as Orin — a single-binary terminal agent with
tool-calling, approval gates, MCP, skills, and a polished TUI — but ships from Charm's
ecosystem (Bubble Tea, Lip Gloss, Glamour, `fantasy` LLM layer, Catwalk model catalog).
It is one of the most complete **native-terminal** agents in production (26k+ GitHub stars)
and shares DNA with opencode (OpenTUI) and pi (headless loop discipline) while adding
several features Orin has not built yet — most notably **LSP integration** and a
**client/server split** for detached operation.

```
pi / opencode / nanocoder  →  architectural references (SPEC.md)
Cline / Kilo               →  edit reliability, subtasks (cline-kilo.md)
Crush                      →  LSP, hooks UX, permissions granularity, TUI polish, client/server
```

---

## Pattern map → Orin phases

| # | Pattern (Crush) | Orin phase | Where in Orin | Status |
|---|-----------------|-----------|---------------|--------|
| 1 | Headless agent loop + pub/sub TUI | §5 loop | `src/agent/loop.ts`, `events.ts` | ✅ aligned |
| 2 | Dual-model tier (large/small) | §2.1 | `src/config/models.ts`, `delegate_read` | ✅ aligned (main/cheap + role routing) |
| 3 | Mid-session model switch preserving context | provider | `src/tui/session.ts`, `/model` | ✅ aligned |
| 4 | Self-documenting tools (`.md` / `.txt` descriptions) | §4 | `src/tools/*.txt` | ✅ aligned |
| 5 | Context files (`AGENTS.md`, `CRUSH.md`, `.cursorrules`, …) | Phase 10 | `src/hooks/prompt-inject.ts` | ⚠️ partial — Crush's list is wider |
| 6 | Agent Skills (agentskills.io) + progressive disclosure | skills | `src/skills/*`, `src/tools/skill.ts`, `skill-inject` hook | ✅ aligned |
| 7 | PreToolUse hooks (Claude Code–compatible) | Phase 10 | `src/hooks/*` `before_tool` | ⚠️ partial — Crush has richer hook protocol |
| 8 | Session-scoped permission grants (tool + action + path) | Phase 4 | `src/approval/policy.ts` | ⚠️ partial — no per-path memory |
| 9 | Edit + multiedit with post-edit LSP diagnostics | Phase 6 / new | `src/edit/*`, `src/tools/edit.ts` | ❌ no LSP layer |
| 10 | `lsp_diagnostics` tool + lazy LSP manager | new | — | 💡 highest-value gap |
| 11 | Background bash jobs (`run_in_background`, `job_output`, `job_kill`) | tools | `src/tools/bash.ts`, `bash-status`, `bash-kill` | ✅ aligned |
| 12 | Auto-background after N seconds on slow foreground cmds | tools | `src/tools/bash.ts` | 💡 Crush defaults 60s; Orin uses explicit `background: true` |
| 13 | SQLite session/message persistence | sessions | `src/session/*` (JSONL) | ✅ different trade-off (see §13) |
| 14 | Compaction via `Summarize` (summary message in DB) | Phase 7 | `src/agent/compaction.ts` | ✅ aligned; Crush also tracks `IsSummaryMessage` |
| 15 | Prompt queue while session busy | TUI | — | 💡 missing — user can't enqueue during a turn |
| 16 | `question` tool (structured user prompts in TUI) | approval / UX | approval bar only | 💡 missing — no multi-choice ask tool |
| 17 | `crush_info` introspection tool (config/LSP/MCP/skills dump) | meta | `/settings`, palettes | ⚠️ partial — no agent-callable introspection |
| 18 | Client/server via Unix socket / named pipe | detached agents | `src/ratel/*` (partial) | 🔜 informs headless/CI embedding |
| 19 | File read tracker (staleness hints) | context | — | 💡 missing |
| 20 | Edit file history service | checkpoints | `src/checkpoint/*` (shadow git) | ⚠️ different mechanism — both useful |
| 21 | Catwalk community model catalog | providers | `src/config/models.ts` (static defaults) | 💡 external catalog pattern |
| 22 | Cross-platform POSIX shell emulation (Windows) | bash | local shell only | 💡 Crush uses `mvdan.cc/sh` everywhere |
| 23 | `CRUSH=1` / `AGENT=crush` env markers on all shells | hooks / bash | — | 💡 cheap detectability for scripts |
| 24 | MCP shell expansion (`$VAR`, `$(cat secret)`) in config | Phase 11 | `src/mcp/*` | verify parity |
| 25 | Built-in `crush-config` / `crush-hook` skills | skills | builtin skills TBD | 💡 self-configuration via skills |

---

## 1. Headless loop + pub/sub (validation)

Crush's `Coordinator` (`internal/agent/coordinator.go`) owns the agent loop; the Bubble
Tea UI subscribes via `internal/pubsub`. Tools never touch the terminal. Orin's `runLoop`
(`src/agent/loop.ts`) + `AgentEventSink` (`src/agent/events.ts`) follow the same discipline.
**Action:** no change — Crush confirms the architecture.

## 2. Dual-model tier + role routing

Crush configures `SelectedModelTypeLarge` / `SelectedModelTypeSmall` per provider
(`internal/config/config.go`). Summarization and heavy reasoning use large; lighter work
can route to small. Orin maps this to **main** + **cheap** tiers and per-preset role
routing (`explore` → cheap, `implement` → code model, `review` → main) in
`src/config/models.ts` and `src/tools/task.ts`. Crush's **task** agent template
(`internal/agent/templates/task.md.tpl`) is a terse read-only subagent — analogous to
Orin's `explore` preset but with stricter output rules ("one word answers are best").

**Refinement worth noting:** Crush can switch provider/model mid-session while SQLite
retains full message history. Orin already supports `/model`; ensure compaction summaries
(`src/agent/compaction.ts`) survive model switches the way Crush's `IsSummaryMessage`
flag does in `internal/agent/agent.go`.

## 3. LSP-enhanced editing — the biggest concrete gap

Crush's standout differentiator vs Orin and most terminal agents:

- **Lazy LSP manager** (`internal/lsp/manager.go`): starts language servers on demand per
  file type; merges user `crush.json` LSP config with powernap defaults; retries after 30s
  if a server is unavailable.
- **`lsp_diagnostics` tool** (`internal/agent/tools/diagnostics.go`): returns project- or
  file-scoped diagnostics after edits; `view` opens files in LSPs read-only; `edit` and
  `multiedit` notify LSPs and wait for fresh diagnostics before returning.
- **`lsp_restart` tool**: operational recovery when a server wedged.

Orin lists LSP/plan-mode as out of scope in SPEC §1, but Crush demonstrates that even a
**thin** integration — diagnostics-only, no completions — materially improves edit quality
and gives the model actionable compiler errors without running `tsc`/`cargo check` every
turn.

**Recommended follow-up (new issue):** Phase-6+ optional LSP layer:
1. Config block in `~/.orin/config.json` mirroring Crush's `lsp` stanza.
2. Lazy client manager (consider `vscode-langservers-extracted` or `powernap` bindings).
3. `lsp_diagnostics` read-only tool + post-`edit` diagnostic append (not a new approval step).
4. Wire into `implement` preset only initially.

## 4. Edit / multiedit tools

Crush's `edit` (`internal/agent/tools/edit.go`) uses **search-and-replace** semantics
(`old_string` / `new_string`), same family as Orin's edit tool — not unified-diff blocks
(Cline-style). Differences from Orin worth stealing:

| Behavior | Crush | Orin |
|----------|-------|------|
| Empty `old_string` | create file | create file ✅ |
| Empty `new_string` | delete matched content | delete ✅ |
| `replace_all` flag | yes | verify `src/edit/replacers.ts` |
| `multiedit` (sequential ops, partial failure report) | yes (`FailedEdit` metadata) | single `edit` only |
| Post-edit LSP diagnostics in tool output | yes | no |
| Permission params include old/new **full file** content | yes (for diff preview) | diff in approval bar ✅ |

**Action:** (a) add `multiedit` or extend `edit` with an `edits[]` array for multi-hop
fixes in one approval; (b) continue Cline-style robustness work from `cline-kilo.md` §3;
(c) pair with LSP diagnostics when available.

## 5. Hooks — Claude Code compatibility + richer protocol

Crush ships **PreToolUse** hooks (`internal/hooks/`, `docs/hooks/README.md`) that are
**Claude Code–compatible**: shell commands receive `CRUSH_TOOL_INPUT_*` env vars, return
JSON on stdout with `decision`, `reason`, `updated_input`, `context`, and can **halt the
whole turn** (exit code 49). Hooks run **in parallel** but aggregate **in config order**
(deny > allow > none; shallow-merge `updated_input` patches).

Orin's hook registry (`src/hooks/registry.ts`) supports more lifecycle events
(`before_tool`, `after_tool`, `before_prompt`, `before_compact`, `session_start/end`) but
the **before_tool** surface is simpler: `{ block, reason }` or `{ args }` rewrite. RTK
rewrite (`src/hooks/rtk-rewrite.ts`) is the same idea as Crush's `updated_input`.

**Refinements worth stealing:**
1. **Hook metadata on tool results** — Crush attaches `HookMetadata` so the TUI shows a
   hook indicator (`internal/hooks/hooks.go`). Orin could emit a `hook` field on tool
   events for transparency.
2. **Explicit allow → skip permission** — Crush's `hookedTool` (`internal/agent/hooked_tool.go`)
   calls `permission.WithHookApproval(ctx, toolCallID)` when a hook returns `allow`,
   bypassing the interactive prompt. Orin's `approval-gate` hook could mirror this.
3. **Claude Code env compat** — accept `CLAUDE_TOOL_INPUT_*` aliases in hook runner for
   drop-in reuse of existing hook scripts.
4. **Sub-agents skip hooks** — Crush never fires hooks inside sub-agents; only the top-level
   `task` invocation is wrapped. Orin should document/enforce the same rule for `task` children.

## 6. Permissions — session-scoped, path-aware grants

Crush's permission service (`internal/permission/permission.go`) keys grants by
`(sessionID, toolName, action, path)` and supports `GrantPersistent` (remember for session)
vs one-shot `Grant`. Permission requests publish over pub/sub; the TUI resolves and notifies.

Orin's approval modes (`src/approval/policy.ts`: `normal` / `auto-accept` / `plan`) plus
`bash.autoApprove` prefix list cover the common cases but lack **per-path** memory ("always
allow edits under `src/tests/`"). Crush's model reduces prompt fatigue on long sessions.

**Action (low-cost):** extend `~/.orin/config.json` with optional
`approval.sessionGrants` or remember "allow for session" choices in the TUI approval bar
(keyed by tool + path prefix).

## 7. Skills — aligned with agentskills.io

Crush's `internal/skills/` implements the Agent Skills standard (same as Orin's
`src/skills/discovery.ts`): discover `SKILL.md` files, validate name/description, inject
an XML catalog into the system prompt (`AvailSkillXML` in `internal/agent/prompt/prompt.go`).
Crush adds:

- **Builtin skills** (`internal/skills/builtin/`) — e.g. `crush-config`, `crush-hook`
- **`user-invocable` / `disable-model-invocation` frontmatter flags**
- **Skill tracker** — tracks which skills were activated in-session (surfaced in `crush_info`)
- **Pub/sub on discovery** — TUI refreshes when skills change on disk

Orin's `skill-inject` hook and `/skills` palette are equivalent for discovery/activation.
**Action:** consider builtin `orin-config` skill and skill-activation telemetry in session
state (useful for debugging "why did the agent do X?").

## 8. Background bash jobs

Crush's bash tool (`internal/agent/tools/bash.go`) supports `run_in_background`,
`auto_background_after` (default 60s), `job_output`, and `job_kill`. Orin implemented the
same trio (`bash` + `bash_status` + `bash_kill` in `src/tools/`) with `wait_ms` for initial
tail collection. **Aligned.**

**Minor gap:** Crush auto-promotes slow foreground commands to background jobs after 60s;
Orin returns a timeout error and tells the model to retry with `background: true`
(`src/tools/bash.txt`). Auto-promotion is friendlier for naive model behavior but can
surprise users — if adopted, gate behind config.

## 9. `question` tool — structured user input

Crush exposes a `question` tool (`internal/agent/tools/question.go`) that blocks the agent
until the user answers via the TUI: `yes_no`, `single_choice`, `multi_choice`, `free_text`;
multi-question batches render as tabs. This is separate from permissions — it's for
*gathering requirements*, not *approving danger*.

Orin only has the approval bar for binary allow/deny on tool calls. A `question` tool would
let the agent run autonomously until it hits a genuine fork ("which auth provider?") without
fabricating defaults.

**Action (new issue):** `question` tool + TUI modal, pub/sub pattern mirroring Crush's
`internal/question/question.go`.

## 10. `crush_info` — agent-callable introspection

Crush gives the model a `crush_info` tool that dumps structured sections: config file paths,
staleness, models, providers, LSP state, MCP state, skills, hooks, permissions, disabled
tools. This lets the agent self-diagnose ("why isn't go LSP working?") without bash grep.

Orin exposes similar data via `/settings`, MCP palette, and skills palette — but **not** as
a tool the model can invoke. Useful for support flows and for the agent to re-read config
after the user edits `~/.orin/config.json` mid-session.

**Action (low-cost):** `orin_info` tool returning redacted config summary (no API keys).

## 11. Context file discovery

Crush loads a wide default list (`internal/config/config.go` `defaultContextPaths`):
`.github/copilot-instructions.md`, `.cursorrules`, `.cursor/rules/`, `CLAUDE.md`,
`GEMINI.md`, `CRUSH.md`, `AGENTS.md`, and `.local` variants — project + global, with
priority rules. Templates inject them into the system prompt via Go templates
(`internal/agent/prompt/prompt.go`).

Orin's `prompt-inject` hook loads `AGENTS.md` from repo root. **Gap:** Crush's breadth
means switching from Claude Code / Cursor / Crush to Orin preserves more user investment
in existing rules files.

**Action:** extend `src/hooks/prompt-inject.ts` (or `src/prompt/context-files.ts`) with the
same default path list; dedupe by priority; cap total injected bytes.

## 12. Client / server architecture

Crush runs a local HTTP server on a Unix socket / Windows named pipe
(`internal/server/server.go`, default `crush-<uid>.sock`). A separate client process can
attach — enabling detached runs, scripting, and potentially multiple UIs. The `workspace`
package exposes a unified API (`internal/workspace/workspace.go`) over sessions, agent runs,
LSP, MCP, and file tracking.

Orin's `src/ratel/*` module sketches remote/detached operation but there is no equivalent
local socket server for "drive Orin headlessly from another process."

**Action (Phase 9 / headless):** if CI or IDE embedding is wanted, a minimal Unix-socket
JSON API over `runLoop` (start run, stream events, approve tool) is the Crush-shaped design.

## 13. Persistence model — SQLite vs JSONL

Crush persists sessions and messages in **SQLite** via sqlc (`internal/db/`, `internal/session/`).
Messages flush incrementally during streaming; summaries are first-class rows (`IsSummaryMessage`).

Orin uses **append-only JSONL** per session (`~/.orin/sessions/<id>.jsonl`) — simpler,
human-grepable, git-friendly for debugging, and aligned with pi. Trade-offs:

| | Crush (SQLite) | Orin (JSONL) |
|---|----------------|--------------|
| Query "all user messages across sessions" | easy (`ListAllUserMessages`) | requires scan |
| Concurrent writers | DB locks | append-only safer |
| Compaction | summary row + retained tail | summary message in log ✅ |
| Corruption recovery | migrations + WAL | truncate/replay |
| Tooling | sqlc codegen | plain text |

**Action:** no migration needed — JSONL is a deliberate Orin choice. Borrow Crush's
`IsSummaryMessage` **semantics** (tag compacted summaries in JSONL metadata) if not already.

## 14. Prompt queue while busy

When a Crush session is mid-turn, new user prompts **enqueue** rather than interrupt
(`QueuedPrompts`, `QueuedPromptsList` on `Coordinator`; tested in
`internal/agent/queued_runid_test.go`). Each queued prompt runs as its own turn with its
own `RunComplete` event.

Orin's TUI typically blocks input or rejects sends while the agent is running. Enqueueing
is a UX win for power users who want to stack "now also fix the tests" without waiting.

**Action (TUI):** optional input queue with visible depth indicator; drain FIFO after each
turn completes.

## 15. File tracker + edit history

Crush tracks which files were read per session (`internal/filetracker/`) and maintains an
edit history service (`internal/history/`) used for permission previews and undo context.
The tracker informs staleness: re-read prompts when a file changed on disk since last read.

Orin's shadow-git checkpoints (`src/checkpoint/*`) cover **mutations** but not read
staleness. Combining both — "you read `foo.ts` 20 turns ago; it changed since" — reduces
bad edits without full LSP.

**Action (low-cost):** per-session mtime map on `read` tool; append warning on subsequent
`edit` if stale.

## 16. TUI / styling notes

Crush's UI (`internal/ui/`, documented in `internal/ui/AGENTS.md`) uses a three-layer
theme system (`quickstyle.go` → `themes.go` → `styles.go`), catwalk golden-file tests, and
Glamour for markdown. Orin's OpenTUI stack (`src/tui/theme.ts`, `markdown.tsx`) is
analogous. Worth studying for:

- **Compact mode** config flag
- **Diff view** component (`internal/ui/diffview/`) — ensure Orin approval embeds the same
  quality of rendered diff Crush shows pre-apply
- **Hook indicators** on tool call cards

No code port required — design reference only.

## 17. Provider / model catalog (Catwalk)

Crush sources its default model list from [Catwalk](https://github.com/charmbracelet/catwalk)
— a community-maintained JSON catalog of provider-compatible models. Providers are configured
in `crush.json` with `extra_headers`, `extra_body`, OAuth flows (Copilot, Hyper), and
shell expansion in secrets.

Orin hardcodes sensible defaults in `src/config/models.ts` and provider modules. A Catwalk-
style **external catalog** (even if Orin-hosted JSON fetched on demand) would reduce churn
when OpenRouter adds models.

**Action (optional):** fetch + cache a model catalog JSON; fall back to baked-in defaults
offline.

---

## Recommended follow-ups (concrete)

1. **New issue — LSP diagnostics layer** (§3, §4): lazy manager, `lsp_diagnostics` tool,
   post-edit diagnostic append. Highest-value Crush differentiator for Orin.
2. **Phase 10 — hook protocol parity** (§5): hook metadata on events, allow → skip permission,
   Claude Code env aliases, document subagent hook exclusion.
3. **Phase 10 — context file breadth** (§11): expand default rules file search paths to match
   Crush/Cursor/Claude Code conventions.
4. **New issue — `question` tool** (§9): structured user prompts (choices, yes/no, free text).
5. **Low-cost — `orin_info` tool** (§10): agent-callable redacted config dump.
6. **Phase 4 — session-scoped path grants** (§6): remember per-tool/path approvals for the session.
7. **TUI — prompt queue** (§14): enqueue user messages while agent is busy.
8. **Phase 6 — `multiedit`** (§4): sequential edits with partial-failure reporting.
9. **Tools — read staleness tracker** (§15): warn when editing files not read since mtime change.

## Sources

- [Crush README](https://github.com/charmbracelet/crush/blob/main/README.md)
- [Crush AGENTS.md](https://github.com/charmbracelet/crush/blob/main/AGENTS.md) — architecture map
- [Crush hooks docs](https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md)
- [Agent Skills standard](https://agentskills.io)
- [Catwalk model catalog](https://github.com/charmbracelet/catwalk)
- [Charm fantasy LLM layer](https://github.com/charmbracelet/fantasy) (provider abstraction)
- Orin: [`SPEC.md`](../../SPEC.md), [`docs/reference/cline-kilo.md`](cline-kilo.md), [`docs/skills-research.md`](../skills-research.md)
