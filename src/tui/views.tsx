import { createTextAttributes } from "@opentui/core";
import { createSignal, createEffect, For, onCleanup, onMount, Show } from "solid-js";
import type { ToolEntry, Turn } from "./controller.js";
import type { TodoItem, TodoStatus } from "../todos/types.js";
import { countCompletedTodos, hasActiveTodos } from "../todos/store.js";
import type { SessionPhase } from "./controller.js";
import { DiffView } from "./diff.js";
import { ToolOutputView, ReasoningOutputView } from "./expandable.js";
import { Markdown } from "./markdown.js";
import { spinnerFrame } from "./spinner.js";
import { theme } from "./theme.js";
import { useToolExpand } from "./tool-expand.js";
import { outputExpandHint } from "./tool-output.js";

const BOLD = createTextAttributes({ bold: true });

export const TODO_SIDEBAR_WIDTH = 30;

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

export function TodoSidebar(props: { todos: TodoItem[]; phase: SessionPhase }) {
  const todos = () => props.todos;
  const visible = () => showTodoSidebar(todos(), props.phase);
  const completed = () => countCompletedTodos(todos());
  const running = () => props.phase === "running";

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
      </box>
    </Show>
  );
}

export function shortModel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

export function toolSummary(_name: string, args: unknown): string {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.path === "string") return record.path;
    if (typeof record.command === "string") {
      const cmd = record.command;
      return cmd.length > 56 ? `${cmd.slice(0, 53)}…` : cmd;
    }
    if (typeof record.task === "string") {
      const task = record.task;
      return task.length > 56 ? `${task.slice(0, 53)}…` : task;
    }
    if (typeof record.pattern === "string") return record.pattern;
  }
  const json = JSON.stringify(args);
  return json.length > 56 ? `${json.slice(0, 53)}…` : json;
}

function ReasoningBlock(props: { id: string; text: string; streaming?: boolean }) {
  const text = () => props.text;
  const toolExpand = useToolExpand();
  const hasText = () => text().length > 0;
  const [expanded, setExpanded] = createSignal(false);

  const toggleExpanded = () => {
    if (!hasText()) return;
    setExpanded((value) => !value);
  };

  onMount(() => {
    toolExpand?.registerToggle(props.id, toggleExpanded);
    toolExpand?.registerCopyTarget(props.id, {
      getOutput: () => text(),
      isExpanded: () => expanded(),
    });
  });
  onCleanup(() => {
    toolExpand?.registerToggle(props.id, null);
    toolExpand?.registerCopyTarget(props.id, null);
  });

  const hint = () => {
    if (props.streaming && !hasText()) return "Thinking…";
    if (!hasText()) return "";
    return expanded() ? "" : outputExpandHint(text());
  };

  return (
    <box
      flexDirection="column"
      marginLeft={1}
      marginBottom={1}
      onMouseOver={() => toolExpand?.setHovered(props.id)}
    >
      <box
        flexDirection="row"
        onMouseDown={() => toggleExpanded()}
      >
        <text selectable={false} fg={theme.reasoning} attributes={props.streaming ? BOLD : 0}>
          {props.streaming && !hasText() ? "◌" : "▸"} thinking
        </text>
        <Show when={hint()}>
          <text selectable={false} fg={theme.muted}>  {hint()}</text>
        </Show>
        <Show when={expanded() && hasText()}>
          <text selectable={false} fg={theme.muted}>  c copy</text>
        </Show>
      </box>
      <Show when={hasText() && expanded()}>
        <ReasoningOutputView text={text()} />
      </Show>
    </box>
  );
}

