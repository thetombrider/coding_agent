import type { ApprovalGateRef } from "./hooks/approval-gate.js";
import type { HookRegistryImpl } from "./hooks/registry.js";
import type { StreamAssistantFn } from "./provider/types.js";
import type { MetricEvent } from "./telemetry/events.js";
import type { TodoItem } from "./todos/types.js";
import type { Workspace } from "./workspace/types.js";

export type Role = "system" | "user" | "assistant" | "tool";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "toolResult"; toolCallId: string; output: string; isError?: boolean };

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
}

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
}

export type SessionEvent =
  | { type: "user_message";    ts: string; content: ContentBlock[] }
  | { type: "assistant_chunk"; ts: string; content: ContentBlock[] }
  | { type: "tool_result";     ts: string; toolUseId: string; content: ContentBlock[] }
  | { type: "session_meta";    ts: string; sessionId: string; cwd: string; model: string }
  | { type: "session_clear";   ts: string }
  | { type: "metric";          ts: string; event: MetricEvent };

export type SessionEventCallback = (event: SessionEvent) => void;
