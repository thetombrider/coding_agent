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
  loadHistory: (turns: Turn[]) => void;
  updateMeta: (patch: Partial<SessionMeta>) => void;
}

const IDLE_HINT = "scroll wheel / PgUp · End jumps to latest · /exit to quit";

const TOOL_VERBS: Record<string, string> = {
  read: "Reading",
  write: "Writing",
  edit: "Editing",
  bash: "Running",
  grep: "Searching",
  find: "Finding",
  ls: "Listing",
  delegate_read: "Delegating read of",
};

/** Build a descriptive status hint for a running tool, e.g. "Reading src/foo.ts…". */
function toolStatusHint(name: string, args: unknown): string {
  const verb = TOOL_VERBS[name] ?? `Running ${name}`;
  let detail = "";
  if (args && typeof args === "object") {
    const r = args as Record<string, unknown>;
    for (const key of ["path", "command", "pattern", "task"] as const) {
      if (typeof r[key] === "string") {
        detail = r[key] as string;
        break;
      }
    }
  }
  if (detail.length > 48) detail = `${detail.slice(0, 45)}…`;
  return detail ? `${verb} ${detail}…` : `${verb}…`;
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
    statusHint: IDLE_HINT,
  };

  const listeners = new Set<SessionListener>();
  let approvalResolver: ((approved: boolean) => void) | null = null;

  // Defer listener calls so Solid (and other UI runtimes) never receive
  // synchronous writes while they are mid-render — that triggers
  // "depends on itself in the same turn" errors on finalizeTurn etc.
  let notifyPending = false;
  const notify = () => {
    if (notifyPending) return;
    notifyPending = true;
    queueMicrotask(() => {
      notifyPending = false;
      for (const listener of listeners) listener(state);
    });
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
        statusHint: IDLE_HINT,
      });
    },

    clearHistory() {
      update({
        completedTurns: [],
        currentUserText: "",
        streamingText: "",
        currentTools: [],
        phase: "input",
        statusHint: IDLE_HINT,
      });
    },

    loadHistory(turns) {
      update({
        completedTurns: turns,
        currentUserText: "",
        streamingText: "",
        currentTools: [],
        phase: "input",
        statusHint: IDLE_HINT,
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

    updateMeta(patch) {
      update({ meta: { ...state.meta, ...patch } });
    },

    handleEvent(event) {
      switch (event.type) {
        case "text_delta":
          update({ streamingText: state.streamingText + event.text });
          break;
        case "assistant_message":
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
            statusHint: toolStatusHint(event.name, event.args),
          });
          break;
        case "tool_end":
          upsertTool(event.id, {
            name: event.name,
            args: state.currentTools.find((t) => t.id === event.id)?.args ?? {},
            status: event.isError ? "error" : "done",
            output: event.output,
          });
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
  };
}
