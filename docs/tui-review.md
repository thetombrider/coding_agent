# TUI Review — bugs, antipatterns, inconsistencies

Reviewed `src/tui/**` against the canonical OpenTUI Solid skill rules.
Config (`bunfig.toml`, `tsconfig.json`, `package.json`) is correct —
preload, `jsx: preserve`, `jsxImportSource: @opentui/solid`, proper deps.

Severity legend: 🔴 bug · 🟡 antipattern · 🔵 inconsistency · ⚪ note

> Re-verified 2026-07-13 against current `src/tui/**`. B1, B2, B3, A1, A2, A3,
> I1, I3 were already fixed and have been removed from this doc (see git
> history for the original write-ups). Everything below still reproduces in
> the current code.

---

## Bugs

No open bugs. The four originally logged here are resolved:
- B1 (`views.tsx` dead ternary) — fixed, now `subagent().tools.length ? 1 : 0`.
- B2 (`formatPerMRate` redundant branch) — fixed, now two branches (`>= 0.1` / else).
- B3 (plain `c` copy missing `preventDefault`) — fixed, both call sites
  (`app.tsx:1449`, `app.tsx:1768`) now call `key.preventDefault()`.
- B4 (`key.name !== undefined` swallow) — was already reclassified as a note
  on the prior pass, not a real bug; see N1-adjacent behavior is unchanged,
  still correct. No entry needed here.

---

## Antipatterns

### A4 · Many `<Show>` without `fallback` (rule 18)
Still true. `scroll-rail.tsx:40-43` documents that no-fallback `<Show>`
yields `""` (an orphan text node) in the server/test renderer. Most `<Show>`
usages in the TUI still lack a fallback:

- `views.tsx`: lines 63, 348, 361, 365, 455, 458, 462, 467, 470, 473, 577,
  581, 586, 644, 668, 692, 697, 703, 710, 732, 737
- `markdown.tsx`: line 201
- `expandable.tsx`: line 58
- `app.tsx`: 2020, 2023, 2026 (MCP wizard hints — conditional text inside an
  already-mounted subtree, lower risk)

