# AGENTS.md

## Cursor Cloud specific instructions

`orin` is a single-package terminal coding-agent CLI (Bun + SolidJS via `@opentui`). Standard scripts live in `package.json` (`start`, `dev`, `build`, `typecheck`, `test`).

### Install and run

```bash
./install.sh    # installs Bun (if needed), deps, build, and links the orin command
orin            # start the interactive agent
orin --faux     # offline demo without an API key
bun run start   # run from source without a global install
```

### Updating after `git pull`

Re-run the install script from the repo root — it is safe to run again and will refresh dependencies, rebuild, and re-link `orin`:

```bash
git pull
./install.sh
```

Equivalent from the repo without the shell script:

```bash
bun run update
```

Your config (`~/.orin/config.json`) and sessions are untouched. If `config.json` is missing or empty, `./install.sh` (or the first `orin` run) seeds it with defaults you can edit.

Non-obvious caveats:

- **Bun is required**, not just Node. The dev entrypoint is `bun src/cli.ts` and the TUI relies on Bun FFI plus the `@opentui/solid/preload` transform configured in `bunfig.toml`. Running the TUI/dev command under plain `node` will not work. Install Bun (`curl -fsSL https://bun.sh/install | bash`) and use `~/.bun/bin/bun`. Use `bun install` (a `bun.lock` is committed).
- **Provider keys live in `~/.orin/config.json`.** Tests isolate config by pointing `HOME` at a temp directory. A few tests (`src/delegate/delegate-read.test.ts`, `src/agent/compaction.test.ts`) build the model argument through the provider registry even when they inject a mock generator — if those fail with "OpenRouter is not configured", seed a dummy key in the test temp home via `saveConfig({ provider: { openrouter: { apiKey: "dummy" } } })` rather than using env vars.
- **Offline demo without a key:** run `bun src/cli.ts --faux` for a fully offline interactive TUI (scripted responses). Real interactive use needs a provider key in `~/.orin/config.json` (set with `/providers configure`). The TUI needs a real TTY, so run it in a terminal emulator (not piped).
- **Sessions persist to `~/.orin/sessions/<id>.jsonl`.** Each session is its own append-only JSONL log; switching/archiving a session just rotates to a new file, and old logs remain browsable via `/sessions` (or `orin --list-sessions`).
