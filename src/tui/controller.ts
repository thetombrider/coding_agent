import type { AgentEvent } from "../agent/events.js";

export type ToolStatus = "running" | "done" | "error";

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

export interface TuiState {
  assistantText: string;
  tools: ToolEntry[];
  pendingApproval: PendingApproval | null;
  loopDone: boolean;
  loopReason?: "complete" | "terminate" | "error";
  statusLine: string;
}

export type TuiListener = (state: TuiState) => void;

export interface TuiController {
  handleEvent: (event: AgentEvent) => void;
  requestApproval: (name: string, args: unknown) => Promise<boolean>;
  respondApproval: (approved: boolean) => void;
  subscribe: (listener: TuiListener) => () => void;
  getState: () => TuiState;
}

export function createTuiController(statusLine: string): TuiController {
  let state: TuiState = {
    assistantText: "",
    tools: [],
    pendingApproval: null,
    loopDone: false,
    statusLine,
  };

  const listeners = new Set<TuiListener>();
  let approvalResolver: ((approved: boolean) => void) | null = null;

  const notify = () => {
    for (const listener of listeners) listener(state);
  };

  const update = (patch: Partial<TuiState>) => {
    state = { ...state, ...patch };
    notify();
  };

  const upsertTool = (id: string, patch: Partial<ToolEntry> & Pick<ToolEntry, "name" | "args">) => {
    const idx = state.tools.findIndex((t) => t.id === id);
    if (idx === -1) {
      update({
        tools: [
          ...state.tools,
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

    const next = [...state.tools];
    next[idx] = { ...next[idx]!, ...patch };
    update({ tools: next });
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },

    handleEvent(event) {
      switch (event.type) {
        case "text_delta":
          update({ assistantText: state.assistantText + event.text });
          break;
        case "assistant_message":
          update({
            assistantText: event.message.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join(""),
          });
          break;
        case "approval_required":
          update({
            pendingApproval: { name: event.name, args: event.args },
          });
          break;
        case "tool_start":
          upsertTool(event.id, {
            name: event.name,
            args: event.args,
            status: "running",
          });
          update({ pendingApproval: null });
          break;
        case "tool_end":
          upsertTool(event.id, {
            name: event.name,
            args: (state.tools.find((t) => t.id === event.id)?.args) ?? {},
            status: event.isError ? "error" : "done",
            output: event.output,
          });
          break;
        case "loop_end":
          update({ loopDone: true, loopReason: event.reason });
          break;
      }
    },

    requestApproval(name, args) {
      return new Promise<boolean>((resolve) => {
        approvalResolver = resolve;
        update({ pendingApproval: { name, args } });
      });
    },

    respondApproval(approved) {
      approvalResolver?.(approved);
      approvalResolver = null;
      update({ pendingApproval: null });
    },
  };
}
