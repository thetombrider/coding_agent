import { createTextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { formatMcpToolLabel, isMcpTool } from "../mcp/names.js";
import { formatMcpArgsSummary } from "../tools/provider-schema.js";
import type { ModelPricing } from "../config/config.js";
import { createSignal, createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js";
import type { SubagentContext, ToolEntry, Turn, TurnBlock } from "./controller.js";
import type { TodoItem, TodoStatus } from "../todos/types.js";
import { countCompletedTodos, hasActiveTodos } from "../todos/store.js";
import type { SessionPhase } from "./controller.js";
import { DiffView } from "./diff.js";
import { ReasoningOutputView, stopToolOutputScrollBubble, ToolOutputView } from "./expandable.js";
import { Markdown } from "./markdown.js";
import { ScrollRail } from "./scroll-rail.js";
import { spinnerFrame } from "./spinner.js";
import { hiddenNativeScrollbar, scrollbars, surfaceSelection, theme } from "./theme.js";
import { useToolExpand } from "./tool-expand.js";
import { outputExpandHint, toolDisplayOutput } from "./tool-output.js";
import { INFO_SIDEBAR_WIDTH } from "./sidebar-state.js";
import { SidebarRow, SidebarShell } from "./sidebar-chrome.js";

const BOLD = createTextAttributes({ bold: true });

export const TODO_SIDEBAR_WIDTH = INFO_SIDEBAR_WIDTH;

function todoCheckbox(status: TodoStatus, running: boolean): string {
  switch (status) {
    case "completed":
      return "✓";
    case "cancelled":
      return "–";
    case "in_progress":
      return running ? spinnerFrame() : "→";
    default:
      return " ";
  }
}

function todoStatusColor(status: TodoStatus): string {
  switch (status) {
    case "in_progress":
      return theme.toolRunning;
    case "completed":
      return theme.toolDone;
    case "cancelled":
      return theme.muted;
    default:
      return theme.secondary;
  }
}

/** True when the sidebar should be visible (active work or finishing the current turn). */
export function showTodoSidebar(todos: TodoItem[], phase: SessionPhase): boolean {
  if (!todos.length) return false;
  if (hasActiveTodos(todos)) return true;
  return phase === "running";
}

export function TodoList(props: { todos: TodoItem[]; phase: SessionPhase }) {
  const todos = () => props.todos;
  const completed = () => countCompletedTodos(todos());
  const running = () => props.phase === "running";

  return (
    <>
      <text selectable={false} fg={theme.muted} attributes={BOLD}>
        tasks {completed()}/{todos().length}
      </text>
      <For each={todos()}>
        {(item) => {
          const checked = () => item.status === "completed";
          const active = () => item.status === "in_progress" && running();
          return (
            <box flexDirection="row" marginTop={0}>
              <text
                selectable={false}
                fg={todoStatusColor(item.status)}
                attributes={active() ? BOLD : 0}
              >
                [{todoCheckbox(item.status, running())}]
              </text>
              <text
                selectable={false}
                fg={checked() ? theme.muted : todoStatusColor(item.status)}
                attributes={active() ? BOLD : 0}
                wrapMode="word"
                flexGrow={1}
              >
                {" "}{item.content}
              </text>
            </box>
          );
        }}
      </For>
    </>
  );
}

export function TodoSidebar(props: { todos: TodoItem[]; phase: SessionPhase }) {
  const todos = () => props.todos;
  const visible = () => showTodoSidebar(todos(), props.phase);

  return (
    <Show when={visible()}>
      <box
        flexShrink={0}
        width={TODO_SIDEBAR_WIDTH}
        flexDirection="column"
        marginLeft={1}
        paddingLeft={1}
        border={["left"]}
        borderColor={theme.border}
        backgroundColor={theme.codeBg}
      >
        <TodoList todos={props.todos} phase={props.phase} />
      </box>
    </Show>
  );
}

export type InfoSidebarProps = {
  model: string;
  approval: string;
  cwd: string;
  provider?: string;
  sandbox?: string;
  costUsd?: number | null;
  tokenTotals?: number;
  contextTokens?: number;
  contextWindow?: number;
  branch?: string;
  sessionIsolation?: import("../agent/session-isolation.js").SessionIsolationMode;
  faux?: boolean;
  todos: TodoItem[];
  phase: SessionPhase;
};

function infoPath(props: Pick<InfoSidebarProps, "cwd" | "branch" | "sessionIsolation">): string {
  const home = process.env.HOME;
  const root =
    props.sessionIsolation === "worktree" && props.branch ? props.branch : props.cwd;
  return home && root.startsWith(home) ? `~${root.slice(home.length)}` : root;
}

export function InfoSidebar(props: InfoSidebarProps) {
  const todos = () => props.todos;
  const showTodos = () => showTodoSidebar(todos(), props.phase);
  const badge = () =>
    costBadge({ costUsd: props.costUsd, tokenTotals: props.tokenTotals, faux: props.faux });
  const context = () =>
    contextBadge({ contextTokens: props.contextTokens, contextWindow: props.contextWindow });
  const sandboxLabel = () =>
    props.sandbox && props.sandbox !== "local" ? props.sandbox : "";
  const modelLine = () => {
    const model = shortModel(props.model);
    return props.provider ? `${props.provider} · ${model}` : model;
  };
  const metaLine = () => {
    const parts = [props.approval];
    const sandbox = sandboxLabel();
    if (sandbox) parts.push(sandbox);
    const cost = badge();
    if (cost) parts.push(cost.replace(/^·\s*/, ""));
    const ctx = context();
    if (ctx) parts.push(ctx.replace(/^·\s*/, ""));
    return parts.join(" · ");
  };

  return (
    <SidebarShell title="session" width={INFO_SIDEBAR_WIDTH} edge="right">
      <scrollbox
        flexGrow={1}
        minHeight={0}
        scrollY
        contentOptions={{ flexDirection: "column" }}
        {...hiddenNativeScrollbar}
      >
        <SidebarRow tone="fg">{modelLine()}</SidebarRow>
        <SidebarRow>{metaLine()}</SidebarRow>
        <SidebarRow tone="muted">{infoPath(props)}</SidebarRow>
        <Show when={showTodos()}>
          <box flexDirection="column" marginTop={1} paddingTop={1} border={["top"]} borderColor={theme.border}>
            <TodoList todos={props.todos} phase={props.phase} />
          </box>
        </Show>
      </scrollbox>
    </SidebarShell>
  );
}

/** Id of the reasoning block that should show the live spinner, if any. */
export function activeReasoningBlockId(
  blocks: TurnBlock[],
  opts: { reasoningStreaming?: boolean; assistantText?: string },
): string | null {
  if (!opts.reasoningStreaming || opts.assistantText) return null;
  const last = blocks[blocks.length - 1];
  return last?.type === "reasoning" ? last.id : null;
}

function resolveStreamingFlag(streaming?: boolean | (() => boolean)): boolean {
  return typeof streaming === "function" ? streaming() : !!streaming;
}

export function shortModel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** Format a USD cost compactly: more precision for sub-dollar amounts. */
export function formatCostUsd(cost: number): string {
  return `$${cost.toFixed(cost < 1 ? 3 : 2)}`;
}

/** Compact token count, e.g. 512, 12.3k, 1.5M. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

/**
 * Muted header badge for the running session cost. Shows the dollar amount when
 * pricing is known, a token count when it isn't, `$0.00` under `--faux` (no real
 * spend), and nothing before the first turn lands.
 */
export function costBadge(opts: { costUsd?: number | null; tokenTotals?: number; faux?: boolean }): string {
  if (opts.faux) return "· $0.00";
  if (opts.costUsd != null) return `· ${formatCostUsd(opts.costUsd)}`;
  if (opts.tokenTotals && opts.tokenTotals > 0) return `· ${formatTokenCount(opts.tokenTotals)} tok`;
  return "";
}

/**
 * Muted header badge for how full the context window is: the latest main-loop
 * prompt size as a percentage of the active model's context window. Empty until
 * both a context reading and a window size are known, so it never shows a bogus
 * 0% before the first turn or while the window is still resolving.
 */
export function contextBadge(opts: { contextTokens?: number; contextWindow?: number }): string {
  const { contextTokens, contextWindow } = opts;
  if (!contextTokens || !contextWindow || contextWindow <= 0) return "";
  const pct = Math.min(100, Math.round((contextTokens / contextWindow) * 100));
  return `· ${pct}% ctx`;
}

/** Per-session cost label for the /sessions palette; `—` when unpriced. */
export function formatSessionCost(costUsd?: number | null): string {
  return costUsd != null ? formatCostUsd(costUsd) : "—";
}

/** Format a per-million-token rate for model list display. */
function formatPerMRate(rate: number): string {
  if (rate >= 0.1) return `$${rate.toFixed(2)}`;
  return `$${rate.toFixed(3)}`;
}

/** Input/output pricing suffix for the /model picker; `—` when unknown. */
export function formatModelPricingLabel(pricing?: ModelPricing): string {
  if (!pricing) return "—";
  return `in ${formatPerMRate(pricing.inputPerM)} · out ${formatPerMRate(pricing.outputPerM)}/M`;
}

/**
 * Compact context-window suffix for the /model picker, e.g. `200k ctx`, `1M ctx`.
 * Empty when the window is unknown so the row just omits it (no `—` noise next to
 * the pricing label).
 */
export function formatContextWindowLabel(tokens?: number): string {
  if (!tokens || tokens <= 0) return "";
  const compact =
    tokens >= 1_000_000
      ? `${+(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
      : tokens >= 1_000
        ? `${+(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1)}k`
        : `${tokens}`;
  return `${compact} ctx`;
}

const TOOL_SUMMARY_MAX = 56;
const READ_SUMMARY_MAX = 60;

/** Tallest the approval prompt can grow before it scrolls instead of expanding. */
const APPROVAL_MAX_ROWS = 12;

/**
 * Estimate how many terminal rows `text` occupies once word-wrapped to `width`.
 * Matches OpenTUI's word-wrap closely enough to decide whether the approval
 * prompt needs a scrollbox: long tokens that exceed the width wrap char-by-char,
 * just like the rendered `<text wrapMode="word">`.
 */
export function wrapLineCount(text: string, width: number): number {
  if (width <= 0) return 1;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let lines = 1;
  let col = 0;
  for (const rawWord of words) {
    let word = rawWord;
    while (word.length > 0) {
      if (col === 0) {
        // Place up to `width` chars of the word on the current line. If
        // anything is left, it begins a new line at column 0 — no leading
        // space, since we're continuing the same token across the wrap.
        const take = Math.min(word.length, width);
        word = word.slice(take);
        if (word.length > 0) {
          lines++;
          col = 0;
        } else {
          col = take;
        }
      } else if (col + 1 + word.length <= width) {
        col += 1 + word.length;
        word = "";
      } else {
        lines++;
        col = 0;
      }
    }
  }
  return lines;
}

/** Summaries longer than this wrap to a second line once the tool completes. */
export const TOOL_SUMMARY_INLINE_MAX = TOOL_SUMMARY_MAX;

export function shouldWrapToolSummary(summary: string): boolean {
  return summary.length > TOOL_SUMMARY_INLINE_MAX;
}

function truncateToolSummary(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 3)}…` : label;
}

function truncateReadSummary(label: string, max: number): string {
  return label.length > max ? `…${label.slice(-(max - 3))}` : label;
}

export function toolSummary(
  name: string,
  args: unknown,
  opts?: { truncate?: boolean; providerInputSchema?: Record<string, unknown> },
): string {
  const truncate = opts?.truncate ?? true;
  const clip = (label: string, max = TOOL_SUMMARY_MAX) =>
    truncate ? truncateToolSummary(label, max) : label;

  if (isMcpTool(name) && opts?.providerInputSchema) {
    return clip(formatMcpArgsSummary(args, opts.providerInputSchema));
  }

  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;

    if (name === "read" && typeof record.path === "string") {
      const offset = typeof record.offset === "number" ? record.offset : undefined;
      const limit = typeof record.limit === "number" ? record.limit : undefined;
      const suffix =
        offset !== undefined && limit !== undefined ? ` :${offset}+${limit}`
        : offset !== undefined ? ` :${offset}`
        : "";
      const label = record.path + suffix;
      return truncate ? truncateReadSummary(label, READ_SUMMARY_MAX) : label;
    }

    if (name === "grep" && typeof record.pattern === "string") {
      const context = typeof record.context === "number" ? record.context : undefined;
      const suffix = context !== undefined ? ` -C${context}` : "";
      return clip(record.pattern + suffix);
    }

    if (name === "skill_list") return "";

    if (name === "skill_use" && typeof record.name === "string") {
      const file = typeof record.file === "string" ? ` / ${record.file}` : "";
      return clip(record.name + file);
    }

    if (name === "askuser" && typeof record.question === "string") return clip(record.question);

    if (name === "skill_write" && typeof record.action === "string" && typeof record.name === "string") {
      const scope = typeof record.scope === "string" ? ` (${record.scope})` : "";
      return clip(`${record.action} ${record.name}${scope}`);
    }

    if (typeof record.path === "string") return record.path;
    if (typeof record.command === "string") {
      const bg = record.background === true ? "[bg] " : "";
      return clip(bg + record.command);
    }
    if (typeof record.task === "string") return clip(record.task);
    if (typeof record.description === "string") return clip(record.description);
    if (typeof record.pattern === "string") return record.pattern;
  }
  return clip(JSON.stringify(args));
}

function ReasoningBlock(props: {
  id: string;
  text: string;
  /** Boolean or accessor — accessors stay in sync when sibling blocks are appended. */
  streaming?: boolean | (() => boolean);
  /** Extra gap when this block follows a tool call. */
  spacedAbove?: boolean;
}) {
  const text = () => props.text;
  const toolExpand = useToolExpand();
  const hasText = () => text().length > 0;
  const streaming = () => resolveStreamingFlag(props.streaming);
  const [localExpanded, setLocalExpanded] = createSignal(toolExpand?.isExpanded(props.id) ?? false);

  const expanded = () => localExpanded();
  const setExpanded = (value: boolean) => {
    setLocalExpanded(value);
    toolExpand?.setExpanded(props.id, value);
  };

  const toggleExpanded = () => {
    if (!hasText()) return;
    setExpanded(!expanded());
  };

  const visible = () => hasText() || streaming();
  const glyph = () => {
    if (streaming()) return spinnerFrame();
    return expanded() ? "▾" : "▸";
  };

  onMount(() => {
    toolExpand?.setExpanded(props.id, expanded());
    toolExpand?.registerToggle(props.id, toggleExpanded);
    toolExpand?.registerCopyTarget(props.id, {
      label: "thinking",
      getOutput: () => text(),
      isExpanded: () => expanded(),
    });
  });
  onCleanup(() => {
    toolExpand?.registerToggle(props.id, null);
    toolExpand?.registerCopyTarget(props.id, null);
  });

  const hint = () => {
    if (streaming() && !hasText()) return "Thinking…";
    if (!hasText() || expanded()) return "";
    return outputExpandHint(text());
  };

  return (
    <Show when={visible()}>
      <box
        flexDirection="column"
        marginLeft={1}
        marginTop={props.spacedAbove ? 1 : 0}
        marginBottom={1}
        onMouseOver={() => toolExpand?.setHovered(props.id)}
        onMouseDown={() => toggleExpanded()}
      >
        <box flexDirection="row">
          <text selectable={false} fg={theme.accent} attributes={streaming() ? BOLD : 0}>
            {glyph()} thinking
          </text>
          <Show when={hint()}>
            <text selectable={false} fg={theme.muted}>  {hint()}</text>
          </Show>
        </box>
        <Show when={hasText() && expanded()}>
          <ReasoningOutputView text={text()} />
        </Show>
      </box>
    </Show>
  );
}

function ToolLine(props: { entry: ToolEntry; expandKey: string; nested?: boolean }) {
  const entry = () => props.entry;
  const expandKey = () => props.expandKey;
  const nested = () => props.nested ?? false;
  const toolExpand = useToolExpand();
  const displayOutput = createMemo(() => toolDisplayOutput(entry()));

  const showDiff = createMemo(() =>
    entry().name === "edit"
    && entry().status === "done"
    && !!entry().output
    && entry().output!.includes("@@"),
  );

  const hasPlainOutput = createMemo(() =>
    !!displayOutput()
    && entry().status !== "running"
    && !showDiff(),
  );

  const [expanded, setLocalExpanded] = createSignal(
    entry().status === "error" && hasPlainOutput(),
  );
  const setExpanded = (value: boolean) => {
    setLocalExpanded(value);
    toolExpand?.setExpanded(expandKey(), value);
  };

  const toggleExpanded = () => {
    if (!hasPlainOutput()) return;
    setExpanded(!expanded());
  };

  onMount(() => {
    toolExpand?.setExpanded(expandKey(), expanded());
    toolExpand?.registerToggle(expandKey(), toggleExpanded);
    toolExpand?.registerCopyTarget(expandKey(), {
      label: entry().name,
      getOutput: () => displayOutput(),
      isExpanded: () => expanded() || showDiff(),
    });
  });
  onCleanup(() => {
    toolExpand?.registerToggle(expandKey(), null);
    toolExpand?.registerCopyTarget(expandKey(), null);
  });

  createEffect(() => {
    if (entry().status === "error" && hasPlainOutput()) {
      setExpanded(true);
    }
  });

  const running = () => entry().status === "running";
  const glyph = () =>
    running() ? spinnerFrame() : entry().status === "error" ? "×" : "–";
  const toolNameColor = () =>
    running()
      ? theme.toolRunning
      : entry().status === "error"
        ? theme.toolError
        : theme.accent;
  const summary = createMemo(() => toolSummary(entry().name, entry().args, { truncate: running() }));
  const wrapSummary = () => { const s = summary(); return !running() && !!s && shouldWrapToolSummary(s); };
  const inlineSummary = () => !!summary() && !wrapSummary();
  const expandHint = () => (hasPlainOutput() && !expanded() ? outputExpandHint(displayOutput()!) : "");

  // Two-tone line via sibling <text> nodes in a row. Each <text fg> reliably
  // colors its run, and plain-string children update on the in-place replaceText
  // path (a reactive StyledText child instead appends a duplicate on every
  // re-render of the live turn; <span fg> doesn't apply color at all).
  return (
    <box
      flexDirection="column"
      marginLeft={nested() ? 3 : 1}
      onMouseOver={() => toolExpand?.setHovered(expandKey())}
    >
      <box
        flexDirection="row"
        onMouseDown={() => toggleExpanded()}
      >
        <text selectable={false} fg={toolNameColor()} attributes={running() ? BOLD : 0}>
          {nested() ? "↳ " : ""}{glyph()} {entry().name}
        </text>
        <Show when={inlineSummary()}>
          <text selectable={false} fg={theme.secondary}>  {summary()}</text>
        </Show>
        <Show when={expandHint()}>
          <text selectable={false} fg={theme.muted}>  {expandHint()}</text>
        </Show>
      </box>
      <Show when={wrapSummary()}>
        <text selectable={false} fg={theme.secondary} wrapMode="word" flexGrow={1}>
          {"  "}{summary()}
        </text>
      </Show>
      <Show when={entry().status === "error" && entry().output && !expanded()}>
        <text selectable {...surfaceSelection(theme.bg)} fg={theme.toolError} wrapMode="word" flexGrow={1}>  {entry().output!.split("\n")[0]}</text>
      </Show>
      <Show when={showDiff()}>
        <DiffView patch={entry().output!} />
      </Show>
      <Show when={hasPlainOutput() && expanded()}>
        <ToolOutputView output={displayOutput()!} />
      </Show>
    </box>
  );
}

function SubagentBlock(props: { subagent: SubagentContext; expandKeyPrefix: string }) {
  const subagent = () => props.subagent;
  const running = () => subagent().active || subagent().tools.some((t) => t.status === "running");

  return (
    <box flexDirection="column" marginLeft={2} marginTop={0}>
      <box flexDirection="row" marginBottom={subagent().tools.length ? 1 : 0}>
        <text selectable={false} fg={theme.subagent} attributes={running() ? BOLD : 0}>
          {running() ? spinnerFrame() : "▸"} subagent ({subagent().agent})
        </text>
        <text selectable={false} fg={theme.secondary}>  {subagent().description}</text>
      </box>
      <For each={subagent().tools}>
        {(child) => (
          <ToolLine
            entry={child}
            expandKey={`${props.expandKeyPrefix}/sub/${child.id}`}
            nested
          />
        )}
      </For>
    </box>
  );
}

function parseSkillFrontmatter(output: string | undefined): { version?: string; description?: string } {
  if (!output) return {};
  const match = output.match(/^---\n([\s\S]*?)\n---/m);
  if (!match) return {};
  const fm = match[1];
  const versionMatch = fm.match(/^version:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  return {
    version: versionMatch?.[1]?.trim(),
    description: descMatch?.[1]?.trim(),
  };
}

function SkillBlock(props: { entry: ToolEntry; expandKey: string }) {
  const entry = () => props.entry;
  const toolExpand = useToolExpand();
  const running = () => entry().status === "running";

  const name = createMemo(() => {
    const args = entry().args;
    if (args && typeof args === "object") {
      const n = (args as Record<string, unknown>).name;
      if (typeof n === "string") return n;
    }
    return "";
  });

  const parsed = createMemo(() => parseSkillFrontmatter(entry().output));
  const hasContent = createMemo(() => !!entry().output && entry().status !== "running");

  const [expanded, setLocalExpanded] = createSignal(false);
  const setExpanded = (value: boolean) => {
    setLocalExpanded(value);
    toolExpand?.setExpanded(props.expandKey, value);
  };
  const toggleExpanded = () => {
    if (!hasContent()) return;
    setExpanded(!expanded());
  };

  onMount(() => {
    toolExpand?.setExpanded(props.expandKey, expanded());
    toolExpand?.registerToggle(props.expandKey, toggleExpanded);
    toolExpand?.registerCopyTarget(props.expandKey, {
      label: name() || "skill",
      getOutput: () => entry().output,
      isExpanded: () => expanded(),
    });
  });
  onCleanup(() => {
    toolExpand?.registerToggle(props.expandKey, null);
    toolExpand?.registerCopyTarget(props.expandKey, null);
  });

  const glyph = () => (running() ? spinnerFrame() : "▸");
  const header = () => {
    const v = parsed().version;
    return v ? `${name()} v${v}` : name();
  };
  const expandHint = () => (hasContent() && !expanded() ? outputExpandHint(entry().output!) : "");

  return (
    <box
      flexDirection="column"
      marginLeft={1}
      onMouseOver={() => toolExpand?.setHovered(props.expandKey)}
    >
      <box flexDirection="row" onMouseDown={() => toggleExpanded()}>
        <text selectable={false} fg={running() ? theme.toolRunning : theme.accent} attributes={running() ? BOLD : 0}>
          {glyph()} skill
        </text>
        <text selectable={false} fg={theme.secondary}>  {header()}</text>
        <Show when={expandHint()}>
          <text selectable={false} fg={theme.muted}>  {expandHint()}</text>
        </Show>
      </box>
      <Show when={parsed().description}>
        {(desc) => (
          <text selectable={false} fg={theme.secondary}>  {desc()}</text>
        )}
      </Show>
      <Show when={hasContent() && expanded()}>
        <ToolOutputView output={entry().output!} />
      </Show>
    </box>
  );
}

/** Leaves a "what was asked / what they answered" record after an `askuser`
 *  call resolves — otherwise the question vanishes with the modal and the
 *  history reads as if nothing happened. */
function AskUserBlock(props: { entry: ToolEntry; expandKey: string }) {
  const entry = () => props.entry;
  const toolExpand = useToolExpand();
  const running = () => entry().status === "running";
  const isError = () => entry().status === "error";

  const question = createMemo(() => {
    const args = entry().args;
    if (args && typeof args === "object") {
      const q = (args as Record<string, unknown>).question;
      if (typeof q === "string") return q;
    }
    return "";
  });

  const answer = createMemo(() => {
    const output = entry().output ?? "";
    const match = output.match(/^The user answered: ([\s\S]*)$/);
    return match ? match[1]! : output;
  });

  const hasAnswer = createMemo(() => !running() && !!entry().output);

  onMount(() => {
    toolExpand?.registerCopyTarget(props.expandKey, {
      label: "askuser",
      getOutput: () => entry().output,
      isExpanded: () => true,
    });
  });
  onCleanup(() => {
    toolExpand?.registerCopyTarget(props.expandKey, null);
  });

  const glyph = () => (running() ? spinnerFrame() : isError() ? "×" : "▸");

  return (
    <box
      flexDirection="column"
      marginLeft={1}
      onMouseOver={() => toolExpand?.setHovered(props.expandKey)}
    >
      <box flexDirection="row">
        <text selectable={false} fg={running() ? theme.toolRunning : isError() ? theme.toolError : theme.accent} attributes={running() ? BOLD : 0}>
          {glyph()} ask
        </text>
        <text selectable={false} fg={theme.secondary} wrapMode="word" flexGrow={1}>  {question()}</text>
      </box>
      <Show when={hasAnswer()}>
        <text selectable {...surfaceSelection(theme.bg)} fg={isError() ? theme.toolError : theme.muted} wrapMode="word" flexGrow={1}>  → {answer()}</text>
      </Show>
    </box>
  );
}

function ToolBlock(props: { entry: ToolEntry; expandKeyPrefix: string }) {
  const expandKey = () => `${props.expandKeyPrefix}/${props.entry.id}`;
  return (
    <box flexDirection="column">
      <Show
        when={props.entry.name === "skill_use"}
        fallback={
          <Show
            when={props.entry.name === "askuser"}
            fallback={<ToolLine entry={props.entry} expandKey={expandKey()} />}
          >
            <AskUserBlock entry={props.entry} expandKey={expandKey()} />
          </Show>
        }
      >
        <SkillBlock entry={props.entry} expandKey={expandKey()} />
      </Show>
      <For each={props.entry.subagents ?? []}>
        {(subagent) => (
          <SubagentBlock
            subagent={subagent}
            expandKeyPrefix={`${expandKey()}/${subagent.id}`}
          />
        )}
      </For>
    </box>
  );
}

export function TurnView(props: {
  turn: Turn;
  turnKey: string;
  first?: boolean;
  reasoningId?: string;
  reasoningStreaming?: boolean;
}) {
  const turn = () => props.turn;
  const hasTools = () => turn().tools.length > 0;
  const hasBlocks = () => turn().blocks.length > 0;
  const showLegacyReasoning = () =>
    !hasBlocks() && (!!turn().reasoningText || props.reasoningStreaming);
  const activeReasoningId = createMemo(() =>
    activeReasoningBlockId(turn().blocks, {
      reasoningStreaming: props.reasoningStreaming,
      assistantText: turn().assistantText,
    }),
  );

  return (
    <box flexDirection="column" marginBottom={1}>
      <Show when={!props.first}>
        <box marginBottom={1}>
          <text fg={theme.border}>{"─".repeat(48)}</text>
        </box>
      </Show>
      <Show when={turn().userText}>
        <box flexDirection="row" marginBottom={1}>
          <text fg={theme.muted} attributes={BOLD}>you  </text>
          <text selectable {...surfaceSelection(theme.bg, theme.user)} fg={theme.user} attributes={BOLD} flexGrow={1} wrapMode="word">{turn().userText}</text>
        </box>
      </Show>
      <Show when={showLegacyReasoning()}>
        <ReasoningBlock
          id={props.reasoningId ?? "reasoning"}
          text={turn().reasoningText ?? ""}
          streaming={() => !!props.reasoningStreaming}
        />
      </Show>
      <Show when={hasBlocks()}>
        <For each={turn().blocks}>
          {(block, index) => {
            if (block.type === "reasoning") {
              const spacedAbove = index() > 0 && turn().blocks[index() - 1]?.type === "tool";
              return (
                <ReasoningBlock
                  id={`${props.turnKey}/${block.id}`}
                  text={block.text}
                  streaming={() => activeReasoningId() === block.id}
                  spacedAbove={spacedAbove}
                />
              );
            }
            return (
              <ToolBlock entry={block.entry} expandKeyPrefix={`${props.turnKey}/${block.entry.id}`} />
            );
          }}
        </For>
      </Show>
      <Show when={!hasBlocks()}>
        <For each={turn().tools}>
          {(entry) => <ToolBlock entry={entry} expandKeyPrefix={props.turnKey} />}
        </For>
      </Show>
      <Show when={turn().assistantText}>
        <box flexDirection="column" marginTop={hasTools() || hasBlocks() ? 1 : 0}>
          <Markdown content={turn().assistantText} />
        </box>
      </Show>
    </box>
  );
}

export function Header(props: {
  model: string;
  approval: string;
  cwd: string;
  provider?: string;
  sandbox?: string;
  costUsd?: number | null;
  tokenTotals?: number;
  contextTokens?: number;
  contextWindow?: number;
  branch?: string;
  sessionIsolation?: import("../agent/session-isolation.js").SessionIsolationMode;
  faux?: boolean;
}) {
  const path = () => {
    const home = process.env.HOME;
    const root = props.sessionIsolation === "worktree" && props.branch
      ? props.branch
      : props.cwd;
    return home && root.startsWith(home) ? `~${root.slice(home.length)}` : root;
  };
  const prefix = () => (props.provider ? `${props.provider}  ` : "");

  const sandboxLabel = () => (props.sandbox && props.sandbox !== "local" ? `  ${props.sandbox}` : "");

  const badge = () =>
    costBadge({ costUsd: props.costUsd, tokenTotals: props.tokenTotals, faux: props.faux });

  const context = () =>
    contextBadge({ contextTokens: props.contextTokens, contextWindow: props.contextWindow });

  return (
    <box paddingBottom={1}>
      <text fg={theme.muted} attributes={BOLD}>
        Orin  {prefix()}{shortModel(props.model)}  {props.approval}{sandboxLabel()}  {path()}{badge() ? `  ${badge()}` : ""}{context() ? `  ${context()}` : ""}
      </text>
    </box>
  );
}

export function ApprovalBar(props: {
  name: string;
  args: unknown;
  providerInputSchema?: Record<string, unknown>;
  /** Receives the inner scrollbox ref so the host can drive keyboard scrolling. */
  scrollRef?: (ref: ScrollBoxRenderable | undefined) => void;
  /** Re-read scroll geometry when this changes (mouse or keyboard scrolling). */
  railRevision: () => number;
  /** Bumped by the scrollbox on wheel scroll so the rail thumb refreshes. */
  onScroll: () => void;
}) {
  const label = () => (isMcpTool(props.name) ? formatMcpToolLabel(props.name) : props.name);
  const summary = () =>
    toolSummary(props.name, props.args, {
      truncate: false,
      providerInputSchema: props.providerInputSchema,
    });
  // The prompt is one logical line; "—  y / n" is appended so the affordance
  // stays visible even when the command scrolls past it.
  const prompt = () => `allow ${label()}?  ${summary()}  —  y / n`;

  const dims = useTerminalDimensions();
  // Cap the prompt so a huge bash command can't eat the whole screen — leave
  // room for the header, input, and conversation context. Grows with the
  // terminal but never above APPROVAL_MAX_ROWS.
  const maxRows = () =>
    Math.max(4, Math.min(APPROVAL_MAX_ROWS, Math.floor(dims().height * 0.4)));
  // Inner text width: app padding (2+2) + bar border (2) + bar padding (1+1).
  // When the rail is shown it claims one column, so the scrollable case wraps
  // one column narrower — use that narrower width for the line-count estimate
  // so we switch to the scrollbox before the rendered text would clip.
  const textWidth = () => Math.max(1, dims().width - 9);
  const scrollable = () => wrapLineCount(prompt(), textWidth()) > maxRows();

  let scrollRef: ScrollBoxRenderable | undefined;

  // Report the scrollbox ref to the host only while the scrollbox is mounted,
  // and clear it when the prompt shrinks back to plain text or the bar unmounts
  // — otherwise the host would drive keyboard scroll against a destroyed box.
  // The mount report lives in the ref callback (runs in both the real and the
  // server/test renderer, unlike createEffect); the effect below only covers
  // the terminal-resize flip from scrollable back to plain text in the real app.
  createEffect(() => {
    props.scrollRef?.(scrollable() ? scrollRef : undefined);
  });
  onCleanup(() => props.scrollRef?.(undefined));

  return (
    <box
      flexShrink={0}
      marginTop={1}
      marginBottom={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      borderStyle="rounded"
      border
      borderColor={theme.border}
      backgroundColor={theme.codeBg}
    >
      <Show
        when={scrollable()}
        fallback={
          <text fg={theme.approval} attributes={BOLD} wrapMode="word" flexGrow={1}>
            {prompt()}
          </text>
        }
      >
        <box flexDirection="row" height={maxRows()}>
          <scrollbox
            ref={(r: ScrollBoxRenderable) => {
              scrollRef = r;
              props.scrollRef?.(r);
            }}
            flexGrow={1}
            height={maxRows()}
            scrollY
            contentOptions={{ flexDirection: "column" }}
            {...hiddenNativeScrollbar}
            onMouseScroll={(event) => {
              stopToolOutputScrollBubble(scrollRef, event);
              props.onScroll();
            }}
          >
            <text fg={theme.approval} attributes={BOLD} wrapMode="word" flexGrow={1}>
              {prompt()}
            </text>
          </scrollbox>
          <ScrollRail
            scrollRef={() => scrollRef}
            revision={props.railRevision()}
            trackColor={scrollbars.toolOutput.track}
            thumbColor={scrollbars.toolOutput.thumb}
          />
        </box>
      </Show>
    </box>
  );
}

export function QuestionBar(props: {
  question: string;
  options: string[];
  selectedIndex: number;
}) {
  return (
    <box
      flexShrink={0}
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      borderStyle="rounded"
      border
      borderColor={theme.approval}
      backgroundColor={theme.codeBg}
    >
      <text fg={theme.approval} attributes={BOLD} wrapMode="word">
        {props.question}
      </text>
      <box flexDirection="column" marginTop={1}>
        <For each={props.options}>
          {(option, i) => {
            const selected = () => props.selectedIndex === i();
            return (
              <text
                fg={selected() ? theme.accent : theme.fg}
                attributes={selected() ? BOLD : 0}
                wrapMode="word"
              >
                {selected() ? "▶ " : "  "}{i() + 1}. {option}
              </text>
            );
          }}
        </For>
      </box>
    </box>
  );
}
