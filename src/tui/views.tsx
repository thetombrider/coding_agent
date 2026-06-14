import { Box, Text } from "ink";
import type { ToolEntry, Turn } from "./controller.js";
import { sliceAssistantLines, type TurnViewSlice } from "./scroll.js";
import { DiffView } from "./diff.js";
import { Markdown } from "./markdown.js";
import { theme } from "./theme.js";

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

function ToolLine({ entry }: { entry: ToolEntry }) {
  const showDiff =
    entry.name === "edit"
    && entry.status === "done"
    && entry.output
    && entry.output.includes("@@");

  const glyph =
    entry.status === "running" ? "·"
    : entry.status === "error" ? "×"
    : "–";
  const color =
    entry.status === "running" ? theme.toolRunning
    : entry.status === "error" ? theme.toolError
    : theme.toolDone;

  return (
    <Box flexDirection="column" marginLeft={1} marginBottom={0}>
      <Text bold={entry.status === "running"} color={color}>
        {glyph} {entry.name} {toolSummary(entry.name, entry.args)}
      </Text>
      {entry.status === "error" && entry.output ? (
        <Text color={theme.toolError}>  {entry.output.split("\n")[0]}</Text>
      ) : null}
      {showDiff && entry.output ? <DiffView patch={entry.output} /> : null}
    </Box>
  );
}

export function TurnView({
  turn,
  slice,
  width,
}: {
  turn: Turn;
  slice?: TurnViewSlice;
  width: number;
}) {
  const showUser = slice ? slice.showUser : Boolean(turn.userText);
  const toolEntries = slice
    ? slice.toolIndices.map((i) => turn.tools[i]!).filter(Boolean)
    : turn.tools;
  const assistantText = turn.assistantText
    ? slice
      ? sliceAssistantLines(
        turn.assistantText,
        slice.assistantStartLine,
        slice.assistantEndLine,
        width,
      )
    : turn.assistantText
    : "";

  return (
    <Box flexDirection="column" marginBottom={1}>
      {showUser && turn.userText ? (
        <Box marginBottom={1}>
          <Text bold color={theme.user}>{turn.userText}</Text>
        </Box>
      ) : null}
      {toolEntries.map((entry) => (
        <ToolLine key={entry.id} entry={entry} />
      ))}
      {assistantText ? (
        <Box marginTop={toolEntries.length ? 1 : 0} flexDirection="column">
          <Markdown content={assistantText} />
        </Box>
      ) : null}
    </Box>
  );
}

export function Header({ model, approval, cwd }: { model: string; approval: string; cwd: string }) {
  const home = process.env.HOME;
  const path = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;

  return (
    <Box paddingBottom={1}>
      <Text color={theme.muted} bold>
        minicoder  {shortModel(model)}  {approval}  {path}
      </Text>
    </Box>
  );
}

export function PromptLine({
  value,
  disabled,
  hint,
}: {
  value: string;
  disabled: boolean;
  hint: string;
}) {
  return (
    <Box flexDirection="column" marginTop={1} paddingTop={1} borderStyle="single" borderColor={theme.border} borderTop borderBottom={false} borderLeft={false} borderRight={false}>
      <Text>
        <Text bold color={theme.accent}>› </Text>
        <Text bold color={theme.fg}>{value}</Text>
        {!disabled ? <Text bold color={theme.fg}>▍</Text> : null}
      </Text>
      <Text color={theme.secondary}>{hint}</Text>
    </Box>
  );
}

export function ApprovalBar({ name, args }: { name: string; args: unknown }) {
  return (
    <Box marginY={1} paddingX={1} backgroundColor={theme.codeBg} borderStyle="round" borderColor={theme.border}>
      <Text bold color={theme.approval}>
        allow {name}?  {toolSummary(name, args)}  —  y / n
      </Text>
    </Box>
  );
}
