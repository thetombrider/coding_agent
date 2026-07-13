import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../agent/events.js";
import type { SessionCostSnapshot } from "../telemetry/events.js";
import type { SandboxKind } from "../workspace/types.js";
import type { TodoItem } from "../todos/types.js";
import { formatMcpToolLabel, isMcpTool } from "../mcp/names.js";
import { todowriteSchema } from "../tools/todowrite.js";
import { clipboardHintText } from "./shortcuts.js";

export type ToolStatus = "running" | "done" | "error";
export type SessionPhase = "input" | "running" | "approval" | "question";

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

/** A question the agent asked the user, awaiting a choice via `askuser`. */
export interface PendingQuestion {
  /** Unique per `requestQuestion` call — lets the UI reset per-question state
   *  (e.g. the highlighted option) even if two consecutive questions share
   *  identical text. */
  id: string;
  question: string;
  options: string[];
}

export type TurnBlock =
  | { type: "reasoning"; id: string; text: string }
  | { type: "tool"; entry: ToolEntry };

export interface Turn {
  userText: string;
  assistantText: string;
  reasoningText?: string;
  tools: ToolEntry[];
  blocks: TurnBlock[];
}

export interface SessionMeta {
  model: string;
  approval: string;
  cwd: string;
  /** Host repo root when running in a session worktree. */
  hostCwd?: string;
  /** Session branch when `sessionIsolation` is `worktree`. */
  branch?: string;
  /** Whole-session parent-loop isolation. */
  sessionIsolation?: import("../agent/session-isolation.js").SessionIsolationMode;
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
  /** Ordered reasoning segments, each tied to an LLM call boundary. */
  streamingReasoningSegments: Array<{ id: string; text: string }>;
  /** Interleaved reasoning + tool blocks in display order. */
  currentBlocks: TurnBlock[];
  todos: TodoItem[];
  phase: SessionPhase;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
  input: string;
  statusHint: string;
  /** `Date.now()` when the current turn started; `null` when idle. Drives the footer's live elapsed-time readout. */
  turnStartedAt: number | null;
  /** Skills loaded via skill_use during this session. */
  activeSkills: Array<{ name: string; version?: string }>;
}

export type SessionListener = (state: SessionState) => void;

