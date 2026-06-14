import { createTextAttributes } from "@opentui/core";
import { For, Show } from "solid-js";
import type { ToolEntry, Turn } from "./controller.js";
import { DiffView } from "./diff.js";
import { Markdown } from "./markdown.js";
import { spinnerFrame } from "./spinner.js";
import { theme } from "./theme.js";

const BOLD = createTextAttributes({ bold: true });

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

function ToolLine(props: { entry: ToolEntry }) {
  const entry = () => props.entry;
  const showDiff = () =>
    entry().name === "edit"
    && entry().status === "done"
    && !!entry().output
    && entry().output!.includes("@@");

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

  // Two-tone line via sibling <text> nodes in a row. Each <text fg> reliably
  // colors its run, and plain-string children update on the in-place replaceText
  // path (a reactive StyledText child instead appends a duplicate on every
  // re-render of the live turn; <span fg> doesn't apply color at all).
  return (
    <box flexDirection="column" marginLeft={1}>
      <box flexDirection="row">
        <text fg={accent()} attributes={running() ? BOLD : 0}>{glyph()} {entry().name}</text>
        <Show when={summary()}>
          <text fg={theme.secondary}>  {summary()}</text>
        </Show>
      </box>
      <Show when={entry().status === "error" && entry().output}>
        <text fg={theme.toolError}>  {entry().output!.split("\n")[0]}</text>
      </Show>
      <Show when={showDiff()}>
        <DiffView patch={entry().output!} />
      </Show>
    </box>
  );
}

export function TurnView(props: { turn: Turn; first?: boolean }) {
  const turn = () => props.turn;
  const hasTools = () => turn().tools.length > 0;

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
          <text fg={theme.user} attributes={BOLD} flexGrow={1} wrapMode="word">{turn().userText}</text>
        </box>
      </Show>
      <For each={turn().tools}>{(entry) => <ToolLine entry={entry} />}</For>
      <Show when={turn().assistantText}>
        <box flexDirection="column" marginTop={hasTools() ? 1 : 0}>
          <Markdown content={turn().assistantText} />
        </box>
      </Show>
    </box>
  );
}

export function Header(props: { model: string; approval: string; cwd: string }) {
  const path = () => {
    const home = process.env.HOME;
    return home && props.cwd.startsWith(home) ? `~${props.cwd.slice(home.length)}` : props.cwd;
  };

  return (
    <box paddingBottom={1}>
      <text fg={theme.muted} attributes={BOLD}>
        minicoder  {shortModel(props.model)}  {props.approval}  {path()}
      </text>
    </box>
  );
}

export function ApprovalBar(props: { name: string; args: unknown }) {
  return (
    <box
      marginTop={1}
      marginBottom={1}
      paddingLeft={1}
      paddingRight={1}
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
