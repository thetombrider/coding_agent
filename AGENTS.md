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

Non-obvious caveats:

- **Bun is required**, not just Node. The dev entrypoint is `bun src/cli.ts` and the TUI relies on Bun FFI plus the `@opentui/solid/preload` transform configured in `bunfig.toml`. Running the TUI/dev command under plain `node` will not work. Install Bun (`curl -fsSL https://bun.sh/install | bash`) and use `~/.bun/bin/bun`. Use `bun install` (a `bun.lock` is committed).
- **`OPENROUTER_API_KEY` is needed for two tests.** `bun run test` is otherwise self-contained, but `src/delegate/delegate-read.test.ts` builds the model argument via `getOpenRouter()` eagerly even though it injects a mock generator, so it throws without the env var. Any non-empty value works for the suite (e.g. `OPENROUTER_API_KEY=dummy bun run test`); a real key is only required to actually hit the model.
- **Offline demo without a key:** run `bun src/cli.ts --faux` for a fully offline interactive TUI (scripted responses). Real interactive use needs a real `OPENROUTER_API_KEY` (env var or `~/.orin/config.json`). The TUI needs a real TTY, so run it in a terminal emulator (not piped).
- **Sessions persist to `~/.orin/sessions/<id>.jsonl`.** Each session is its own append-only JSONL log; switching/archiving a session just rotates to a new file, and old logs remain browsable via `/sessions` (or `orin --list-sessions`).
