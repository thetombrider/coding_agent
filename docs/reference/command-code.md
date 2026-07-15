# Reference study: Command Code

> Issue #413. Companion to [`crush.md`](crush.md) and
> [`cline-kilo.md`](cline-kilo.md). This study focuses on Command Code's
> **Taste** learning system and maps its observable patterns to Orin.

## Methodology and audit limits

This study uses Command Code's public documentation, changelog, npm package
metadata, and the public GitHub repository as of July 2026.

The repository is not an open-source implementation: its `main` tree contains
the README, issue templates, and brand assets, but no application source.
`command-code@0.44.1` publishes an `UNLICENSED`, bundled CLI. The separate
`taste@0.5.1` package is Apache-2.0, but delegates learning operations to
Command Code rather than implementing the learning algorithm.

Consequently:

- storage paths, commands, configuration precedence, package operations, and
  hook protocols are documented behavior;
- private request routes and subsystem names visible in the bundle can confirm
  that a client/backend integration exists, but not how it works;
- signal classification, confidence updates, decay, retrieval, and any claimed
  reinforcement learning are **not independently auditable**;
- the performance claims on the Taste page are marketing claims, not evidence
  suitable for Orin design decisions.

This is therefore a product-pattern study, not a source audit. Orin should
reimplement useful ideas from first principles and must not copy the bundled
Command Code code.

## Executive conclusion

Command Code's most useful observable idea is not “continuous RL.” It is a
portable, human-readable preference layer between static instructions and
reusable skills:

| Layer | Command Code | Purpose |
|---|---|---|
| Instructions / “memory” | `AGENTS.md` | Explicit project and user rules |
| Taste | `taste.md` packages | Learned, confidence-scored preferences |
| Skills | installed skill packages | Reusable procedures and capabilities |
| Session | JSONL transcript | Current and resumable conversation |

Orin already has instructions, skills, and JSONL sessions. It lacks the Taste
layer. The best adaptation is a **reviewed preference ledger**: extract only
high-signal preferences and corrections, preserve provenance, require human
review before activation, and inject a bounded relevant subset into prompts.

Do not start with opaque automatic learning from every accept/reject/edit.
Orin currently has no reliable “accept” signal, and silence after an edit does
not mean the user endorses the implementation pattern.

## Pattern map

| # | Command Code pattern | Orin today | Recommendation |
|---|---|---|---|
| 1 | Project and global Taste scopes | Project/global skills, no preferences | Add project/global preference ledgers |
| 2 | Human-readable Markdown packages | Skills and instructions use Markdown | Keep preferences inspectable and editable |
| 3 | Confidence per learning | No learned facts | Keep confidence, but also store provenance |
| 4 | Category packages (`cli`, `typescript`, …) | Skills are directories | Begin with one ledger; split only at scale |
| 5 | Background learning enabled by default | No extraction loop | Start opt-in or review-gated |
| 6 | Explicit project/local/user precedence | Config has scoped settings | Reuse explicit precedence rules |
| 7 | Accept, reject, edit, prompt, correction signals | User messages and tool outcomes exist | Initially trust explicit directives/corrections only |
| 8 | Relevant Taste selected per session | All `AGENTS.md` files are injected | Add token-bounded lexical retrieval |
| 9 | `/learn-taste` imports prior agent sessions | Orin has replayable JSONL | Add an explicit offline import command later |
| 10 | Repository-history learning | Git is available to tools | Treat as explicit bootstrap, not background work |
| 11 | Lint validates structure/confidence | Skill parser validates frontmatter | Add schema validation before activation |
| 12 | Push/pull/merge packages | No knowledge registry | Defer remote sync; Git already shares project data |
| 13 | `/taste` manages enablement and usage | `/settings`, skills palette | Add review UI before automatic writes |
| 14 | `/memory` edits `AGENTS.md` | Orin discovers nested/global `AGENTS.md` | Orin is already stronger on nested discovery |
| 15 | User-extensible process hooks | Built-in TypeScript hooks only | Useful separate follow-up, not needed for learning v1 |
| 16 | Headless transcripts isolated from interactive lists | One session store | Interesting automation UX, unrelated to learning |

## 1. What Taste demonstrably stores

The Taste documentation describes three scopes:

```text
project: .commandcode/taste/
global:  ~/.commandcode/taste/
remote:  commandcode.ai/<namespace>/taste
```

A project can contain a main `taste.md` and category packages:

```text
.commandcode/taste/
├── taste.md
├── cli/taste.md
├── typescript/taste.md
└── architecture/taste.md
```

The documented examples are Markdown preferences with confidence values between
zero and one. `taste lint` checks Markdown structure, required fields, header
format, confidence bounds, and UTF-8 encoding. Push/pull merges new learnings,
updates changed confidence values, and leaves identical learnings unchanged;
`--overwrite` replaces the target.

These properties are valuable independently of the private learner:

1. users can inspect and edit what the agent believes;
2. project preferences can be reviewed in Git;
3. category files permit progressive loading;
4. confidence offers a basis for ranking and conflict handling;
5. linting keeps a machine-consumed file recoverable.

