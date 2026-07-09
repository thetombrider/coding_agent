# TUI Review — bugs, antipatterns, inconsistencies

Reviewed `src/tui/**` against the canonical OpenTUI Solid skill rules.
Config (`bunfig.toml`, `tsconfig.json`, `package.json`) is correct —
preload, `jsx: preserve`, `jsxImportSource: @opentui/solid`, proper deps.

Severity legend: 🔴 bug · 🟡 antipattern · 🔵 inconsistency · ⚪ note

---

## Bugs

### B1 · `views.tsx:471` — dead ternary, both branches return 0
```tsx
<box flexDirection="row" marginBottom={subagent().tools.length ? 0 : 0}>
```
Both branches yield `0`. One was likely meant to be non-zero (e.g. `1`) to
add spacing when subagent tools exist. As written the condition is dead code.

### B2 · `views.tsx:156-159` — `formatPerMRate` has a redundant branch
```ts
function formatPerMRate(rate: number): string {
  if (rate >= 1) return `$${rate.toFixed(2)}`;
  if (rate >= 0.1) return `$${rate.toFixed(2)}`;   // ← same format as above
  return `$${rate.toFixed(3)}`;
}
```
The `rate >= 0.1` and `rate >= 1` branches produce identical output, so
sub-dollar rates between 0.1–0.99 get 2-decimal formatting when they likely
should differ (e.g. the `>= 0.1` branch was probably meant to use a different
precision, or the threshold was meant to be lower). Sub-0.1 rates correctly
get 3 decimals.

### B3 · `app.tsx:1329-1335` — plain `c` copy can double-act with input typing
```tsx
if (isPlainSelectionCopyShortcut(key)) {       // plain `c`, no modifiers
  const selected = readRendererSelection(renderer);
  if (selected) {
    void performCopy(selected);
    return;                                    // no key.preventDefault()
  }
}
```
Unlike the approval handler (line 1370, which calls `key.preventDefault()`),
this early copy block does **not** preventDefault. When a drag-selection is
active during the `input`/`question` phase and the user presses plain `c`,
the global handler copies the selection AND the still-focused `<input>`
types a stray `c` into the prompt. The approval block's own comment
(lines 1367-1369) documents that without preventDefault the input captures
the keystroke too — so this is a known hazard that this path doesn't guard.

### B4 · `app.tsx:1487,1502,1522,1539` — `key.name !== undefined` swallows
Enter-adjacent modifier combos in sub-menus
```tsx
// sessions delete menu, skills detail menu, mcp delete/detail menus
if (key.name !== undefined) return;
```
These lines intentionally swallow all named keys so Enter is handled by the
submit path. But `key.name` for a raw Enter is `"enter"` (defined) — this is
correct. The risk: modifier-only keypresses where `key.name === undefined`
(e.g. a bare Shift press) fall through to the `up`/`down`/`escape` handlers
below, which is harmless. Marking as a note rather than a real bug after
re-checking — documenting because the pattern is subtle and easy to break
on refactor.

---

## Antipatterns

### A1 · `<For>` used over primitive arrays (should be `<Index>`)
Rule 19: `<For>` for arrays of objects (item is reactive); `<Index>` for
primitives (item() is reactive). The codebase uses `<For>` for `string[]`
in many places. Low risk in practice because the arrays are recreated each
render (new references → For re-runs), but duplicate strings can confuse
For's referential keying during streaming updates.

| File | Line | Array |
|------|------|-------|
| `app.tsx` | 1918 | `[...pickerModels()]` (model ids) |
| `app.tsx` | 1973 | `APPROVAL_MODES` |
| `app.tsx` | 2053 | `SESSION_ISOLATION_MODES` |
| `app.tsx` | 2074 | `ISOLATION_MODES` |
| `app.tsx` | 2112 | `modelSlotList()` |
| `app.tsx` | 2235 | `mcpServerDetailLines(s())` |
| `diff.tsx` | 24 | `lines()` (diff lines — duplicates common) |
| `expandable.tsx` | 45 | `formatted().lines` (tool output — duplicates common, streams) |
| `markdown.tsx` | 154,162,177,191 | `block.body.split("\n")`, list items, blockquote/paragraph lines |
| `logo.tsx` | 61 | `LOGO_LINES` (static — zero risk) |

The `diff.tsx` and `expandable.tsx` cases are the highest risk: diff output
and tool output frequently contain duplicate lines and re-evaluate during
streaming, where For's referential keying can drop or mis-style duplicates.

