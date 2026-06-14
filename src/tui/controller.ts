import type { AgentEvent } from "../agent/events.js";

export type ToolStatus = "running" | "done" | "error";
export type SessionPhase = "input" | "running" | "approval";

export interface ToolEntry {
  id: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  output?: string;
}

export interface PendingApproval {
  name: string;
  args: unknown;
}

export interface Turn {
  userText: string;
  assistantText: string;
  tools: ToolEntry[];
}

export interface SessionMeta {
  model: string;
  approval: string;
  cwd: string;
  faux?: boolean;
}

export interface SessionState {
  meta: SessionMeta;
  completedTurns: Turn[];
  currentUserText: string;
  streamingText: string;
  currentTools: ToolEntry[];
  phase: SessionPhase;
  pendingApproval: PendingApproval | null;
  input: string;
  statusHint: string;
  /** Top line of the message viewport when not following tail. */
  scrollAnchorLine: number | null;
  followTail: boolean;
}

export interface ScrollLayout {
  totalLines: number;
  viewportLines: number;
}

export type SessionListener = (state: SessionState) => void;

export interface SessionController {
  handleEvent: (event: AgentEvent) => void;
  requestApproval: (name: string, args: unknown) => Promise<boolean>;
  respondApproval: (approved: boolean) => void;
  subscribe: (listener: SessionListener) => () => void;
  getState: () => SessionState;
  beginTurn: (userText: string) => void;
  finalizeTurn: () => void;
  setInput: (value: string) => void;
  appendInput: (char: string) => void;
  backspaceInput: () => void;
  clearInput: () => void;
  setStatusHint: (hint: string) => void;
  clearHistory: () => void;
  scrollUpLines: (layout: ScrollLayout, count?: number) => void;
  scrollDownLines: (layout: ScrollLayout, count?: number) => void;
  scrollToBottom: () => void;
}

