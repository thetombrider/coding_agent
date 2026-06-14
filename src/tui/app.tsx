import { Box, Static, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import type { SessionController } from "./controller.js";
import { theme } from "./theme.js";
import { ApprovalBar, Header, PromptLine, TurnView } from "./views.js";

export function App({
  controller,
  onSubmit,
  onExit,
}: {
  controller: SessionController;
  onSubmit: (text: string) => void | Promise<void>;
  onExit: () => void;
}) {
  const [state, setState] = useState(controller.getState());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => controller.subscribe(setState), [controller]);

  const handleSubmit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || submitting || state.phase !== "input") return;

      if (text === "/exit" || text === "/quit") {
        onExit();
        return;
      }
      if (text === "/clear") {
        controller.clearHistory();
        controller.clearInput();
        return;
      }

      controller.clearInput();
      setSubmitting(true);
      try {
        await onSubmit(text);
      } finally {
        setSubmitting(false);
      }
    },
    [controller, onExit, onSubmit, state.phase, submitting],
  );

  useInput((input, key) => {
    if (state.phase === "approval") {
      const lower = input.toLowerCase();
      if (lower === "y") controller.respondApproval(true);
      if (lower === "n" || key.escape) controller.respondApproval(false);
      return;
    }

    if (key.ctrl && input === "c") {
      onExit();
      return;
    }

    if (state.phase !== "input" || submitting) return;

    if (key.return) {
      void handleSubmit(state.input);
      return;
    }
    if (key.backspace || key.delete) {
      controller.backspaceInput();
      return;
    }
    if (key.escape) {
      controller.clearInput();
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      controller.appendInput(input);
    }
  });

  const { meta, completedTurns, currentUserText, streamingText, currentTools, input, phase } = state;
  const inputDisabled = phase !== "input" || submitting;
  const showCurrentTurn = currentUserText || streamingText || currentTools.length > 0;

  return (
    <Box
      flexDirection="column"
      width="100%"
      minHeight={process.stdout.rows ?? 24}
      backgroundColor={theme.bg}
      paddingX={2}
      paddingY={1}
    >
      <Header model={meta.model} approval={meta.approval} cwd={meta.cwd} />

      <Box flexDirection="column" flexGrow={1}>
        <Static items={completedTurns}>
          {(turn, index) => (
            <Box key={`turn-${index}`} backgroundColor={theme.bg}>
              <TurnView turn={turn} />
            </Box>
          )}
        </Static>

        {showCurrentTurn ? (
          <TurnView
            turn={{
              userText: currentUserText,
              assistantText: streamingText,
              tools: currentTools,
            }}
          />
        ) : completedTurns.length === 0 ? (
          <Text color={theme.fg}>Ask anything about this codebase.</Text>
        ) : null}

        {state.pendingApproval ? (
          <ApprovalBar name={state.pendingApproval.name} args={state.pendingApproval.args} />
        ) : null}
      </Box>

      <PromptLine
        value={inputDisabled ? "" : input}
        disabled={inputDisabled}
        hint={state.statusHint}
      />
    </Box>
  );
}