(Note: the multi-line `<Show when=… fallback=…>` blocks in `views.tsx`
`ToolBlock`/`ApprovalBar` and `expandable.tsx`'s outer scrollable switch *do*
have a fallback a few lines down — those aren't included above.)

### A5 · Missing `createMemo` for repeatedly-evaluated derived getters — fixed
`views.tsx` (`summary()`, `hasPlainOutput()`, `showDiff()`) and
`expandable.tsx` (`formatted()`) were already `createMemo`. The remaining
gap, `markdown.tsx` `TableBlock`'s `widths()`/`rows()`, is now also wrapped
in `createMemo`. No open items for this antipattern.

### A6 · `app.tsx:378-386` — effect reads signals only for side-effect
```tsx
createEffect(() => {
  completed();
  live();
  state().phase;
  state().pendingApproval;
  queueMicrotask(bumpScrollRail);
});
```
Still present (line numbers shifted from 338-347). Lower severity now: the
code has since grown an explanatory comment ("re-measure the rail when they
toggle — otherwise it keeps a stale height and overflows over the approval
bar"), so the pattern is intentional and documented, just still fragile in
the same way as before.

---

## Inconsistencies

### I2 · `revision` prop passed as value vs `scrollRef` as factory
Still present. `app.tsx:1873` passes `scrollRef={() => scrollRef}` (factory)
while `app.tsx:1874` passes `revision={scrollRailRevision()}` (value). Both
are correct for their respective prop types; still just a readability wrinkle
for anyone scanning the two side by side.

---

## Notes (uncertain / worth flagging)

### N1 · `app.tsx:1487` — `preventDefault()` called for ALL keys in approval
```tsx
if (phase === "approval") {
  key.preventDefault();        // before any key check
  if (key.name === "y") { … }
```
Still unconditional for every key in approval phase (line shifted from
1370). Harmless — the input isn't focused during approval (see N3) — but
confirms the input historically needed this guard.

### N2 · `app.tsx:1848` — `<For each={completed()}>` is correct (objects)
`completed()` returns `Turn[]` (objects), so `<For>` remains the right
choice per rule 19 (line shifted from 1707).

### N3 · `app.tsx:2513` — input focused during `question` and `running`
`inputFocused` is now a `createMemo` (`app.tsx:399-403`):
```tsx
const inputFocused = createMemo(() => {
  if (state().phase === "approval") return false;
  if (palette()?.phase === "mcp") return false;
  return true;
});
```
Same effective behavior as before: focused during `input`, `question`, and
`running` phases (plus now explicitly blurred while the `/mcp` palette is
open, to stop mouse-report leaks). Intentional (type-ahead), but the global
keyboard handler and the input both still see keystrokes in those phases.

### N4 · `session.ts:713` — `process.exit` is in a comment, not code
Still accurate. The comment explains `restoreTerminal`'s exit-hook cleanup;
the actual `process.once("exit", onProcessExit)` is at line 715. Real
`process.exit` calls remain in `main.ts` and `cli/mcp.ts` only, not inside
the TUI.

### N5 · `views.tsx:79-92` — todo reads are non-reactive by design
Still accurate. `item.status`/`item.content` are plain property reads on
`TodoItem` objects (not a Solid store); relies on `<For>` recreating
children when the `todos` array is replaced with fresh object references.

### N6 · `expandable.tsx:43` — inline component definition
Still present. `const Lines = () => (...)` defines a component inside
`ToolOutputView`. Works in Solid, but inline component definitions can
confuse compiler optimization passes.

### N7 · `markdown.tsx:144` — `createTextAttributes` called per render
```tsx
attributes={createTextAttributes({ bold: true, underline: props.block.level === 1 })}
```
Still constructs a new bitmask on every reactive evaluation. Minor — could
be memoized since `block.level` is static per instance.

---

## What's done well

- **Config is correct**: `bunfig.toml` preload, `tsconfig.json` jsx settings,
  proper `@opentui/solid` + `solid-js` deps.
- **No `process.exit` inside the TUI** — exit routes through `props.onExit()`
  → `renderer.destroy()`.
- **No Solid naming errors** — no `<tab-select>`/`<ascii-font>` hyphens; no
  `onChange` on Solid inputs (uses `onInput` at `app.tsx:2518`).
- **No text-styling props** — uses `attributes={BOLD}` (imperative bitmask
  via `createTextAttributes`) and nested modifier tags, never
  `bold={true}`/`italic={true}` props on `<text>`.
- **Colors all have `#`** — no missing-prefix hex colors found.
- **`spinner.ts`** — proper `onCleanup(() => clearInterval(id))`.
- **`controller.ts:316`** — notifies listeners via `queueMicrotask` to avoid
  synchronous-write-during-render errors. Good defensive pattern.
- **`controller.ts:744`** — approval/question rejection gates on the
  resolver, not the phase (handles sibling tool_start racing the phase).
  Well-commented.
- **`app.tsx`** — async effects guard against stale provider switches
  (`if (provider === providerId)`).
- **`crash.ts`** — robust best-effort diagnostics, never throws from
  finally/exit handlers.
- **`terminal.ts`** — `restoreTerminal` is best-effort, tolerant of closed
  stdout, never throws.
- **Since the prior review**: `markdown.tsx`'s `BlockView` stopped
  destructuring `props.block`, `scroll-rail.tsx` made its bare
  `props.revision` read explicit (`void props.revision`), every
  primitive-array `<For>` (in `diff.tsx`, `expandable.tsx`, `markdown.tsx`,
  and the pickers/mode lists in `app.tsx`) was switched to `<Index>`, and
  `markdown.tsx` `TableBlock`'s `widths()`/`rows()` are now `createMemo`.

---

## Recommended fix priority

1. **A4** — add `fallback` to the `<Show>` blocks listed above, at least
   the ones in the live conversation view (`views.tsx`) where an orphan
   text node is most likely to matter.
2. **N6/N7** — optional cleanup: hoist `Lines` out of `ToolOutputView`,
   memoize the `createTextAttributes` call in `markdown.tsx`.