## 2. What “learning” does and does not establish

The public Taste page says every accept, reject, and edit becomes a signal and
that learning runs in the background. `/learn-taste` imports sessions from
other coding agents, while the `taste` CLI exposes repository-history learning.
The shipped bundle also contains client-facing Taste request headers/routes and
logging names for learning/observer subsystems.

That evidence establishes a pipeline shape:

```text
interaction or import
  → observer / learner request
  → preference package update
  → relevant preferences used on later requests
```

It does **not** establish:

- how an edit is classified as approval, rejection, or neutral iteration;
- whether extraction is deterministic, prompt-based, or model-trained;
- how confidence increases, decreases, or decays;
- how contradictory preferences are resolved;
- how “relevance” is scored and token-budgeted;
- whether the local Markdown is the complete learned state;
- whether “reinforcement learning” means model-weight training.

The observable system is compatible with confidence-scored symbolic preference
extraction plus request-time context. Orin should design against that concrete
model, not the stronger marketing interpretation.

## 3. Signal quality is the central design problem

Command Code lists both explicit and implicit feedback. The distinction matters:

| Signal | Reliability | Safe Orin v1 behavior |
|---|---:|---|
| “Always use Bun in this repo” | High | Create project candidate |
| “I prefer concise status updates” | High | Create global candidate |
| “No, use an integration test” | High | Candidate with correction provenance |
| Repeated equivalent correction | High | Increase candidate confidence/evidence |
| User edits agent output | Medium | Record as evidence only after semantic comparison |
| User approves a tool call | Low | Approval is permission, not style endorsement |
| Tool succeeds | Very low | Never infer a preference |
| User says nothing after a change | None | Never infer acceptance |

Orin should begin with explicit directives and corrections because they are
auditable and cheap to explain. Implicit signals can be added only after the UI
can show why a candidate was inferred and let the user reject it.

## 4. Configuration and consent

Taste learning is on by default. Its documented precedence is:

1. `.commandcode/settings.local.json`
2. `.commandcode/settings.json`
3. `~/.commandcode/config.json`
4. default enabled

This cleanly separates personal project overrides, committed team settings, and
user defaults. The precedence pattern is worth adopting, but the default is not.
Learning creates durable state from conversation content; an Orin v1 should:

- default extraction off, or write only inactive candidates;
- never upload preferences;
- make project versus global scope explicit;
- display the source session and evidence;
- support one-command disable and deletion;
- avoid storing secrets, credentials, personal data, or raw code snippets.

## 5. Recall and context budgeting

Command Code says relevant Taste is loaded for a session, but its retrieval
algorithm is private. Orin's existing prompt pipeline offers two known options:

1. **Always inject a small active ledger.** Simple and compaction-resistant, but
   every preference consumes every model call.
2. **Retrieve a relevant subset.** Better at scale, but needs deterministic
   ranking and observability.

The recommended progression is:

- cap active preferences by characters/tokens;
- rank exact language/tool/path matches first;
- add BM25 retrieval using Orin's existing Ratel/catalog patterns;
- include preference IDs in the injected block so behavior can be explained;
- always include explicit project-wide invariants;
- never use vector infrastructure until lexical retrieval proves insufficient.

`before_prompt` hooks are recomputed each agent round, so injected preferences
survive compaction without changing the JSONL session format. Injection size is
already counted by Orin's compaction budget.

## 6. Import and portability

Command Code has two bootstrap paths:

- `/learn-taste` imports sessions from coding agents;
- `taste learn` delegates repository-history learning to Command Code.

Both are better as explicit commands than background startup work. Orin already
has append-only session logs under `~/.orin/sessions/`, so a future importer can:

1. scan user messages and immediately following assistant actions;
2. extract only explicit preferences/corrections;
3. group semantically equivalent statements;
4. emit candidates with session ID, timestamp, and quoted evidence;
5. show a review diff before activation.

Git history can bootstrap conventions, but it cannot reliably infer personal
preference. A repeated code pattern may be generated, legacy, or accidental.
Repository import should therefore create low-confidence candidates and include
commit/file provenance.

Remote package sync is not required initially. Project preferences can live in
Git, and global preferences can remain local. A registry adds authentication,
namespaces, merge policy, trust, and supply-chain concerns without improving the
core learning loop.

## 7. Memory, skills, and preferences in Orin

Orin's current layers are deliberately different:

| Orin mechanism | Current behavior | Missing piece |
|---|---|---|
| `AGENTS.md` / `SYSTEM.md` | Human-authored instructions, injected every round | No agent-learned entries |
| Skills | Project/global procedures, index injected, body loaded on demand | Wrong abstraction for small facts |
| Todos | Session plan, restored from transcript and re-injected | Not cross-session knowledge |
| Compaction summary | Preserves task state from older turns | Not durable or independently reviewable |
| Session JSONL | Complete append-only evidence | No extraction/index layer |

`skill_write` is already Orin's self-learning mechanism for multi-step
procedures. A preference such as “use Bun, not npm” should not become a skill:
it is too small, should always be available, and needs contradiction handling.

