import type { AgentEvent } from "../agent/events.js";
import type { SessionCostSnapshot } from "../telemetry/events.js";
import type { SandboxKind } from "../workspace/types.js";
import type { TodoItem } from "../todos/types.js";
import { todowriteSchema } from "../tools/todowrite.js";
import { clipboardHintText } from "./shortcuts.js";

export type ToolStatus = "running" | "done" | "error";
export type SessionPhase = "input" | "running" | "approval";

/** Nested tools run inside a parent `task` subagent loop. */
export interface SubagentContext {
  id: string;
  agent: string;
  description: string;
  active: boolean;
  tools: ToolEntry[];
}

export interface ToolEntry {
  id: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  output?: string;
  subagent?: SubagentContext;
}

export interface PendingApproval {
  name: string;
  args: unknown;
}

export interface Turn {
  userText: string;
  assistantText: string;
  reasoningText?: string;
  tools: ToolEntry[];
}

export interface SessionMeta {
  model: string;
  approval: string;
  cwd: string;
  provider?: string;
  sandbox?: SandboxKind;
  faux?: boolean;
  /** False when the active LLM provider has no API key yet. */
  providerConfigured?: boolean;
  /** Running session cost in USD; `null` when no priced call has landed yet. */
  costUsd?: number | null;
  /** Total tokens across the session — shown in the header when pricing is unknown. */
  tokenTotals?: number;
  /** Input-side tokens of the latest main-loop turn — how full the context window is. */
  contextTokens?: number;
  /** Context window of the active model, in tokens; resolved per model/provider. */
  contextWindow?: number;
}

export interface SessionState {
  meta: SessionMeta;
  completedTurns: Turn[];
  currentUserText: string;
  streamingText: string;
  streamingReasoning: string;
  currentTools: ToolEntry[];
  todos: TodoItem[];
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
  /** Deny a pending approval gate, if any — used when stopping a turn. */
  rejectPendingApproval: () => void;
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
  setTodos: (todos: TodoItem[]) => void;
  updateMeta: (patch: Partial<SessionMeta>) => void;
  /** Fold a telemetry snapshot into the header meta (running cost + token total). */
  setSessionCost: (
    snapshot: Pick<SessionCostSnapshot, "costUsd" | "tokens" | "contextTokens">,
  ) => void;
}

const IDLE_HINT = `scroll · ${clipboardHintText()} · Ctrl+C exit`;
const RUNNING_HINT = "Working… · Ctrl+C stop";

const TOOL_VERBS: Record<string, string> = {
  read: "Reading",
  write: "Writing",
  edit: "Editing",
  bash: "Running",
  grep: "Searching",
  find: "Finding",
  ls: "Listing",
  delegate_read: "Delegating read of",
  task: "Subagent",
  todowrite: "Updating tasks",
};

function todosFromToolArgs(args: unknown): TodoItem[] | undefined {
  const parsed = todowriteSchema.safeParse(args);
  return parsed.success ? parsed.data.todos : undefined;
}

/** Build a descriptive status hint for a running tool, e.g. "Reading src/foo.ts…". */
function toolStatusHint(name: string, args: unknown, subagentAgent?: string): string {
  const verb = TOOL_VERBS[name] ?? `Running ${name}`;
  let detail = "";
  if (args && typeof args === "object") {
    const r = args as Record<string, unknown>;
    for (const key of ["path", "command", "pattern", "task", "description"] as const) {
      if (typeof r[key] === "string") {
        detail = r[key] as string;
        break;
      }
    }
  }
  if (detail.length > 48) detail = `${detail.slice(0, 45)}…`;
  const action = detail ? `${verb} ${detail}…` : `${verb}…`;
  return subagentAgent ? `Subagent (${subagentAgent}): ${action}` : action;
}

function findSubagentAgent(tools: ToolEntry[], subagentId: string): string | undefined {
  for (const tool of tools) {
    if (tool.subagent?.id === subagentId) return tool.subagent.agent;
  }
  return undefined;
}

function attachSubagentToRunningTask(
  tools: ToolEntry[],
  subagent: Omit<SubagentContext, "tools">,
): ToolEntry[] {
  let attached = false;
  return tools.map((tool) => {
    if (attached || tool.name !== "task" || tool.status !== "running" || tool.subagent) {
      return tool;
    }
    attached = true;
    return {
      ...tool,
      subagent: { ...subagent, tools: [] },
    };
  });
}