### A2 · `markdown.tsx:136` — props destructured, breaking reactivity
```tsx
function BlockView(props: { block: Block; first: boolean }) {
  const block = props.block;   // ← captures once, won't update
  switch (block.type) { … }
```
Rule 6: don't destructure props. Every other component in the TUI correctly
uses `props.xxx` or `() => props.xxx` getters (`views.tsx:466`, `510`, etc.);
`BlockView` is the sole exception. Works today because `<For>` recreates
`BlockView` for new block references, but would silently break if blocks
were ever mutated in place.

### A3 · `scroll-rail.tsx:33` — bare expression as reactive dependency
```tsx
const layout = () => {
  props.revision;              // bare read — no assignment, no use
  return scrollRailMetrics(props.scrollRef());
};
```
Reading `props.revision` solely to create a reactive dependency works, but
a minifier/tree-shaker could legally remove it as a no-op statement (it has
no observable side effect in pure JS). Should be `const _ = props.revision;`
or integrated into the return expression.

### A4 · Many `<Show>` without `fallback` (rule 18)
`scroll-rail.tsx:40-43` documents that no-fallback `<Show>` yields `""` (an
orphan text node) in the server/test renderer. Despite this known issue,
many `<Show>` components lack fallbacks:

- `views.tsx`: lines 63, 335, 348, 352, 440, 443, 447, 452, 455, 458, 494,
  518, 523, 529, 536, 558, 563
- `markdown.tsx`: 200
- `expandable.tsx`: 58
- `app.tsx`: 1860, 1863, 1866 (nested in MCP wizard — these are conditional
  hints inside an already-mounted subtree, lower risk)

### A5 · Missing `createMemo` for repeatedly-evaluated derived getters
Several getters are called 3-5× per render, each call re-running computation:
- `views.tsx`: `summary()` 3× (419,441,449), `hasPlainOutput()` 5×
  (377,385,404,421,458), `showDiff()` 3× (374,395,455)
- `markdown.tsx`: `widths()` 3+× via `border()`/`rowLines()`, `rows()` 2×
- `expandable.tsx`: `formatted()` 3× (31,45,58) — each re-runs
  `formatToolOutputForDisplay` which splits/processes the full output

### A6 · `app.tsx:338-347` — effect reads signals only for side-effect
```tsx
createEffect(() => {
  completed();
  live();
  state().phase;
  state().pendingApproval;
  queueMicrotask(bumpScrollRail);
});
```
`completed()` and `live()` are called solely to create reactive dependencies
(their return values are discarded). This is a known Solid pattern but is
fragile — same class as A3. A named memo or comment-protected read would be
clearer.

---

## Inconsistencies

### I1 · Props-access style differs across components
- Most components: `props.xxx` in JSX, or `const x = () => props.xxx` getter
  (`views.tsx:466`, `510`, `app.tsx:1839`).
- `markdown.tsx:136`: `const block = props.block` (captures once — see A2).
- `scroll-rail.tsx:33`: bare `props.revision;` (see A3).

### I2 · `revision` prop passed as value vs `scrollRef` as factory
`app.tsx:1733` passes `revision={scrollRailRevision()}` (calls the signal,
passes a number), while `app.tsx:1732` passes `scrollRef={() => scrollRef}`
(factory). Both are correct for their respective prop types (value vs
accessor), but the differing patterns side-by-side can confuse readers.

### I3 · `formatPerMRate` thresholds don't match display intent
See B2 — the `>= 1` and `>= 0.1` branches are identical, which is either a
copy-paste error or an incomplete refactor. Inconsistent with the `>= 0.1`
→ `toFixed(3)` pattern that the `< 0.1` branch implies was the goal.

---

## Notes (uncertain / worth flagging)

