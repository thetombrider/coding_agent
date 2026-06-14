import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScrollLayout, SessionController, Turn } from "./controller.js";
import { messageBodyRows, totalContentLines, visibleContentWindow } from "./scroll.js";
import { theme } from "./theme.js";
import { ApprovalBar, Header, PromptLine, TurnView } from "./views.js";

function currentTurn(state: ReturnType<SessionController["getState"]>): Turn | null {
  if (!state.currentUserText && !state.streamingText && state.currentTools.length === 0) {
    return null;
  }
  return {
    userText: state.currentUserText,
    assistantText: state.streamingText,
    tools: state.currentTools,
  };
}

export function App({
  controller,
  onSubmit,
  onExit,
}: {
  controller: SessionController;
  onSubmit: (text: string) => void | Promise<void>;
  onExit: () => void;
}) {
  const { stdout } = useStdout();
  const [state, setState] = useState(controller.getState());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => controller.subscribe(setState), [controller]);

  const rows = stdout.rows ?? 24;
  const cols = Math.max(40, (stdout.columns ?? 80) - 4);
  const bodyRows = messageBodyRows(rows);

  const live = currentTurn(state);
  const allTurns = live ? [...state.completedTurns, live] : state.completedTurns;

  const scrollLayout: ScrollLayout = useMemo(
    () => ({
      totalLines: totalContentLines(allTurns, cols),
      viewportLines: bodyRows,
    }),
    [allTurns, cols, bodyRows],
  );

  const content = useMemo(
    () => visibleContentWindow(
      state.completedTurns,
      live,
      bodyRows,
      cols,
      state.followTail,
      state.scrollAnchorLine,
    ),
    [
      state.completedTurns,
      live,
      bodyRows,
      cols,
      state.followTail,
      state.scrollAnchorLine,
    ],
  );

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

    const pageStep = Math.max(3, Math.floor(bodyRows / 2));
    const lineStep = key.pageUp || key.pageDown ? pageStep : 2;
    const canScrollHistory = !state.input || state.phase !== "input";

    if (key.pageUp || (key.upArrow && canScrollHistory)) {
      controller.scrollUpLines(scrollLayout, lineStep);
      return;
    }
    if (key.pageDown || (key.downArrow && canScrollHistory)) {
      controller.scrollDownLines(scrollLayout, lineStep);
      return;
    }
    if (key.end || (key.ctrl && input === "e")) {
      controller.scrollToBottom();
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

  const { meta, input, phase } = state;
  const inputDisabled = phase !== "input" || submitting;

  return (
    <Box
      flexDirection="column"
      width="100%"
      height={rows}
      backgroundColor={theme.bg}
      paddingX={2}
      paddingY={1}
    >
      <Box flexShrink={0}>
        <Header model={meta.model} approval={meta.approval} cwd={meta.cwd} />
      </Box>

      <Box
        flexDirection="column"
        flexGrow={1}
        height={bodyRows}
        overflowY="hidden"
      >
        {content.hiddenBeforeLines > 0 ? (
          <Text color={theme.muted}>↑ {content.hiddenBeforeLines} lines earlier in chat</Text>
        ) : null}

        {content.slices.length === 0 ? (
          <Text color={theme.fg}>Ask anything about this codebase.</Text>
        ) : (
          content.slices.map(({ turn, slice }, index) => (
            <TurnView
              key={`${index}-${turn.userText.slice(0, 24)}-${slice.assistantStartLine}`}
              turn={turn}
              slice={slice}
              width={cols}
            />
          ))
        )}

        {content.hiddenAfterLines > 0 ? (
          <Text color={theme.muted}>↓ {content.hiddenAfterLines} lines below · End to follow</Text>
        ) : null}

        {state.pendingApproval ? (
          <ApprovalBar name={state.pendingApproval.name} args={state.pendingApproval.args} />
        ) : null}
      </Box>

      <Box flexShrink={0}>
        <PromptLine
          value={inputDisabled ? "" : input}
          disabled={inputDisabled}
          hint={state.statusHint}
        />
      </Box>
    </Box>
  );
}
