# Contributing to Orin

Thanks for your interest in improving Orin! This guide covers how to set up your
environment, the conventions the codebase follows, and how to get a change
merged.

By participating, please be respectful and constructive in issues, pull
requests, and reviews.

## Getting set up

Orin runs on **[Bun](https://bun.sh) ≥ 1.1** — this is required, not optional.
The TUI depends on Bun's FFI and a Bun preload transform, so the dev entrypoint
(`bun src/cli.ts`) will not work under plain `node`.

```bash
git clone https://github.com/thetombrider/coding_agent.git
cd coding_agent
bun install
bun run start        # run the agent from source (=== bun src/cli.ts)
bun run start --faux # offline demo, no API key required
```

If you don't have Bun, `./install.sh` will install it for you (or
`curl -fsSL https://bun.sh/install | bash`).

Read [`README.md`](./README.md) for the feature overview and
[`SPEC.md`](./SPEC.md) for the architecture and phased build plan — it explains
*why* each layer exists. [`AGENTS.md`](./AGENTS.md) documents non-obvious
environment caveats.

## Development workflow

1. **Branch** off `main` for your change.
2. **Make focused changes** that match the surrounding code's style.
3. **Keep the checks green** before opening a PR:

   ```bash
   bun run typecheck   # tsc --noEmit (strict mode, no unused locals/params)
   bun run test        # vitest run
   bun run build       # confirm src/ still compiles to dist/
   ```

4. **Commit** with a clear message (see below) and open a pull request describing
   *what* changed and *why*.

## Coding conventions

- **TypeScript, strict.** The project compiles with `strict`, `noUnusedLocals`,
  `noUnusedParameters`, and `noFallthroughCasesInSwitch`. Keep it clean.
- **Match the existing style.** Mirror the naming, comment density, and idioms of
  the file you're editing. Comments explain *why*, not *what*.
- **Keep the agent loop headless.** `agent/loop.ts` emits events and never
  touches the terminal directly — the TUI subscribes to those events. Don't add
  rendering or `console.log` to the loop.
- **Keep the core provider-agnostic.** Model and backend resolution go through
  the provider registry (`provider/registry.ts`), not direct backend calls. This
  is what lets `/model` and `/providers` switch at runtime.
- **Tool descriptions live in `.txt` files.** The human-facing description for a
  tool is loaded from `src/tools/<name>.txt` via `loadToolDescription()`, keeping
  prompt-tuning out of code.
- **Imports use `.js` extensions** (NodeNext module resolution), even though the
  source is `.ts`.

## Testing

Tests use [Vitest](https://vitest.dev) and live next to the code they cover as
`*.test.ts` / `*.test.tsx`.

```bash
bun run test         # run the suite once
bun run test:watch   # watch mode
```

Guidance, following the patterns already in the repo:

- **Drive the loop with the `faux` provider** (`provider/faux.ts`) to assert tool
  calls happen in the expected order and the loop terminates deterministically.
- **Run tool handlers against a temp-dir fixture** rather than the real repo.
- **Golden-style assertions** for edit matchers (`edit/replacers.test.ts`).

A couple of caveats worth knowing:

- A few tests (`delegate/delegate-read.test.ts`, `agent/compaction.test.ts`)
  build the model argument through the provider registry even though they inject
  a mock generator, so they need a non-empty `OPENROUTER_API_KEY` to run. Any
  value works — no real key needed:

  ```bash
  OPENROUTER_API_KEY=dummy bun run test
  ```

- `tui/approval-bar.test.tsx` is excluded from the default Vitest run (see
  `vitest.config.ts`).

## Common recipes

### Adding a tool

1. Create `src/tools/<name>.ts` exporting a `Tool<Args>` (see `src/tools/types.ts`):
   a `name`, a `description` loaded with `loadToolDescription("<name>")`, a Zod
   `schema`, an optional `needsApproval`, and an `execute` that runs against
   `ctx.workspace` (so it works in both local and sandbox backends).
2. Write the human-facing description in `src/tools/<name>.txt`.
3. Register it in the `ALL_TOOLS` array in `src/tools/registry.ts`.
4. Add `src/tools/<name>.test.ts`.

Mark any tool that writes or executes (`write`/`edit`/`bash`-like) so the
approval gate and `plan` mode treat it correctly.

### Adding an LLM provider

Each backend is a single self-contained file under `src/provider/providers/`
implementing the `Provider` interface (`src/provider/types.ts`): `id`,
`displayName`, `authStrategy`, `isConfigured()`, `normalizeModelId()`, a
`languageModel()` factory, model-metadata lookups, and optional
`streamProviderOptions()` / `markCacheBreakpoints()` cache hooks. Wire it in by
importing it from `src/provider/registry.ts` and calling
`registerProvider(...)`; it then appears in `/providers` automatically.

API-key providers read credentials from `provider.<id>.apiKey` in the config
file, with the matching env var taking precedence. OAuth backends store tokens
in `~/.orin/tokens.json` (mode `0600`), never in `config.json`.

## Commit messages

The history uses [Conventional Commits](https://www.conventionalcommits.org)
prefixes — please follow suit:

```
feat: configure LLM providers from the TUI via /providers configure
fix: guard provider switches during active turns
docs: add Cline & Kilo Code reference study
```

Common prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. Keep the
subject in the imperative mood and add a body when the *why* isn't obvious.

## Pull requests

- Keep PRs focused; smaller is easier to review.
- Make sure `typecheck`, `test`, and `build` pass.
- Describe the change, the motivation, and anything reviewers should pay
  attention to. Link related issues.
- Update `README.md` / `SPEC.md` when you change user-facing behavior or
  architecture.

## Reporting issues

When filing a bug, include your OS, Bun version (`bun --version`), the command
you ran, and the full output (run with `--faux` to reproduce without an API key
where possible). For feature ideas, describe the use case — `SPEC.md` lists the
planned extension phases and may already cover it.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
