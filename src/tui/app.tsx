import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { TuiController, TuiState } from "./controller.js";
import { DiffView } from "./diff.js";

function toolStatusIcon(status: TuiState["tools"][number]["status"]): string {
  switch (status) {
    case "running":
      return "◌";
    case "done":
      return "✓";
    case "error":
      return "✗";
  }
}

function toolStatusColor(status: TuiState["tools"][number]["status"]): string {
  switch (status) {
    case "running":
      return "yellow";
    case "done":
      return "green";
    case "error":
      return "red";
  }
}

function formatArgs(args: unknown): string {
  const text = JSON.stringify(args);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function ToolRow({ entry }: { entry: TuiState["tools"][number] }) {
  const showDiff =
    entry.name === "edit"
    && entry.status === "done"
    && entry.output
    && entry.output.includes("@@");

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={toolStatusColor(entry.status)}>{toolStatusIcon(entry.status)} </Text>
        <Text bold>{entry.name}</Text>
        <Text dimColor> {formatArgs(entry.args)}</Text>
      </Text>
      {entry.status === "error" && entry.output ? (
        <Box marginLeft={2}>
          <Text color="red">{entry.output}</Text>
        </Box>
      ) : null}
      {showDiff && entry.output ? <DiffView patch={entry.output} /> : null}
      {entry.status === "done" && entry.output && !showDiff ? (
        <Box marginLeft={2}>
          <Text dimColor>{entry.output.split("\n")[0]}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function App({
  controller,
  onExit,
}: {
  controller: TuiController;
  onExit: () => void;
}) {
  const [state, setState] = useState<TuiState>(controller.getState());

  useEffect(() => controller.subscribe(setState), [controller]);

  useInput((input, key) => {
    if (!state.pendingApproval) {
      if (state.loopDone && (key.return || input === "q")) onExit();
      return;
    }

    const lower = input.toLowerCase();
    if (lower === "y") controller.respondApproval(true);
    if (lower === "n" || key.escape) controller.respondApproval(false);
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>{state.statusLine}</Text>
      <Box marginY={1} flexDirection="column">
        {state.assistantText ? <Text>{state.assistantText}</Text> : null}
      </Box>
      {state.tools.map((entry) => (
        <ToolRow key={entry.id} entry={entry} />
      ))}
      {state.pendingApproval ? (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">
            Approve {state.pendingApproval.name}?
          </Text>
          <Text dimColor>{formatArgs(state.pendingApproval.args)}</Text>
          <Text>Press y to allow, n to deny</Text>
        </Box>
      ) : null}
      {state.loopDone ? (
        <Box marginTop={1}>
          <Text dimColor>Done ({state.loopReason}). Press Enter or q to exit.</Text>
        </Box>
      ) : null}
    </Box>
  );
}