### N1 · `app.tsx:1370` — `preventDefault()` called for ALL keys in approval
```tsx
if (phase === "approval") {
  key.preventDefault();        // before any key check
  if (key.name === "y") { … }
```
`preventDefault` is called unconditionally for every key in approval phase,
before checking which key. This is defensive (the comment at 1367-1369
explains it prevents the unfocused input from capturing `y`/`n`), but
calling it for arrow/page keys too is broader than necessary. Harmless
since the input isn't focused during approval (`focused={phase !==
"approval"}` at line 2346), but suggests the input may have historically
captured keys even when unfocused.

### N2 · `app.tsx:1707` — `<For each={completed()}>` is correct (objects)
`completed()` returns `Turn[]` (objects), so `<For>` is the right choice
per rule 19. The `turnKey={...}` prop uses `i()` (index accessor) — correct.

### N3 · `app.tsx:2346` — input focused during `question` and `running`
```tsx
focused={state().phase !== "approval"}
```
The input is focused during `input`, `question`, and `running` phases. This
is intentional (lets the user type ahead / type a custom question reply),
but means the global keyboard handler and the input both see keystrokes
during those phases — the source of B3.

### N4 · `session.ts:664` — `process.exit` is in a comment, not code
The grep hit on `process.exit` in `session.ts` is a comment explaining that
`process.exit` fires the `"exit"` event (which `restoreTerminal` hooks for
cleanup). The actual code at line 667 is `process.once("exit",
onProcessExit)` — correct defensive cleanup. The real `process.exit`
calls are in `main.ts` and `cli/mcp.ts` (CLI-level fatal errors outside the
TUI render loop), not inside the TUI.

### N5 · `views.tsx:79-92` — todo reads are non-reactive by design
`item.status`/`item.content` are plain property reads on `TodoItem` objects
(not a Solid store). The UI relies on `<For>` recreating children when the
`todos` array is replaced with fresh object references. Works because
`rebuildTodosFromMessages` returns new objects, but would silently break if
items were ever mutated in place.

### N6 · `expandable.tsx:43-64` — inline component definition
`const Lines = () => (...)` defines a component inside `ToolOutputView`.
Works in Solid (outer function runs once, so `Lines` is stable), but inline
component definitions can confuse the compiler's optimization passes.
Could be called as `{Lines()}` to inline into the parent scope, or
extracted to module scope.

### N7 · `markdown.tsx:145` — `createTextAttributes` called per render
```tsx
attributes={createTextAttributes({ bold: true, underline: block.level === 1 })}
```
Constructs a new bitmask on every reactive evaluation. Minor — could be
memoized since `block.level` is static per instance (block is captured
once per A2).

---

## What's done well

- **Config is correct**: `bunfig.toml` preload, `tsconfig.json` jsx settings,
  proper `@opentui/solid` + `solid-js` deps.
- **No `process.exit` inside the TUI** — exit routes through `props.onExit()`
  → `renderer.destroy()`.
- **No Solid naming errors** — no `<tab-select>`/`<ascii-font>` hyphens; no
  `onChange` on Solid inputs (uses `onInput` at `app.tsx:2351`).
- **No text-styling props** — uses `attributes={BOLD}` (imperative bitmask
  via `createTextAttributes`) and nested modifier tags, never
  `bold={true}`/`italic={true}` props on `<text>`.
- **Colors all have `#`** — no missing-prefix hex colors found.
- **`spinner.ts`** — proper `onCleanup(() => clearInterval(id))`.
- **`controller.ts:265-272`** — notifies listeners via `queueMicrotask` to
  avoid synchronous-write-during-render errors. Good defensive pattern.
- **`controller.ts:628,664`** — approval/question rejection gates on the
  resolver, not the phase (handles sibling tool_start racing the phase).
  Well-commented.
- **`app.tsx:402-406,420-427`** — async effects guard against stale provider
  switches (`if (provider === providerId)`).
- **`crash.ts`** — robust best-effort diagnostics, never throws from
  finally/exit handlers.
- **`terminal.ts`** — `restoreTerminal` is best-effort, tolerant of closed
  stdout, never throws.

---

## Recommended fix priority

1. **B1** `views.tsx:471` — fix the dead ternary (likely `1` in one branch).
2. **B2** `views.tsx:156-159` — fix `formatPerMRate` redundant branch.
3. **B3** `app.tsx:1329` — add `key.preventDefault()` to the plain-`c`
   selection-copy block (match the approval block's pattern).
4. **A1** `diff.tsx:24`, `expandable.tsx:45` — switch to `<Index>` for the
   duplicate-prone streaming string arrays (highest-risk For-over-strings).
5. **A2** `markdown.tsx:136` — change `const block = props.block` to
   `const block = () => props.block` and update accesses, or use `props.`
   directly.
6. **A3** `scroll-rail.tsx:33` — assign `props.revision` to a variable.
7. **A5** wrap the multi-call getters in `createMemo`.
