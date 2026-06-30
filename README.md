# Orin

> A coding agent that lives in your terminal. Give it a prompt and it reads,
> edits, and runs your code on its own — pausing for your OK before anything risky.

<p align="center">
  <img src="docs/media/welcome.png" alt="Orin's interactive terminal UI welcome screen" width="760">
  <br>
  <em>The interactive TUI, shown in offline <code>--faux</code> demo mode.</em>
</p>

Point Orin at a task — *"fix the failing test in `src/foo`"* — and it searches the
codebase, reads the relevant files, makes edits, runs commands, and checks its own
work in a loop, streaming every step to an interactive UI. It's safe by default
(nothing is written or run without your approval) and cheap by design (the
expensive model thinks; a cheap one does the grunt work).

## Where Orin wins

Compared to the closest alternatives — [opencode](https://opencode.ai) (SST),
[pi.dev](https://pi.dev), and [Claude Code](https://claude.ai/code) — Orin makes
different trade-offs that pay off in cost, safety, and observability.

### BM25 tool pre-filtering per turn

Every turn, Orin runs a **BM25 retrieval pass** (via [Ratel](https://ratel.ai)) over
the full tool catalog — including MCP tools and skills — and exposes only the most
relevant tools to the model. The expensive model never sees a bloated catalog;
it sees the tools that match the current task. This cuts per-turn token cost and
reduces distraction-induced tool misuse. opencode, pi.dev, and Claude Code all use
static allow/deny lists — process-level configuration, not per-turn relevance
ranking. Built-in **A/B testing** (`tool_pool=ratel` vs `tool_pool=default`) lets
you measure the impact directly in your telemetry.

### E2B OS-level sandboxing

opencode, pi.dev, and Claude Code enforce safety through permission rules and
allow/deny lists — process-level controls that still run on your host. Orin's
`sandbox` isolation mode runs subagents in **E2B ephemeral cloud VMs**: the
subagent is fully isolated from your filesystem regardless of what it executes.
For untrusted tasks, that's a real isolation boundary, not a policy.

### Shadow-git `/undo` with broader bash coverage

opencode ships a git-backed `/undo` that has multiple open critical bugs and does
not track files modified directly by bash commands. Claude Code's checkpoint system
also does not capture bash-modified files. pi.dev's rewind is an extension, not a
built-in. Orin's **shadow-git snapshots** fire before every tool execution —
including bash — at the git level, so rollback coverage is broader and the
mechanism has no known gaps.

### Two-model cost split at the tool level

pi.dev and opencode route all work through a single model on every turn. Orin's
`delegate_read` tool hands read-heavy work — file reads, grep, find, ls — to a
**cheap model** in an isolated call. The cheap model never gets write tools; it
only returns a distilled summary. The main model stays focused on decisions. This
isn't a config option — it's wired into the tool set so the agent uses it
automatically. Claude Code has a related concept (Opus for planning, Sonnet for
execution via `opusplan`), but the split happens at the planning phase rather than
at individual tool calls.

### Native OTLP without plugins

pi.dev requires a Braintrust or Raindrop extension for OTLP. opencode requires a
community plugin. Orin ships **OTLP export natively** — every turn produces a trace
with child LLM spans (model, tokens, cost), tool spans (duration, ok/error), and
subagent spans, readable in Langfuse, Grafana Tempo, Arize Phoenix, or any OTLP
backend. Claude Code also ships OTLP natively; the difference is that Orin's local
metrics (`~/.orin/metrics.jsonl`) are always on with no environment variable
required, and content capture defaults are the same: off unless you opt in.

### Offline demo + EU provider

`orin --faux` runs the full TUI with scripted responses — no API key, no network.
None of the three competitors have an equivalent. Orin also ships **Regolo** as a
built-in provider: EU-hosted, OpenAI-compatible, and the only native EU option among
the four for GDPR-sensitive workloads.

### Comparison at a glance

| | Orin | opencode | pi.dev | Claude Code |
|---|:---:|:---:|:---:|:---:|
| Per-turn BM25 tool ranking | ✅ | ❌ | ❌ | ❌ |
| OS-level sandbox (E2B) | ✅ | ❌ | ❌ | ❌ |
| `/undo` incl. bash-modified files | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Two-model cost split | ✅ | ❌ | ❌ | ✅ |
| Native OTLP (no plugin) | ✅ | ❌ | ❌ | ✅ |
| Parallel subagents (worktree-isolated) | ✅ | ❌ | ❌ | ✅ |
| MCP server support | ✅ | ✅ | ⚠️ | ✅ |
| Offline demo mode | ✅ | ❌ | ❌ | ❌ |
| EU provider (Regolo) | ✅ | ❌ | ❌ | ❌ |
| Local / self-hosted models | ❌ | ✅ | ✅ | ❌ |
| LSP diagnostics fed back to model | ❌ | ✅ | ❌ | ❌ |
| IDE extensions | ❌ | ✅ | ❌ | ✅ |

⚠️ = partial or extension-only

---

## Highlights

- **Autonomous, with a seatbelt** — Orin drives the tools itself, but stops for
  approval before any file write or shell command. Flip between `normal`,
  `allow-all`, and read-only `plan` on the fly with `/mode`.
- **An undo button for the agent** — every change is snapshotted to a shadow git
  history, so `/undo` rolls your working tree back to any point in the session.
- **A genuine terminal UI** — streaming markdown, live unified diffs, a
  slash-command palette, a session browser, and a context-window meter, all in a
  reactive SolidJS component tree.
- **Cheap where it counts** — a capable main model reasons and edits; a cheap
  model handles read-heavy and exploratory work via `delegate_read`, so most tokens
  never touch your expensive context.
- **Parallel subagents** — `task_parallel` fans independent units of work out
  concurrently, each child in its own git worktree so siblings can't collide.
  Individual subagents can run in a shared tree, an isolated worktree, or an E2B
  cloud sandbox.
- **BM25 tool pre-filtering** — Ratel narrows the tool catalog to the most relevant
  tools per turn, cutting context bloat and per-turn cost. A/B testing is built in.
- **Full OTLP observability** — export traces to Langfuse, Grafana Tempo, Jaeger, or
  any OTLP backend. GenAI semantic conventions. Content capture is opt-in.
- **Bring your own model** — OpenRouter, Anthropic, OpenAI, and EU-hosted Regolo
  ship today; switch provider or model mid-session with `/providers` and `/model`.
  Per-role model slots (`explore`, `review`, `implement`) can each use different models.
- **MCP server support** — connect external MCP servers (GitHub, databases, etc.);
  their tools flow through the same approval gate and BM25 filter as native tools.
- **Tree-sitter symbol indexing** — `search_symbols` does structural codebase search
  (functions, classes, imports) backed by a persistent, cross-session cache.
- **Never loses the thread** — sessions are resumable append-only logs, context
  auto-compacts as the window fills, and a project `AGENTS.md` is picked up
  automatically.
- **Try it with no API key** — `orin --faux` runs the whole TUI offline with
  scripted responses.

## Quick start

```bash
git clone https://github.com/thetombrider/coding_agent.git
cd coding_agent
./install.sh        # installs Bun if needed, installs deps, builds, links `orin`
orin                # start the interactive agent
```

Then add a provider key right from the UI — `/providers configure openrouter` — and
you're off. (`install.sh` is safe to re-run and prints a PATH hint if Bun isn't on
your `PATH` yet.)

**Just want to look around first?** No key required:

```bash
orin --faux         # fully offline, scripted demo
```

> **Requirements:** [Bun](https://bun.sh) ≥ 1.1 (the TUI uses Bun's FFI and a
> preload transform — plain `node` won't work), a real TTY, and an
> [OpenRouter](https://openrouter.ai/keys) key (or another provider) for real use.

Prefer to run from source without a global install:

```bash
bun install
bun run start       # === bun src/cli.ts
```

<p align="center">
  <img src="docs/media/session.png" alt="Orin handling a task: a read tool call followed by the answer" width="760">
  <br>
  <em>One turn of the loop: Orin calls the <code>read</code> tool, then answers — streamed live.</em>
</p>

## Usage

Start interactively, or kick off with a prompt — and there are flags for
scripting and resuming:

```bash
orin                                     # interactive TUI
orin "fix the failing test in src/foo"   # interactive, with an opening message
orin --resume <id>                       # resume a saved session (alias: -r)
orin --list-sessions                     # list saved sessions (alias: -l)
orin --plan                              # start in read-only plan mode
orin --auto-accept                       # start in allow-all mode
orin --headless <prompt>                 # run one task to completion, stream to stdout, exit
orin --chat <prompt>                     # single non-agentic completion
orin --faux                              # offline demo, no API key
```

### Slash commands

Type `/` inside the TUI to open the command palette:

| Command | What it does |
| --- | --- |
| `/mode [normal\|allow-all\|plan]` | Cycle or set the approval mode |
| `/model [id\|number]` | Switch the active model |
| `/providers [id\|number]` | List or switch the active LLM provider |
| `/providers configure [id]` | Set API keys / provider settings |
| `/settings` | Open settings (E2B key, subagent isolation, task models) |
| `/sessions` | Browse and resume saved sessions |
| `/checkpoints` | List workspace checkpoints for this session |
| `/undo` · `/restore [id]` | Roll the working tree back (latest checkpoint by default) |
| `/new` | Archive this session and start a new one |
| `/clear` | Clear the conversation |
| `/help` | Show the full command list |
| `/exit` | Quit |

| Command palette (`/`) | Model picker (`/model`) |
| :---: | :---: |
| ![Orin command palette](docs/media/command-palette.png) | ![Orin model picker](docs/media/model-picker.png) |

## Configuration

All settings live in **`~/.orin/config.json`**, merged on top of built-in defaults.
Use `/providers configure`, `/settings`, and `/model` in the TUI to change values
at runtime — they persist to the config file. Your config, sessions, keys, and
checkpoints all live under `~/.orin/` and survive upgrades.

| Setting | Config key | Notes |
| --- | --- | --- |
| OpenRouter API key | `provider.openrouter.apiKey` | Default backend. Set with `/providers configure openrouter`. |
| OpenAI API key | `provider.openai.apiKey` | Native Platform API (`/providers configure openai`). |
| Anthropic API key | `provider.anthropic.apiKey` | Native Messages API (`/providers anthropic`). |
| Regolo API key | `provider.regolo.apiKey` | EU-hosted, OpenAI-compatible (`/providers regolo`). |
| Active provider | `provider.active` | e.g. `openrouter`, `openai`, `anthropic`, `regolo`. |
| Main model | `models.providers.<id>.main` | Default agent model; set via `/model`. Bundled default per provider when unset. |
| Task / delegate / compaction models | `models.providers.<id>.<slot>` | Optional per-slot overrides (`explore`, `review`, `implement`, `delegate_read`, `compaction`). Unset slots resolve from bundled `defaultSlots` in code. |
| Approval mode | `approval.mode` | `normal` \| `auto-accept` \| `plan`. |
| Subagent isolation | `subagent.isolation` | `shared` \| `worktree` \| `sandbox` floor for `task` subagents. |
| Subagent concurrency | `subagent.maxParallel` | Max `task_parallel` children running at once (default `4`). |
| E2B API key | `sandbox.e2b.apiKey` | Optional — for `sandbox` isolation or whole-session E2B. |

Orin also records **cost and token metrics** locally (`~/.orin/metrics.jsonl`) by
default — set `telemetry.enabled: false` to opt out. It can export OpenTelemetry traces
to Langfuse, Grafana Tempo, Jaeger, and other OTLP backends too.

<details>
<summary><strong>Telemetry &amp; OpenTelemetry (OTLP) details</strong></summary>

#### Local metrics

Per-call cost and token metrics (turn cost, tool durations, a session summary)
append as JSON lines to `~/.orin/metrics.jsonl` and mirror into the session log.
On by default, never leaves your machine.

| Setting | Config key | Notes |
| --- | --- | --- |
| Disable local metrics | `telemetry.enabled` | Set to `false` to suppress the JSONL/stdout sinks. |
| Echo metrics to stdout | `telemetry.stdout` | Set to `true` to print each metric event (debugging). |
| Metrics file path | `telemetry.metricsFile` | Default `~/.orin/metrics.jsonl`. |

#### OTLP trace export

Orin can export **OTLP traces** following the OpenTelemetry
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/),
so a session shows up in **Langfuse, Arize Phoenix, Grafana Tempo, Jaeger, or any
OTLP/HTTP backend**. Each Q&A turn is exported as its own trace; turns from one
Orin session share a `session.id` so backends like Langfuse group them together.

It is **off by default** and the OpenTelemetry SDK is **lazy-loaded only when an
endpoint is configured** — no startup or bundle cost when off. Local metrics opt-out
does *not* affect OTLP export; it has its own switch.

| Setting | Config key | Notes |
| --- | --- | --- |
| Traces endpoint | `telemetry.otel.endpoint` | Base URL or full `/v1/traces` URL; `/v1/traces` is appended to bare base URLs. Setting an endpoint auto-enables export. |
| Headers | `telemetry.otel.headers` | e.g. `{ "Authorization": "Bearer <token>" }`. |
| Protocol | `telemetry.otel.protocol` | Default `http/protobuf`. |
| Service name | `telemetry.otel.serviceName` | Resource `service.name` (default `orin`). |
| Sample ratio | `telemetry.otel.sampleRatio` | `0`–`1` (default `1.0`). |
| Capture content | `telemetry.otel.captureContent` | Opt-in prompt/response capture. **Off by default** — see the privacy note below. |

Example — export to Langfuse via `~/.orin/config.json`:

```jsonc
{
  "telemetry": {
    "otel": {
      "endpoint": "https://cloud.langfuse.com/api/public/otel",
      "headers": { "Authorization": "Basic <base64 pk:sk>" },
      "serviceName": "orin",
      "sampleRatio": 1.0
    }
  }
}
```

For a local collector:

```jsonc
{
  "telemetry": {
    "otel": {
      "endpoint": "http://localhost:4318/v1/traces",
      "headers": { "Authorization": "Bearer <token>" },
      "serviceName": "orin",
      "sampleRatio": 1.0
    }
  }
}
```

Export is best-effort: an unreachable endpoint never throws into or stalls the
agent loop.

Each Q&A turn is its own trace, with child **LLM generation spans** (model, token
usage, cost), **tool spans** (duration, ok/error), and **subagent spans**. Every
span carries an `openinference.span.kind` (`AGENT` / `LLM` / `TOOL`) so Langfuse
and other backends classify it correctly. The trace root is named after the turn's
first user message (collapsed to a single line, truncated to 80 chars) so the
traces list is scannable.

**Content privacy.** Prompt/response and tool **content** is **not** captured by
default. Opt in with `captureContent: true` under `telemetry.otel` in
`~/.orin/config.json`, or from the TUI via `/settings telemetry on` (also toggleable in the
`/settings` menu). With it **off**, only metadata leaves the process — token counts, cost,
model/tool/agent names, IDs, and the short trace-name preview above; no message
bodies, tool arguments, or tool results. With it **on**, spans gain `input.value` /
`output.value` attributes carrying **lossless JSON**:

- **LLM span** — `input.value`: the request (ordered messages incl. the system
  prompt first, plus tool JSON Schemas in scope). `output.value`: the assistant
  message, with `tool_calls` preserved as structured JSON (name + parsed
  arguments) and the `finish_reason` — never flattened to prose.
- **Tool span** — `input.value`: the call arguments. `output.value`: the result
  (`application/json` when it parses as JSON, else `text/plain`).
- **Subagent span** — `input.value`: the subagent prompt. `output.value`: its
  returned summary.

The exact capture shape is documented in `src/telemetry/otel/semconv.ts`.

</details>

## How it works

The agent loop is small and headless — it never touches the terminal directly, it
just emits events the TUI subscribes to:

```
runLoop(ctx, emit):
  loop:
    message = await streamAssistant(ctx, emit)   # provider call, streamed
    ctx.messages.push(message)
    toolCalls = message.content.filter(toolCall)
    if no toolCalls: break
    results = await executeTools(toolCalls, ctx, emit)
    ctx.messages.push(...results)
    if any result terminates: break
```

Everything is **messages of typed content blocks** (`text`, `toolCall`,
`toolResult`). The tool set is deliberately small — `read`, `write`, `edit`,
`bash`, `grep`, `find`, `ls`, plus `fetch` (read a URL), `file_op` (batch file
mutations), `delegate_read` (cheap-model reads), `task` / `task_parallel` (serial and
concurrent subagents), `todowrite` (a live plan), and `askuser` (pause to ask the
user a multiple-choice question).
The provider layer wraps the AI SDK's
`streamText` behind one function and resolves the active backend through a registry
on every turn, so switching models or providers takes effect on the next turn with
no rewiring.

The design and phased build plan live in [`SPEC.md`](./SPEC.md). Orin is built on
[Bun](https://bun.sh), the [Vercel AI SDK](https://sdk.vercel.ai), and a
[SolidJS](https://www.solidjs.com)-powered terminal UI
([`@opentui/solid`](https://github.com/anomalyco/opentui)).

<details>
<summary><strong>Project layout</strong></summary>

```
src/
  cli.ts          # Bun bootstrap shim (registers the SolidJS preload)
  main.ts         # arg parsing + entrypoints (interactive / headless / one-shot)
  cli-args.ts     # CLI flag parsing
  types.ts        # message + content-block data model
  agent/          # the loop, compaction, presets, isolation, mutation queue
  provider/       # streamAssistant, registry, providers/ (openrouter, openai, anthropic, regolo) + faux
  tools/          # read, write, edit, bash, grep, find, ls, fetch, file_op, delegate_read, task, task_parallel, todowrite, askuser (+ .txt descriptions)
  approval/       # approval modes + policy
  edit/           # fuzzy replacer chain for the edit tool
  delegate/       # delegate_read implementation
  checkpoint/     # shadow-git working-tree snapshots powering /undo and /restore
  todos/          # session task-list store (todowrite)
  prompt/         # system prompt + AGENTS.md / SYSTEM.md discovery + environment
  hooks/          # lifecycle hook registry + core hooks (incl. RTK rewrite)
  ratel/          # BM25 tool pre-filtering, tool catalog, MCP bridge, A/B telemetry
  session/        # append-only JSONL session log
  symbols/        # Tree-sitter indexing, persistent cache, search_symbols tool
  telemetry/      # cost/token metrics + sinks; otel/ OTLP trace export (gen_ai spans)
  workspace/      # Workspace backends: local, worktree, E2B sandbox
  tui/            # SolidJS/@opentui terminal UI, slash commands, views
  config/         # config.json loading, model + init config
  util/           # paths, shell, .txt loading, secret prompts
scripts/build.mjs # compiles src/ -> dist/ (Babel: TypeScript + solid universal)
SPEC.md           # design + phased build plan
AGENTS.md         # notes for coding agents working in this repo
```

</details>

## Development

```bash
bun run dev         # run from source (=== bun src/cli.ts)
bun run build       # compile src/ -> dist/
bun run typecheck   # tsc --noEmit
bun run test        # vitest run
bun run test:watch  # vitest in watch mode
```

After a `git pull`, re-run `./install.sh` (or `bun run update`) to refresh
dependencies, rebuild, and re-link the `orin` command.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor workflow, and
[AGENTS.md](./AGENTS.md) for environment-specific caveats.

## References

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/thetombrider/coding_agent)

## License

[MIT](./LICENSE)
