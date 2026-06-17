# Orin

**A terminal coding agent CLI.** Give it a prompt and Orin autonomously reads,
searches, edits, and runs code in your working directory — calling tools in a
loop, streaming its work to an interactive TUI, and pausing for your approval
before anything dangerous.

Orin is built on [Bun](https://bun.sh), the [Vercel AI SDK](https://sdk.vercel.ai),
and a [SolidJS](https://www.solidjs.com)-powered terminal UI
([`@opentui/solid`](https://github.com/anomalyco/opentui)). The design and phased
build plan live in [`SPEC.md`](./SPEC.md).

---

## Features

- **Agentic loop** — streams an assistant turn, executes any tool calls it
  produces, feeds the results back, and repeats until the task is done.
- **A focused tool set** — `read`, `write`, `edit`, `bash`, `grep`, `find`,
  `ls`, and `delegate_read`. The `edit` tool applies exact-match replacements
  with a fuzzy fallback chain and renders unified diffs.
- **Approval gate** — three modes you can switch on the fly: `normal` (ask
  before writes/commands), `allow all` (auto-accept), and `plan` (read-only —
  blocks `write`/`edit`/`bash`).
- **Interactive TUI** — streaming markdown, live diffs, a slash-command palette,
  and a session browser.
- **Pluggable LLM providers** — a provider registry behind a single interface.
  OpenRouter ships today; the interface anticipates Anthropic, OpenAI, Regolo,
  LiteLLM, and gateway backends. Switch at runtime with `/providers`.
- **Two model tiers** — a capable **main** model for reasoning and a cheap model
  for offloaded work. The `delegate_read` tool hands read-heavy tasks (scan a
  big file, summarize logs) to the cheap model so the bulk never enters the main
  context.
- **Context compaction** — old turns are summarized and stale tool output evicted
  automatically as the context window fills.
- **Persistent sessions** — every session is an append-only JSONL log under
  `~/.orin/sessions/`. Browse and resume them with `/sessions` or `--resume`.
- **Local or remote execution** — run tools on your machine or in an
  [E2B](https://e2b.dev) cloud sandbox (`/sandbox e2b`).
- **Lifecycle hooks** — `before_tool` / `after_tool` / `before_prompt` /
  `before_compact` / `session_start` / `session_end` interception points (used,
  for example, to transparently route `bash` through [RTK](https://github.com/rtk-ai/rtk)
  for command-output compression when it is installed).
- **Offline demo** — `orin --faux` runs the full TUI with scripted responses and
  no API key.

## Requirements

- **[Bun](https://bun.sh) ≥ 1.1** — required, not just Node. Orin's TUI relies on
  Bun's FFI and a Bun preload transform; running it under plain `node` will not
  work. (Node ≥ 20 is listed for tooling compatibility, but the agent runs on Bun.)
- A terminal emulator with a real TTY (the TUI cannot be piped).
- An **[OpenRouter](https://openrouter.ai/keys) API key** for real agent use
  (not needed for `--faux`).

## Quick start

```bash
git clone https://github.com/thetombrider/coding_agent.git
cd coding_agent
./install.sh        # installs Bun if needed, installs deps, builds, links `orin`
orin                # start the interactive agent
```

`install.sh` is safe to re-run. It seeds `~/.orin/config.json` with defaults and
prompts for your OpenRouter (and optional E2B) API keys. If Bun isn't on your
`PATH` yet, the script prints the line to add.

Prefer to run from source without a global install:

```bash
bun install
bun run start       # === bun src/cli.ts
```

Try it with no API key:

```bash
orin --faux         # fully offline, scripted demo
```

## Configuration

Configuration is resolved from **defaults → `~/.orin/config.json` → environment
variables** (env vars win, so CI/CD works without editing the file). Copy
[`.env.example`](./.env.example) to `.env` to get started, or edit the config
file directly.

| Setting | Env var | Notes |
| --- | --- | --- |
| OpenRouter API key | `OPENROUTER_API_KEY` | Required for real use. Also `provider.openrouter.apiKey` in config. |
| Main model | `ORIN_MODEL` | Default agent model (OpenRouter `provider/model` id). |
| Cheap model | `ORIN_CHEAP_MODEL` | Used by `delegate_read` and compaction. |
| Approval mode | `ORIN_APPROVAL_MODE` | `normal` \| `auto-accept` \| `plan`. |
| E2B API key | `E2B_API_KEY` | Optional — for `/sandbox e2b`. Also `sandbox.e2b.apiKey` in config. |

Your config, sessions, and keys all live under `~/.orin/` and are untouched by
upgrades. OAuth-based providers (when implemented) store tokens in
`~/.orin/tokens.json` (mode `0600`), never in the config file.

## Usage

### CLI flags

```bash
orin                       # interactive TUI
orin "fix the failing test in src/foo"   # interactive, with an opening message
orin --resume <id>         # resume a saved session (alias: -r)
orin --list-sessions       # list saved sessions (alias: -l)
orin --plan                # start in read-only plan mode
orin --auto-accept         # start in allow-all mode
orin --headless <prompt>   # run one task to completion, stream to stdout, exit
orin --chat <prompt>       # single non-agentic completion
orin --faux                # offline demo, no API key
```

### Slash commands

Type these inside the TUI:

| Command | Description |
| --- | --- |
| `/mode [normal\|allow-all\|plan]` | Cycle or set the approval mode |
| `/model [id\|number]` | Switch the active model |
| `/providers [id\|number]` | List or switch the active LLM provider |
| `/providers configure [id]` | Set API keys / provider settings in `~/.orin/config.json` |
| `/sandbox [local\|e2b]` | Run tools locally or in an E2B cloud sandbox |
| `/sessions` | Browse and resume saved sessions |
| `/new` | Archive this session and start a new one |
| `/clear` | Clear the conversation |
| `/help` | Show the command list |
| `/exit` | Quit |

## How it works

The agent loop is small and headless — it never touches the terminal directly,
it just emits events that the TUI subscribes to:

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
`toolResult`). The provider layer wraps the AI SDK's `streamText` behind one
function and resolves the active backend through the registry on every turn, so
switching models or providers takes effect on the next turn with no rewiring.

## Project layout

```
src/
  cli.ts          # Bun bootstrap shim (registers the SolidJS preload)
  main.ts         # arg parsing + entrypoints (interactive / headless / one-shot)
  types.ts        # message + content-block data model
  agent/          # the loop, compaction, mutation queue
  provider/       # streamAssistant, registry, faux provider, providers/
  tools/          # read, write, edit, bash, grep, find, ls, delegate_read (+ .txt descriptions)
  approval/       # approval modes + policy
  edit/           # fuzzy replacer chain for the edit tool
  delegate/       # delegate_read implementation
  hooks/          # lifecycle hook registry + core hooks (incl. RTK rewrite)
  session/        # append-only JSONL session log
  workspace/      # Workspace backends: local + E2B sandbox
  tui/            # SolidJS/@opentui terminal UI, slash commands, views
  config/         # config.json loading, model + init config
  util/           # paths, shell, .txt loading, secret prompts
scripts/build.mjs # compiles src/ -> dist/ (Babel: TypeScript + solid universal)
SPEC.md           # design + phased build plan
AGENTS.md         # notes for coding agents working in this repo
```

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

## License

[MIT](./LICENSE)
