import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { SessionController, SessionState, Turn } from "./controller.js";
import { theme } from "./theme.js";
import { useSpinnerClock } from "./spinner.js";
import { ApprovalBar, Header, TurnView } from "./views.js";

const BOLD = createTextAttributes({ bold: true });

function currentTurn(state: SessionState): Turn | null {
  if (!state.currentUserText && !state.streamingText && state.currentTools.length === 0) {
    return null;
  }
  return {
    userText: state.currentUserText,
    assistantText: state.streamingText,
    tools: state.currentTools,
  };
}

export function App(props: {
  controller: SessionController;
  onSubmit: (text: string) => void | Promise<void>;
  onExit: () => void;
}) {
  const [state, setState] = createSignal(props.controller.getState());
  const [submitting, setSubmitting] = createSignal(false);
  onCleanup(props.controller.subscribe(setState));
  useSpinnerClock();

  let scrollRef: ScrollBoxRenderable | undefined;
  let inputRef: InputRenderable | undefined;

  const live = () => currentTurn(state());
  const completed = () => state().completedTurns;
  const hasContent = () => completed().length > 0 || live() !== null;

  const handleSubmit = async (raw: string) => {
    const text = raw.trim();
    if (inputRef) inputRef.value = "";
    if (!text || submitting() || state().phase !== "input") return;

    if (text === "/exit" || text === "/quit") {
      props.onExit();
      return;
    }
    if (text === "/clear") {
      props.controller.clearHistory();
      props.controller.clearInput();
      return;
    }

    props.controller.clearInput();
    setSubmitting(true);
    try {
      await props.onSubmit(text);
    } finally {
      setSubmitting(false);
    }
  };

  useKeyboard((key) => {
    const phase = state().phase;

    if (phase === "approval") {
      if (key.name === "y") props.controller.respondApproval(true);
      if (key.name === "n" || key.name === "escape") props.controller.respondApproval(false);
      return;
    }

    if (key.ctrl && key.name === "c") {
      props.onExit();
      return;
    }

    if (!scrollRef) return;
    const page = Math.max(3, Math.floor(scrollRef.viewport.height / 2));
    switch (key.name) {
      case "up":
        scrollRef.scrollBy({ x: 0, y: -2 });
        return;
      case "down":
        scrollRef.scrollBy({ x: 0, y: 2 });
        return;
      case "pageup":
        scrollRef.scrollBy({ x: 0, y: -page });
        return;
      case "pagedown":
        scrollRef.scrollBy({ x: 0, y: page });
        return;
      case "end":
        scrollRef.scrollTo({ x: 0, y: scrollRef.scrollHeight });
        return;
    }
  });

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexShrink={0}>
        <Header model={state().meta.model} approval={state().meta.approval} cwd={state().meta.cwd} />
      </box>

      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        contentOptions={{ flexDirection: "column" }}
      >
        <Show when={hasContent()} fallback={<text fg={theme.fg}>Ask anything about this codebase.</text>}>
          <For each={completed()}>{(turn, i) => <TurnView turn={turn} first={i() === 0} />}</For>
          <Show when={live()}>{(turn) => <TurnView turn={turn()} first={completed().length === 0} />}</Show>
        </Show>
      </scrollbox>

      <Show when={state().pendingApproval}>
        {(pending) => <ApprovalBar name={pending().name} args={pending().args} />}
      </Show>

      <box flexShrink={0} flexDirection="column" marginTop={1} paddingTop={1} border={["top"]} borderColor={theme.border}>
        <box flexDirection="row">
          <text fg={theme.accent} attributes={BOLD}>› </text>
          <input
            ref={inputRef}
            flexGrow={1}
            focused={state().phase === "input" && !submitting()}
            textColor={theme.fg}
            focusedTextColor={theme.fg}
            backgroundColor={theme.bg}
            focusedBackgroundColor={theme.bg}
            onInput={(value) => props.controller.setInput(value)}
            onSubmit={() => void handleSubmit(inputRef?.value ?? "")}
          />
        </box>
        <text fg={theme.secondary}>{state().statusHint}</text>
      </box>
    </box>
  );
}
