import type { AssistantMessage } from "../provider/types.js";
import type { TodoItem } from "../todos/types.js";
import type { Message } from "../types.js";

/**
 * A tool in scope for an LLM request, carried on `llm_start` for opt-in content
 * capture (telemetry 7a, issue #87). `schema` is a Zod schema serialised to JSON
 * Schema by the OTel exporter only when `captureContent` is on — kept as
 * `unknown` here so this module stays decoupled from the tools layer.
 */
export interface ToolSchemaRef {
  name: string;
  description: string;
  schema: unknown;
}

/**
 * Snapshot of an LLM request for opt-in content capture (telemetry 7a). Carried
 * by reference on `llm_start` so there is no serialisation cost when capture is
 * off; the exporter snapshots it to JSON synchronously only when capturing.
 */
export interface LlmRequestSnapshot {
  system?: string;
  messages: Message[];
  tools?: readonly ToolSchemaRef[];
}

export type AgentEvent =
  | { type: "turn_start"; id: string; firstUserText?: string }
  | { type: "text_delta"; text: string; subagentId?: string }
  | { type: "reasoning_delta"; text: string; subagentId?: string }
  | { type: "llm_start"; id: string; model: string; subagentId?: string; request?: LlmRequestSnapshot }
  | { type: "assistant_message"; id: string; message: AssistantMessage; subagentId?: string }
  | { type: "tool_start"; id: string; name: string; args: unknown; subagentId?: string }
  | { type: "tool_end"; id: string; name: string; output: string; isError?: boolean; subagentId?: string }
  | { type: "approval_required"; id: string; name: string; args: unknown; subagentId?: string }
  | { type: "todo_update"; todos: TodoItem[] }
  | { type: "subagent_start"; id: string; description: string; prompt?: string; agent: string; isolation?: "shared" | "worktree" | "sandbox"; model?: string }
  | { type: "subagent_end"; id: string; agent: string; turns: number; summary: string }
  | { type: "loop_end"; reason: "complete" | "terminate" | "error" | "cancelled" };

export type AgentEventSink = (event: AgentEvent) => void;

export const noopSink: AgentEventSink = () => {};