export function createSessionController(meta: SessionMeta): SessionController {
  let state: SessionState = {
    meta,
    completedTurns: [],
    currentUserText: "",
    streamingText: "",
    currentTools: [],
    phase: "input",
    pendingApproval: null,
    input: "",
    statusHint: "↑↓ scroll · trackpad scrolls here · End latest · /exit to quit",
    scrollAnchorLine: null,
    followTail: true,
  };

  const listeners = new Set<SessionListener>();
  let approvalResolver: ((approved: boolean) => void) | null = null;

  const notify = () => {
    for (const listener of listeners) listener(state);
  };

  const update = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    notify();
  };

  const upsertTool = (id: string, patch: Partial<ToolEntry> & Pick<ToolEntry, "name" | "args">) => {
    const idx = state.currentTools.findIndex((t) => t.id === id);
    if (idx === -1) {
      update({
        currentTools: [
          ...state.currentTools,
          {
            id,
            name: patch.name,
            args: patch.args,
            status: patch.status ?? "running",
            output: patch.output,
          },
        ],
      });
      return;
    }

    const next = [...state.currentTools];
    next[idx] = { ...next[idx]!, ...patch };
    update({ currentTools: next });
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },

    beginTurn(userText) {
      update({
        currentUserText: userText,
        streamingText: "",
        currentTools: [],
        phase: "running",
        statusHint: "Working…",
        scrollAnchorLine: null,
        followTail: true,
      });
    },

    finalizeTurn() {
      if (!state.currentUserText) return;
      update({
        completedTurns: [
          ...state.completedTurns,
          {
            userText: state.currentUserText,
            assistantText: state.streamingText,
            tools: state.currentTools,
          },
        ],
        currentUserText: "",
        streamingText: "",
        currentTools: [],
        phase: "input",
        statusHint: defaultHint(state.scrollAnchorLine),
        scrollAnchorLine: null,
        followTail: true,
      });
    },

    clearHistory() {
      update({
        completedTurns: [],
        currentUserText: "",
        streamingText: "",
        currentTools: [],
        phase: "input",
        statusHint: defaultHint(null),
        scrollAnchorLine: null,
        followTail: true,
      });
    },

    setInput(value) {
      update({ input: value });
    },

    appendInput(char) {
      update({ input: state.input + char });
    },

    backspaceInput() {
      update({ input: state.input.slice(0, -1) });
    },

    clearInput() {
      update({ input: "" });
    },

    setStatusHint(hint) {
      update({ statusHint: hint });
    },

    handleEvent(event) {
      const tailPatch = state.followTail ? { scrollAnchorLine: null } : {};
      switch (event.type) {
        case "text_delta":
          update({ streamingText: state.streamingText + event.text, ...tailPatch });
          break;
        case "assistant_message":
          update({
            streamingText: event.message.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join(""),
            ...tailPatch,
          });
          break;
        case "approval_required":
          update({
            phase: "approval",
            pendingApproval: { name: event.name, args: event.args },
            statusHint: `Approve ${event.name}?  y / n`,
          });
          break;
        case "tool_start":
          upsertTool(event.id, {
            name: event.name,
            args: event.args,
            status: "running",
          });
          update({
            pendingApproval: null,
            phase: "running",
            statusHint: "Working…",
            ...tailPatch,
          });
          break;
        case "tool_end":
          upsertTool(event.id, {
            name: event.name,
            args: state.currentTools.find((t) => t.id === event.id)?.args ?? {},
            status: event.isError ? "error" : "done",
            output: event.output,
          });
          if (state.followTail) update({ scrollAnchorLine: null });
          break;
        case "loop_end":
          break;
      }
    },

    requestApproval(name, args) {
      return new Promise<boolean>((resolve) => {
        approvalResolver = resolve;
        update({
          phase: "approval",
          pendingApproval: { name, args },
          statusHint: `Approve ${name}?  y / n`,
        });
      });
    },

    respondApproval(approved) {
      approvalResolver?.(approved);
      approvalResolver = null;
      update({
        pendingApproval: null,
        phase: "running",
        statusHint: "Working…",
      });
    },

    scrollUpLines(layout, count = 3) {
      const start = scrollStart(state, layout);
      const next = Math.max(0, start - count);
      update({
        followTail: false,
        scrollAnchorLine: next,
        statusHint: scrollHint(next, layout.totalLines, layout.viewportLines),
      });
    },

    scrollDownLines(layout, count = 3) {
      const start = scrollStart(state, layout);
      const maxStart = Math.max(0, layout.totalLines - layout.viewportLines);
      const next = Math.min(maxStart, start + count);
      const atBottom = next >= maxStart;
      update({
        scrollAnchorLine: atBottom ? null : next,
        followTail: atBottom,
        statusHint: atBottom ? defaultHint(null) : scrollHint(next, layout.totalLines, layout.viewportLines),
      });
    },

    scrollToBottom() {
      update({
        scrollAnchorLine: null,
        followTail: true,
        statusHint: defaultHint(null),
      });
    },
  };
}

function scrollStart(
  state: SessionState,
  layout: ScrollLayout,
): number {
  const maxStart = Math.max(0, layout.totalLines - layout.viewportLines);
  if (state.followTail) return maxStart;
  return Math.min(Math.max(0, state.scrollAnchorLine ?? 0), maxStart);
}

function defaultHint(_anchor: number | null): string {
  return "↑↓ scroll · trackpad scrolls here · End latest · /exit to quit";
}

function scrollHint(anchorLine: number, totalLines: number, viewportLines: number): string {
  const maxStart = Math.max(0, totalLines - viewportLines);
  if (anchorLine <= 0 || anchorLine >= maxStart) return defaultHint(anchorLine);
  const pct = maxStart > 0 ? Math.round((anchorLine / maxStart) * 100) : 0;
  return `${pct}% up · End latest · /exit to quit`;
}
