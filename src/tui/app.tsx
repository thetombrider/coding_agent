import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { SessionController, SessionState, Turn } from "./controller.js";
import { theme } from "./theme.js";
import { useSpinnerClock } from "./spinner.js";
import { ApprovalBar, Header, TurnView } from "./views.js";
import { processCommand } from "./commands.js";
import { APPROVAL_MODES, APPROVAL_MODE_LABELS, coerceApprovalMode, type ApprovalMode } from "../approval/policy.js";
import { KNOWN_MAIN_MODELS } from "../config/models.js";
import type { SessionSummary } from "../session/log.js";

const BOLD = createTextAttributes({ bold: true });

const SLASH_COMMANDS = [
  { name: "model",    label: "/model",    description: "switch model" },
  { name: "mode",     label: "/mode",     description: "set approval mode" },
  { name: "sandbox",  label: "/sandbox",  description: "local or E2B sandbox" },
  { name: "sessions", label: "/sessions", description: "browse sessions" },
  { name: "new",      label: "/new",      description: "archive & start new session" },
  { name: "clear",    label: "/clear",    description: "clear conversation" },
  { name: "help",     label: "/help",     description: "show help" },
  { name: "exit",     label: "/exit",     description: "quit" },
] as const;

type CommandName = (typeof SLASH_COMMANDS)[number]["name"];

type PaletteState =
  | { phase: "commands"; index: number }
  | { phase: "model"; index: number }
  | { phase: "mode"; index: number }
  | { phase: "sessions"; index: number; sessions: SessionSummary[] };