export interface SessionController {
  handleEvent: (event: AgentEvent) => void;
  requestApproval: (name: string, args: unknown) => Promise<boolean>;
  respondApproval: (approved: boolean) => void;
  /** Deny a pending approval gate, if any — used when stopping a turn. */
  rejectPendingApproval: () => void;
  /** Ask the user a multiple-choice question and await their answer (`askuser`). */
  requestQuestion: (question: string, options: string[]) => Promise<string | null>;
  /** Resolve a pending question with the user's chosen option or free-text reply. */
  respondQuestion: (answer: string) => void;
  /** Dismiss a pending question without an answer — used when stopping a turn. */
  rejectPendingQuestion: () => void;
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

export const IDLE_STATUS_HINT = `scroll · ${clipboardHintText()} · Ctrl+C exit`;
const RUNNING_HINT = "Working… · Ctrl+C stop";

const TOOL_VERBS: Record<string, string> = {
  read: "Reading",
  write: "Writing",
  edit: "Editing",
  bash: "Running",
  bash_status: "Checking",
  bash_kill: "Stopping",
  grep: "Searching",
  find: "Finding",
  ls: "Listing",
  delegate_read: "Delegating read of",
  task: "Subagent",
  todowrite: "Updating tasks",
  skill_list: "Listing skills",
  skill_use: "Loading skill",
  skill_write: "Writing skill",
};

function todosFromToolArgs(args: unknown): TodoItem[] | undefined {
  const parsed = todowriteSchema.safeParse(args);
  return parsed.success ? parsed.data.todos : undefined;
}

/** Build a descriptive status hint for a running tool, e.g. "Reading src/foo.ts…". */
function toolStatusHint(name: string, args: unknown, subagentAgent?: string): string {
  const displayName = isMcpTool(name) ? formatMcpToolLabel(name) : name;
  const verb = TOOL_VERBS[name] ?? `Running ${displayName}`;
  let detail = "";
  if (args && typeof args === "object") {
    const r = args as Record<string, unknown>;
    for (const key of ["path", "command", "pattern", "task", "description", "job_id"] as const) {
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

function formatProgressChars(chars: number): string {
  return chars < 1024 ? `${chars} chars` : `${(chars / 1024).toFixed(1)} KB`;
}

/** Live status hint while a tool call's arguments are still streaming in, e.g. "Writing… (2.1 KB so far)". */
function toolInputProgressHint(name: string, chars: number, subagentAgent?: string): string {
  const displayName = isMcpTool(name) ? formatMcpToolLabel(name) : name;
  const verb = TOOL_VERBS[name] ?? `Running ${displayName}`;
  const action = chars > 0 ? `${verb}… (${formatProgressChars(chars)} so far)` : `${verb}…`;
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

/** Copy nested subagent state from `tools` into matching tool block entries. */
function syncBlocksWithTools(blocks: TurnBlock[], tools: ToolEntry[]): TurnBlock[] {
  const toolById = new Map(tools.map((t) => [t.id, t]));
  return blocks.map((block) => {
    if (block.type !== "tool") return block;
    const source = toolById.get(block.entry.id);
    return source ? { ...block, entry: source } : block;
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
    streamingReasoningSegments: [],
    currentBlocks: [],
    todos: [],
    phase: "input",
    pendingApproval: null,
    pendingQuestion: null,
    input: "",
    statusHint: IDLE_STATUS_HINT,
    turnStartedAt: null,
    activeSkills: [],
  };

  const listeners = new Set<SessionListener>();
  let approvalResolver: ((approved: boolean) => void) | null = null;
  // Tool calls within one turn run concurrently (see executeToolsParallel), so
  // more than one `askuser` call can be in flight at once. A single resolver
  // slot would let a second call's requestQuestion clobber the first's before
  // it resolves, orphaning that promise forever and hanging the turn. Queue
  // them instead and show one at a time.
  const questionQueue: Array<{
    id: string;
    question: string;
    options: string[];
    resolve: (answer: string | null) => void;
  }> = [];

  // Defer listener calls so Solid (and other UI runtimes) never receive
  // synchronous writes while they are mid-render — that triggers
  // "depends on itself in the same turn" errors on finalizeTurn etc.
  let notifyPending = false;
  // Pending timer for throttled streaming notifications.
  let streamingTimer: ReturnType<typeof setTimeout> | null = null;

  const flushListeners = () => {
    for (const listener of listeners) listener(state);
  };

  const notify = () => {
    // An urgent (interactive) render supersedes any pending streaming timer so we
    // don't double-render after the microtask fires.
    if (streamingTimer !== null) {
      clearTimeout(streamingTimer);
      streamingTimer = null;
    }
    if (notifyPending) return;
    notifyPending = true;
    queueMicrotask(() => {
      notifyPending = false;
      flushListeners();
    });
  };

  // High-frequency streaming events (text_delta, reasoning_delta) arrive on every
  // async event-loop turn, so queueMicrotask alone doesn't coalesce them — each
  // schedules its own render and the cumulative element count can exhaust opentui's
  // native TextBufferView pool, causing an uncaught "Failed to create TextBufferView"
  // that kills the process. Throttling to ~16 ms (one frame) collapses many rapid
  // deltas into a single render pass.
  const notifyStreaming = () => {
    if (notifyPending || streamingTimer !== null) return;
    streamingTimer = setTimeout(() => {
      streamingTimer = null;
      flushListeners();
    }, 16);
  };

  const update = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    notify();
  };

  const updateStreaming = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    notifyStreaming();
  };

  const setCurrentTools = (currentTools: ToolEntry[]) => {
    update({
      currentTools,
      currentBlocks: syncBlocksWithTools(state.currentBlocks, currentTools),
    });
  };

  const upsertTool = (id: string, patch: Partial<ToolEntry> & Pick<ToolEntry, "name" | "args">) => {
    const idx = state.currentTools.findIndex((t) => t.id === id);
    if (idx === -1) {
      setCurrentTools([
        ...state.currentTools,
        {
          id,
          name: patch.name,
          args: patch.args,
          status: patch.status ?? "running",
          output: patch.output,
        },
      ]);
      return;
    }

    const next = [...state.currentTools];
    next[idx] = { ...next[idx]!, ...patch };
    setCurrentTools(next);
  };

  /** Show the next queued question, or clear the modal if none remain. */
  const advanceQuestionQueue = () => {
    const next = questionQueue[0];
    if (next) {
      update({
        phase: "question",
        pendingQuestion: { id: next.id, question: next.question, options: next.options },
        statusHint: "↑↓ choose · Enter answer · type a custom reply · Esc skip",
      });
    } else {
      update({
        pendingQuestion: null,
        phase: "running",
        statusHint: RUNNING_HINT,
      });
    }
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
        streamingReasoningSegments: [],
        currentBlocks: [],
        phase: "running",
        statusHint: RUNNING_HINT,
        turnStartedAt: Date.now(),
      });
    },

    finalizeTurn() {
      if (!state.currentUserText) return;
      const allReasoning = state.streamingReasoningSegments
        .map((s) => s.text)
        .join("");
      const blocks = syncBlocksWithTools(
        state.currentBlocks.filter(
          (b) => b.type !== "reasoning" || b.text.length > 0,
        ),
        state.currentTools,
      );
      // Defensive: a turn should only finalize once every askuser call has
      // resolved, but clear any stragglers so a stale entry can't block
      // future questions from ever reaching the front of the queue.
      questionQueue.length = 0;
      update({
        completedTurns: [
          ...state.completedTurns,
          {
            userText: state.currentUserText,
            assistantText: state.streamingText,
            reasoningText: allReasoning || undefined,
            tools: state.currentTools,
            blocks,
          },
        ],
        currentUserText: "",
        streamingText: "",
        streamingReasoning: "",
        currentTools: [],
        streamingReasoningSegments: [],
        currentBlocks: [],
        phase: "input",
        pendingQuestion: null,
        statusHint: IDLE_STATUS_HINT,
        turnStartedAt: null,
      });
    },

    clearHistory() {
      questionQueue.length = 0;
      update({
        completedTurns: [],
        currentUserText: "",
        streamingText: "",
        streamingReasoning: "",
        currentTools: [],
        streamingReasoningSegments: [],
        currentBlocks: [],
        todos: [],
        phase: "input",
        pendingQuestion: null,
        statusHint: IDLE_STATUS_HINT,
        turnStartedAt: null,
      });
    },

    loadHistory(turns) {
      questionQueue.length = 0;
      update({
        completedTurns: turns,
        currentUserText: "",
        streamingText: "",
        streamingReasoning: "",
        currentTools: [],
        streamingReasoningSegments: [],
        currentBlocks: [],
        phase: "input",
        pendingQuestion: null,
        statusHint: IDLE_STATUS_HINT,
        turnStartedAt: null,
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
          if (event.subagentId) break;
          updateStreaming({ streamingText: state.streamingText + event.text });
          break;
        case "tool_input_start":
        case "tool_input_delta": {
          const modalPending = state.pendingQuestion !== null || state.pendingApproval !== null;
          if (modalPending) break;
          const chars = event.type === "tool_input_delta" ? event.chars : 0;
          const agent = event.subagentId
            ? findSubagentAgent(state.currentTools, event.subagentId)
            : undefined;
          updateStreaming({ statusHint: toolInputProgressHint(event.name, chars, agent) });
          break;
        }
        case "llm_start": {
          if (event.subagentId) break;
          const streamingText =
            state.streamingText.length > 0 && !state.streamingText.endsWith("\n")
              ? state.streamingText + "\n"
              : state.streamingText;
          const lastBlock = state.currentBlocks[state.currentBlocks.length - 1];
          if (lastBlock?.type === "reasoning") {
            update({
              streamingText,
              streamingReasoningSegments: state.streamingReasoningSegments.map(
                (s) => (s.id === lastBlock.id ? { ...s, text: s.text + "\n" } : s),
              ),
              currentBlocks: state.currentBlocks.map((b) =>
                b.type === "reasoning" && b.id === lastBlock.id ? { ...b, text: b.text + "\n" } : b,
              ),
            });
            break;
          } else {
            const segId = randomUUID();
            const currentBlocks = state.currentBlocks.filter(
              (b) => b.type !== "reasoning" || b.text.length > 0,
            );
            update({
              streamingText,
              streamingReasoningSegments: [
                ...state.streamingReasoningSegments,
                { id: segId, text: "" },
              ],
              currentBlocks: [
                ...currentBlocks,
                { type: "reasoning" as const, id: segId, text: "" },
              ],
            });
          }
          break;
        }
        case "reasoning_delta": {
          if (event.subagentId) break;
          const segs = state.streamingReasoningSegments;
          if (segs.length === 0) {
            const segId = randomUUID();
            updateStreaming({
              streamingReasoningSegments: [{ id: segId, text: event.text }],
              streamingReasoning: state.streamingReasoning + event.text,
              currentBlocks: [
                ...state.currentBlocks,
                { type: "reasoning" as const, id: segId, text: event.text },
              ],
            });
          } else {
            const updated = [...segs];
            const last = updated[updated.length - 1]!;
            updated[updated.length - 1] = { ...last, text: last.text + event.text };
            updateStreaming({
              streamingReasoningSegments: updated,
              streamingReasoning: state.streamingReasoning + event.text,
              currentBlocks: state.currentBlocks.map((b) =>
                b.type === "reasoning" && b.id === last.id
                  ? { ...b, text: b.text + event.text }
                  : b,
              ),
            });
          }
          break;
        }
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
          const modalPending = state.pendingQuestion !== null || state.pendingApproval !== null;
          if (event.subagentId) {
            const agent = findSubagentAgent(state.currentTools, event.subagentId);
            setCurrentTools(
              upsertSubagentTool(state.currentTools, event.subagentId, event.id, {
                name: event.name,
                args: event.args,
                status: "running",
              }),
            );
            if (!modalPending) {
              update({
                pendingApproval: null,
                phase: "running",
                statusHint: toolStatusHint(event.name, event.args, agent),
              });
            }
            break;
          }
          upsertTool(event.id, {
            name: event.name,
            args: event.args,
            status: "running",
          });
          const previewTodos =
            event.name === "todowrite" ? todosFromToolArgs(event.args) : undefined;
          const patch: Partial<SessionState> = {
            currentBlocks: [
              ...state.currentBlocks,
              {
                type: "tool" as const,
                entry: {
                  id: event.id,
                  name: event.name,
                  args: event.args,
                  status: "running" as const,
                },
              },
            ],
          };
          if (!modalPending) {
            patch.pendingApproval = null;
            patch.phase = "running";
            patch.statusHint = toolStatusHint(event.name, event.args);
          }
          if (previewTodos) patch.todos = previewTodos;
          update(patch);
          break;
        }
        case "tool_end":
          if (event.subagentId) {
            setCurrentTools(
              upsertSubagentTool(state.currentTools, event.subagentId, event.id, {
                name: event.name,
                args: state.currentTools
                  .flatMap((t) => t.subagent?.tools ?? [])
                  .find((t) => t.id === event.id)?.args ?? {},
                status: event.isError ? "error" : "done",
                output: event.output,
              }),
            );
            break;
          }
          upsertTool(event.id, {
            name: event.name,
            args: state.currentTools.find((t) => t.id === event.id)?.args ?? {},
            status: event.isError ? "error" : "done",
            output: event.output,
          });
          if (event.name === "skill_use" && !event.isError) {
            const toolArgs = state.currentTools.find((t) => t.id === event.id)?.args;
            const skillName =
              toolArgs && typeof toolArgs === "object"
                ? (toolArgs as Record<string, unknown>).name
                : undefined;
            if (typeof skillName === "string") {
              update({ activeSkills: [...state.activeSkills, { name: skillName }] });
            }
          }
          break;
        case "todo_update":
          update({ todos: event.todos });
          break;
        case "subagent_start":
          setCurrentTools(
            attachSubagentToRunningTask(state.currentTools, {
              id: event.id,
              agent: event.agent,
              description: event.description,
              active: true,
            }),
          );
          update({
            statusHint: `Subagent (${event.agent}): ${event.description}…`,
          });
          break;
        case "subagent_end":
          setCurrentTools(finalizeSubagent(state.currentTools, event.id));
          update({
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
      // Gate on the resolver, not the phase: a sibling tool's tool_start can
      // flip the phase off "approval" while the gate is still awaiting, and a
      // stop must still deny it rather than leave the loop blocked.
      if (!approvalResolver) return;
      approvalResolver(false);
      approvalResolver = null;
      update({
        pendingApproval: null,
        phase: "running",
        statusHint: RUNNING_HINT,
      });
    },

    requestQuestion(question, options) {
      return new Promise<string | null>((resolve) => {
        const id = randomUUID();
        questionQueue.push({ id, question, options, resolve });
        // Only the head of the queue drives the UI — a question pushed while
        // another is already showing waits its turn.
        if (questionQueue.length === 1) {
          update({
            phase: "question",
            pendingQuestion: { id, question, options },
            statusHint: "↑↓ choose · Enter answer · type a custom reply · Esc skip",
          });
        }
      });
    },

    respondQuestion(answer) {
      const current = questionQueue.shift();
      if (!current) return;
      current.resolve(answer);
      advanceQuestionQueue();
    },

    rejectPendingQuestion() {
      // Gate on the queue, not the phase: a sibling tool's tool_start can
      // flip the phase off "question" while askuser is still awaiting, and a
      // stop/skip must still resolve it rather than leave the loop blocked.
      // Stopping the turn abandons every queued question, not just the one
      // on screen.
      if (questionQueue.length === 0) return;
      const pending = questionQueue.splice(0, questionQueue.length);
      for (const item of pending) item.resolve(null);
      update({
        pendingQuestion: null,
        phase: "running",
        statusHint: RUNNING_HINT,
      });
    },
  };
}