function ToolLine(props: { entry: ToolEntry; expandKey: string }) {
  const entry = () => props.entry;
  const expandKey = () => props.expandKey;
  const toolExpand = useToolExpand();
  const showDiff = () =>
    entry().name === "edit"
    && entry().status === "done"
    && !!entry().output
    && entry().output!.includes("@@");

  const hasPlainOutput = () =>
    !!entry().output
    && entry().status !== "running"
    && !showDiff();

  const [expanded, setExpanded] = createSignal(
    entry().status === "error" && hasPlainOutput(),
  );

  const toggleExpanded = () => {
    if (!hasPlainOutput()) return;
    setExpanded((value) => !value);
  };

  onMount(() => {
    toolExpand?.registerToggle(expandKey(), toggleExpanded);
    toolExpand?.registerCopyTarget(expandKey(), {
      getOutput: () => entry().output,
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
  const accent = () =>
    running()
      ? theme.toolRunning
      : entry().status === "error"
        ? theme.toolError
        : theme.toolDone;
  const summary = () => toolSummary(entry().name, entry().args);
  const expandHint = () => (hasPlainOutput() && !expanded() ? outputExpandHint(entry().output!) : "");
  const copyHint = () => ((expanded() || showDiff()) && entry().output ? "c copy" : "");

  // Two-tone line via sibling <text> nodes in a row. Each <text fg> reliably
  // colors its run, and plain-string children update on the in-place replaceText
  // path (a reactive StyledText child instead appends a duplicate on every
  // re-render of the live turn; <span fg> doesn't apply color at all).
  return (
    <box
      flexDirection="column"
      marginLeft={1}
      onMouseOver={() => toolExpand?.setHovered(expandKey())}
    >
      <box
        flexDirection="row"
        onMouseDown={() => toggleExpanded()}
      >
        <text selectable={false} fg={accent()} attributes={running() ? BOLD : 0}>{glyph()} {entry().name}</text>
        <Show when={summary()}>
          <text selectable={false} fg={theme.secondary}>  {summary()}</text>
        </Show>
        <Show when={expandHint()}>
          <text selectable={false} fg={theme.muted}>  {expandHint()}</text>
        </Show>
        <Show when={copyHint()}>
          <text selectable={false} fg={theme.muted}>  {copyHint()}</text>
        </Show>
      </box>
      <Show when={entry().status === "error" && entry().output && !expanded()}>
        <text selectable fg={theme.toolError}>  {entry().output!.split("\n")[0]}</text>
      </Show>
      <Show when={showDiff()}>
        <DiffView patch={entry().output!} />
      </Show>
      <Show when={hasPlainOutput() && expanded()}>
        <ToolOutputView output={entry().output!} />
      </Show>
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
  const showReasoning = () => !!turn().reasoningText || props.reasoningStreaming;

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
          <text selectable fg={theme.user} attributes={BOLD} flexGrow={1} wrapMode="word">{turn().userText}</text>
        </box>
      </Show>
      <Show when={showReasoning()}>
        <ReasoningBlock
          id={props.reasoningId ?? "reasoning"}
          text={turn().reasoningText ?? ""}
          streaming={props.reasoningStreaming}
        />
      </Show>
      <For each={turn().tools}>
        {(entry) => <ToolLine entry={entry} expandKey={`${props.turnKey}/${entry.id}`} />}
      </For>
      <Show when={turn().assistantText}>
        <box flexDirection="column" marginTop={hasTools() ? 1 : 0}>
          <Markdown content={turn().assistantText} />
        </box>
      </Show>
    </box>
  );
}

export function Header(props: { model: string; approval: string; cwd: string; provider?: string; sandbox?: string }) {
  const path = () => {
    const home = process.env.HOME;
    return home && props.cwd.startsWith(home) ? `~${props.cwd.slice(home.length)}` : props.cwd;
  };
  const prefix = () => (props.provider ? `${props.provider}  ` : "");

  const sandboxLabel = () => (props.sandbox && props.sandbox !== "local" ? `  ${props.sandbox}` : "");

  return (
    <box paddingBottom={1}>
      <text fg={theme.muted} attributes={BOLD}>
        Orin  {prefix()}{shortModel(props.model)}  {props.approval}{sandboxLabel()}  {path()}
      </text>
    </box>
  );
}

export function ApprovalBar(props: { name: string; args: unknown }) {
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
      <text fg={theme.approval} attributes={BOLD}>
        allow {props.name}?  {toolSummary(props.name, props.args)}  —  y / n
      </text>
    </box>
  );
}