function formatSessionDate(ts: string): string {
  try {
    const d = new Date(ts);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day} ${hour}:${min}`;
  } catch {
    return ts;
  }
}

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
  onSetModel: (model: string) => void;
  onSetMode: (mode: ApprovalMode) => void;
  onSetSandbox: (kind: "local" | "e2b") => void | Promise<void>;
  getSandbox: () => "local" | "e2b";
  onClear: () => void;
  onNew: () => void;
  onResume: (sessionId: string) => void;
  onListSessions: () => SessionSummary[];
}) {
  const [state, setState] = createSignal(props.controller.getState());
  const [submitting, setSubmitting] = createSignal(false);
  const [palette, setPalette] = createSignal<PaletteState | null>(null);
  onCleanup(props.controller.subscribe(setState));
  useSpinnerClock();

  let scrollRef: ScrollBoxRenderable | undefined;
  let inputRef: InputRenderable | undefined;

  const live = () => currentTurn(state());
  const completed = () => state().completedTurns;
  const hasContent = () => completed().length > 0 || live() !== null;

  const filteredCommands = () => {
    const input = state().input;
    if (!input.startsWith("/")) return [...SLASH_COMMANDS];
    const filter = input.slice(1).toLowerCase();
    if (!filter) return [...SLASH_COMMANDS];
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(filter));
  };

  const closePalette = () => {
    setPalette(null);
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
  };

  const handlePaletteSelect = () => {
    const p = palette();
    if (!p) return;

    if (p.phase === "commands") {
      const cmds = filteredCommands();
      const cmd = cmds[p.index];
      if (!cmd) return;

      const name = cmd.name as CommandName;

      if (name === "model") {
        const currentIdx = KNOWN_MAIN_MODELS.indexOf(state().meta.model);
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        setPalette({ phase: "model", index: Math.max(0, currentIdx) });
        return;
      }

      if (name === "mode") {
        const currentMode = coerceApprovalMode(state().meta.approval) ?? "normal";
        const currentIdx = APPROVAL_MODES.indexOf(currentMode);
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        setPalette({ phase: "mode", index: Math.max(0, currentIdx) });
        return;
      }

      if (name === "sessions") {
        const sessions = props.onListSessions();
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        if (sessions.length === 0) {
          closePalette();
          props.controller.setStatusHint("No sessions found.");
          return;
        }
        setPalette({ phase: "sessions", index: 0, sessions });
        return;
      }

      closePalette();

      if (name === "clear") {
        props.onClear();
        props.controller.clearHistory();
      } else if (name === "new") {
        props.onNew();
      } else if (name === "exit") {
        props.onExit();
      } else if (name === "help") {
        props.controller.setStatusHint(
          SLASH_COMMANDS.map((c) => `${c.label}: ${c.description}`).join("  ·  "),
        );
      }
      return;
    }

    if (p.phase === "model") {
      const model = KNOWN_MAIN_MODELS[p.index];
      if (model) {
        setPalette(null);
        props.onSetModel(model);
        props.controller.setStatusHint(`model → ${model}`);
      }
      return;
    }

    if (p.phase === "mode") {
      const mode = APPROVAL_MODES[p.index];
      if (mode) {
        setPalette(null);
        props.onSetMode(mode);
        props.controller.setStatusHint(`mode → ${APPROVAL_MODE_LABELS[mode]}`);
      }
      return;
    }

    if (p.phase === "sessions") {
      const session = p.sessions[p.index];
      if (session) {
        setPalette(null);
        props.onResume(session.sessionId);
      }
    }
  };

  const handleSubmit = async (raw: string) => {
    // If palette is open, Enter selects the current item instead of submitting.
    if (palette() !== null) {
      handlePaletteSelect();
      return;
    }

    const text = raw.trim();
    if (inputRef) inputRef.value = "";
    if (!text) return;

    // Exit must work even while a turn is running.
    if (text === "/exit" || text === "/quit") {
      props.onExit();
      return;
    }

    // Anything else is rejected while the agent is busy.
    if (submitting() || state().phase !== "input") return;

    if (text.startsWith("/")) {
      const meta = state().meta;
      const result = processCommand(text, {
        currentModel: meta.model,
        currentMode: coerceApprovalMode(meta.approval) ?? "normal",
        currentSandbox: props.getSandbox(),
        knownModels: KNOWN_MAIN_MODELS,
      });

      props.controller.clearInput();
      switch (result.type) {
        case "exit":
          props.onExit();
          return;
        case "clear":
          props.onClear();
          props.controller.clearHistory();
          return;
        case "new":
          props.onNew();
          return;
        case "sessions": {
          const sessions = props.onListSessions();
          if (sessions.length === 0) {
            props.controller.setStatusHint("No sessions found.");
            return;
          }
          setPalette({ phase: "sessions", index: 0, sessions });
          return;
        }
        case "set-model":
          props.onSetModel(result.model);
          props.controller.setStatusHint(result.message);
          return;
        case "set-mode":
          props.onSetMode(result.mode);
          props.controller.setStatusHint(result.message);
          return;
        case "set-sandbox": {
          const set = props.onSetSandbox(result.kind);
          if (set instanceof Promise) {
            void set.then(() => props.controller.setStatusHint(result.message));
          } else {
            props.controller.setStatusHint(result.message);
          }
          return;
        }
        case "info":
        case "error":
          props.controller.setStatusHint(result.message);
          return;
        case "not-command":
          break; // fall through to run as a normal turn
      }
    }

    props.controller.clearInput();
    setSubmitting(true);
    try {
      await props.onSubmit(text);
    } finally {
      setSubmitting(false);
    }
  };

  const handleInput = (value: string) => {
    props.controller.setInput(value);
    const p = palette();

    if (value.startsWith("/")) {
      if (p === null) {
        setPalette({ phase: "commands", index: 0 });
      } else if (p.phase === "commands") {
        // Re-clamp index after filter change
        const cmds = SLASH_COMMANDS.filter((c) => {
          const filter = value.slice(1).toLowerCase();
          return !filter || c.name.startsWith(filter);
        });
        const clamped = Math.min(p.index, Math.max(0, cmds.length - 1));
        if (clamped !== p.index) setPalette({ phase: "commands", index: clamped });
      }
    } else if (p?.phase === "commands") {
      setPalette(null);
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

    const p = palette();
    if (p !== null) {
      if (key.name === "up") {
        setPalette({ ...p, index: Math.max(0, p.index - 1) });
        return;
      }
      if (key.name === "down") {
        const maxIdx =
          p.phase === "commands"
            ? Math.max(0, filteredCommands().length - 1)
            : p.phase === "model"
              ? KNOWN_MAIN_MODELS.length - 1
              : p.phase === "sessions"
                ? Math.max(0, p.sessions.length - 1)
                : APPROVAL_MODES.length - 1;
        setPalette({ ...p, index: Math.min(maxIdx, p.index + 1) });
        return;
      }
      if (key.name === "escape") {
        if (p.phase === "model" || p.phase === "mode" || p.phase === "sessions") {
          // Go back to command list
          setPalette({ phase: "commands", index: 0 });
        } else {
          closePalette();
        }
        return;
      }
      // Swallow all other special keys when palette is open so they don't scroll.
      if (key.name !== undefined) return;
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
        <Header
          model={state().meta.model}
          approval={state().meta.approval}
          cwd={state().meta.cwd}
          sandbox={state().meta.sandbox}
        />
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
        {(pending) => (
          <box flexShrink={0}>
            <ApprovalBar name={pending().name} args={pending().args} />
          </box>
        )}
      </Show>

      <box flexShrink={0} flexDirection="column" marginTop={1} paddingTop={1} border={["top"]} borderColor={theme.border}>
        <Show when={palette()}>
          {(p) => (
            <box
              flexShrink={0}
              flexDirection="column"
              marginBottom={1}
              paddingLeft={1}
              paddingRight={1}
              paddingTop={0}
              paddingBottom={0}
              borderStyle="rounded"
              border
              borderColor={theme.border}
              backgroundColor={theme.codeBg}
            >
              <Show when={p().phase === "commands"}>
                <For each={filteredCommands()}>
                  {(cmd, i) => {
                    const selected = () => (p() as { phase: "commands"; index: number }).index === i();
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{cmd.label}
                        </text>
                        <text fg={theme.secondary}>  {cmd.description}</text>
                      </box>
                    );
                  }}
                </For>
              </Show>

              <Show when={p().phase === "model"}>
                <For each={KNOWN_MAIN_MODELS}>
                  {(model, i) => {
                    const selected = () => (p() as { phase: "model"; index: number }).index === i();
                    const isCurrent = () => model === state().meta.model;
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{model}
                        </text>
                        <Show when={isCurrent()}>
                          <text fg={theme.secondary}>  (current)</text>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </Show>

              <Show when={p().phase === "mode"}>
                <For each={APPROVAL_MODES}>
                  {(mode, i) => {
                    const selected = () => (p() as { phase: "mode"; index: number }).index === i();
                    const isCurrent = () => mode === (coerceApprovalMode(state().meta.approval) ?? "normal");
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{APPROVAL_MODE_LABELS[mode]}
                        </text>
                        <Show when={isCurrent()}>
                          <text fg={theme.secondary}>  (current)</text>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </Show>

              <Show when={p().phase === "sessions"}>
                <For each={(p() as { phase: "sessions"; index: number; sessions: SessionSummary[] }).sessions}>
                  {(session, i) => {
                    const selected = () => (p() as { phase: "sessions"; index: number; sessions: SessionSummary[] }).index === i();
                    const date = formatSessionDate(session.lastTs || session.createdAt);
                    const turns = `${session.turns} turn${session.turns !== 1 ? "s" : ""}`;
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{date}  {session.sessionId}
                        </text>
                        <text fg={theme.secondary}>  {turns}  {session.cwd}</text>
                      </box>
                    );
                  }}
                </For>
              </Show>

              <box marginTop={1}>
                <text fg={theme.secondary}>
                  {p().phase === "commands"
                    ? "↑↓ navigate · Enter select · Esc close"
                    : "↑↓ navigate · Enter select · Esc back"}
                </text>
              </box>
            </box>
          )}
        </Show>

        <box flexDirection="row">
          <text fg={theme.accent} attributes={BOLD}>› </text>
          <input
            ref={inputRef}
            flexGrow={1}
            focused={state().phase !== "approval"}
            textColor={theme.fg}
            focusedTextColor={theme.fg}
            backgroundColor={theme.bg}
            focusedBackgroundColor={theme.bg}
            onInput={handleInput}
            onSubmit={() => void handleSubmit(inputRef?.value ?? "")}
          />
        </box>
        <text fg={theme.secondary}>{state().statusHint}</text>
      </box>
    </box>
  );
}