function upsertSubagentTool(
  tools: ToolEntry[],
  subagentId: string,
  toolId: string,
  patch: Partial<ToolEntry> & Pick<ToolEntry, "name" | "args">,
): ToolEntry[] {
  return tools.map((tool) => {
    if (tool.subagent?.id !== subagentId) return tool;
    const subTools = [...tool.subagent.tools];
    const idx = subTools.findIndex((t) => t.id === toolId);
    if (idx === -1) {
      subTools.push({
        id: toolId,
        name: patch.name,
        args: patch.args,
        status: patch.status ?? "running",
        output: patch.output,
      });
    } else {
      subTools[idx] = { ...subTools[idx]!, ...patch };
    }
    return { ...tool, subagent: { ...tool.subagent, tools: subTools } };
  });
}

function finalizeSubagent(tools: ToolEntry[], subagentId: string): ToolEntry[] {
  return tools.map((tool) => {
    if (tool.subagent?.id !== subagentId) return tool;
    return { ...tool, subagent: { ...tool.subagent, active: false } };
  });
}

export function createSessionController(meta: SessionMeta): SessionController {
  let state: SessionState = {
    meta,
    completedTurns: [],
    currentUserText: "",
    streamingText: "",
    streamingReasoning: "",
    currentTools: [],
    todos: [],
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
        streamingReasoning: "",
        currentTools: [],
        phase: "running",
        statusHint: RUNNING_HINT,
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
            reasoningText: state.streamingReasoning || undefined,
            tools: state.currentTools,
          },
        ],
        currentUserText: "",
        streamingText: "",
        streamingReasoning: "",
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
        streamingReasoning: "",
        currentTools: [],
        todos: [],
        phase: "input",
        statusHint: IDLE_HINT,
      });
    },

    loadHistory(turns) {
      update({
        completedTurns: turns,
        currentUserText: "",
        streamingText: "",
        streamingReasoning: "",
        currentTools: [],
        phase: "input",
        statusHint: IDLE_HINT,
      });
    },

    setTodos(todos) {
      update({ todos });
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

    setSessionCost(snapshot) {
      update({
        meta: {
          ...state.meta,
          costUsd: snapshot.costUsd,
          tokenTotals: snapshot.tokens.totalTokens,
          contextTokens: snapshot.contextTokens,
        },
      });
    },

    handleEvent(event) {
      switch (event.type) {
        case "text_delta":
          update({ streamingText: state.streamingText + event.text });
          break;
        case "reasoning_delta":
          update({ streamingReasoning: state.streamingReasoning + event.text });
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
        case "tool_start": {
          if (event.subagentId) {
            const agent = findSubagentAgent(state.currentTools, event.subagentId);
            update({
              currentTools: upsertSubagentTool(state.currentTools, event.subagentId, event.id, {
                name: event.name,
                args: event.args,
                status: "running",
              }),
              pendingApproval: null,
              phase: "running",
              statusHint: toolStatusHint(event.name, event.args, agent),
            });
            break;
          }
          upsertTool(event.id, {
            name: event.name,
            args: event.args,
            status: "running",
          });
          const previewTodos =
            event.name === "todowrite" ? todosFromToolArgs(event.args) : undefined;
          update({
            pendingApproval: null,
            phase: "running",
            statusHint: toolStatusHint(event.name, event.args),
            ...(previewTodos ? { todos: previewTodos } : {}),
          });
          break;
        }
        case "tool_end":
          if (event.subagentId) {
            update({
              currentTools: upsertSubagentTool(state.currentTools, event.subagentId, event.id, {
                name: event.name,
                args: state.currentTools
                  .flatMap((t) => t.subagent?.tools ?? [])
                  .find((t) => t.id === event.id)?.args ?? {},
                status: event.isError ? "error" : "done",
                output: event.output,
              }),
            });
            break;
          }
          upsertTool(event.id, {
            name: event.name,
            args: state.currentTools.find((t) => t.id === event.id)?.args ?? {},
            status: event.isError ? "error" : "done",
            output: event.output,
          });
          break;
        case "todo_update":
          update({ todos: event.todos });
          break;
        case "subagent_start":
          update({
            currentTools: attachSubagentToRunningTask(state.currentTools, {
              id: event.id,
              agent: event.agent,
              description: event.description,
              active: true,
            }),
            statusHint: `Subagent (${event.agent}): ${event.description}…`,
          });
          break;
        case "subagent_end":
          update({
            currentTools: finalizeSubagent(state.currentTools, event.id),
            statusHint: `Subagent (${event.agent}) finished — ${event.turns} turn${event.turns === 1 ? "" : "s"}`,
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
        statusHint: RUNNING_HINT,
      });
    },

    rejectPendingApproval() {
      if (state.phase !== "approval" || !approvalResolver) return;
      approvalResolver(false);
      approvalResolver = null;
      update({
        pendingApproval: null,
        phase: "running",
        statusHint: RUNNING_HINT,
      });
    },
  };
}