Nor should an automatic learner edit `AGENTS.md` directly. That file is an
authoritative human instruction surface. Mixing inferred rules into it obscures
ownership and makes false learning look mandatory.

## 8. Proposed Orin design: reviewed preference ledger

### Storage

```text
<repo>/.orin/preferences.md
~/.orin/preferences.md
```

Start with one file per scope. Category splitting can be introduced if the
ledger exceeds the injection/retrieval budget.

Each entry should contain:

```markdown
## prefer-bun
- Preference: Use Bun for dependency and script commands in this project.
- Status: active
- Confidence: 0.95
- Source: explicit-user
- Evidence: session mabc123, 2026-07-15
- Updated: 2026-07-15
```

Required fields should be parsed into a typed record. Preserve the evidence in
the session log rather than duplicating potentially sensitive text into the
ledger.

### Lifecycle

```text
explicit directive/correction
  → candidate (deduplicated, provenance attached)
  → user review: activate / edit / reject
  → bounded before_prompt retrieval
  → later correction updates or supersedes the entry
```

Rejections should be retained as tombstones or stable IDs so the same bad
inference is not repeatedly proposed.

### Integration points

| Concern | Orin integration |
|---|---|
| Discovery | New `src/preferences/discovery.ts`, mirroring skills/instructions |
| Parsing/lint | New typed parser with confidence/status validation |
| Injection | `before_prompt` hook after project instructions |
| Candidate extraction | Explicit command first; automated end-of-turn extraction later |
| Review | `/preferences` palette: pending, active, rejected |
| Writes | Approval-required primary-agent tool; no subagent writes |
| Retrieval | Character cap first, then Ratel/BM25 ranking |
| Session evidence | Existing JSONL session ID and timestamp |
| Config | enabled, scope defaults, max injected tokens, extraction mode |

### Guardrails

- no automatic activation in v1;
- no learning from tool approval, tool success, or silence;
- redact likely secrets before writing;
- reject entries that are commands, long code blocks, or task-specific facts;
- prevent nested-project preference files from escaping the repository root;
- make global writes visibly different from project writes;
- show active preference IDs in debug/session metadata;
- cap extraction retries and never block session completion.

## 9. Other useful Command Code patterns

### Process hooks

Command Code supports configured `PreToolUse`, `PostToolUse`, `Stop`, and
`SessionStart` subprocess hooks. Commands receive JSON on stdin and can deny or
rewrite tool use, add context, or request bounded end-of-turn revision.

Orin's in-process hook registry already has broader lifecycle coverage
(`before_tool`, `after_tool`, `before_prompt`, `before_compact`,
`session_start`, `session_end`) but no user-configured subprocess adapter.
A compatibility layer is useful for deterministic lint/policy integrations,
but it is independent of preference learning and should be a separate issue.

### Memory UX

Command Code's `/memory` command selects project or user `AGENTS.md` for
editing. Orin already discovers nested project `AGENTS.md` files plus a global
file, which is more expressive. A small selector/editor command could improve
discoverability without changing prompt semantics.

### Headless session separation

Command Code persists headless transcripts but hides them from the interactive
resume list. Orin could tag automation sessions similarly if headless use makes
the session palette noisy. This is useful UX, but unrelated to learning.

## Prioritized follow-ups

1. **P0 — Reviewed preference ledger.** Project/global storage, parser/lint,
   manual candidate creation, review UI, bounded prompt injection.
2. **P1 — Explicit session importer.** Scan Orin JSONL for directives and
   corrections, produce candidates, require review.
3. **P1 — Transparent retrieval.** BM25 relevance, stable IDs in prompt/debug
   output, token budget and always-on project invariants.
4. **P2 — Repository-history bootstrap.** Low-confidence candidates with commit
   provenance and strict secret/code filters.
5. **P2 — Configured subprocess hooks.** Separate compatibility feature for
   policy and quality gates.
6. **Defer — Remote preference registry and implicit-feedback learning.** Both
   add substantial privacy, trust, and correctness risk before local learning
   quality is established.

## Sources

- [Command Code GitHub repository](https://github.com/CommandCodeAI/command-code)
- [Command Code npm package](https://www.npmjs.com/package/command-code)
- [Taste overview, settings, storage, and commands](https://commandcode.ai/docs/taste)
- [Memory / `AGENTS.md`](https://commandcode.ai/docs/core-concepts/memory)
- [Hooks protocol](https://commandcode.ai/docs/hooks)
- [CLI reference](https://commandcode.ai/docs/reference/cli)
- [Headless sessions](https://commandcode.ai/docs/core-concepts/headless)
- [Command Code changelog](https://commandcode.ai/changelog)
- [Apache-2.0 `taste` npm package](https://www.npmjs.com/package/taste)
- Orin: [`skills-research.md`](../skills-research.md),
  [`src/hooks/types.ts`](../../src/hooks/types.ts),
  [`src/hooks/prompt-inject.ts`](../../src/hooks/prompt-inject.ts),
  [`src/tools/skill.ts`](../../src/tools/skill.ts),
  [`src/session/log.ts`](../../src/session/log.ts), and
  [`src/agent/compaction.ts`](../../src/agent/compaction.ts)
