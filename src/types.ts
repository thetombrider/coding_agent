import type { ApprovalGateRef } from "./hooks/approval-gate.js";
import type { HookRegistryImpl } from "./hooks/registry.js";
import type { StreamAssistantFn } from "./provider/types.js";
import type { LlmCallRecorder, MetricEvent } from "./telemetry/events.js";
import type { TodoItem } from "./todos/types.js";
import type { Workspace } from "./workspace/types.js";

export type Role = "system" | "user" | "assistant" | "tool";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "toolResult"; toolCallId: string; toolName: string; output: string; isError?: boolean };

export interface Message {
  role: Role;
  content: ContentBlock[];
}

/** Session wiring for tools that spawn nested agent loops (e.g. `task`). */
export interface LoopHost {
  provider: StreamAssistantFn;
  model: string;
  cheapModel?: string;
  sessionId?: string;
  onEvent?: SessionEventCallback;
  hooks: HookRegistryImpl;
  approval: ApprovalGateRef;
  /** Records side-path LLM calls (compaction, delegate_read) for telemetry. */
  recordLlmCall?: LlmCallRecorder;
}

/**
 * Pause the loop to ask the interactive user a multiple-choice question and
 * await their answer. Resolves with the chosen option (or a free-text reply),
 * or `null` if the user dismissed it without answering. Set only by interactive
 * sessions — absent in headless/subagent contexts.
 */
export type AskUserFn = (question: string, options: string[]) => Promise<string | null>;

export interface AgentContext {
  messages: Message[];
  cwd: string;
  workspace: Workspace;
  /** Ephemeral session task list — survives compaction, rebuilt on resume. */
  todos?: TodoItem[];
  /** Nesting depth for subagent loops — 0 on the primary agent. */
  depth?: number;
  /** Host loop wiring — set by the session for nested-loop tools. */
  loopHost?: LoopHost;
  /** Prompt the interactive user a question mid-loop (set by the TUI session). */
  askUser?: AskUserFn;
}

export type SessionEvent =
  | { type: "user_message";    ts: string; content: ContentBlock[] }
  | { type: "assistant_chunk"; ts: string; content: ContentBlock[] }
  | { type: "tool_result";     ts: string; toolUseId: string; content: ContentBlock[] }
  | { type: "session_meta";    ts: string; sessionId: string; cwd: string; model: string }
  | { type: "session_clear";     ts: string }
  | { type: "session_completed"; ts: string }
  | { type: "checkpoint";        ts: string; checkpointId: string; label: string; tool: string }
  | { type: "metric";          ts: string; event: MetricEvent };

export type SessionEventCallback = (event: SessionEvent) => void;
