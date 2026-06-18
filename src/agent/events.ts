import type { AssistantMessage } from "../provider/types.js";
import type { TodoItem } from "../todos/types.js";

export type AgentEvent =
  | { type: "text_delta"; text: string; subagentId?: string }
  | { type: "reasoning_delta"; text: string; subagentId?: string }
  | { type: "llm_start"; id: string; model: string; subagentId?: string }
  | { type: "assistant_message"; id: string; message: AssistantMessage; subagentId?: string }
  | { type: "tool_start"; id: string; name: string; args: unknown; subagentId?: string }
  | { type: "tool_end"; id: string; name: string; output: string; isError?: boolean; subagentId?: string }
  | { type: "approval_required"; id: string; name: string; args: unknown; subagentId?: string }
  | { type: "todo_update"; todos: TodoItem[] }
  | { type: "subagent_start"; id: string; description: string; agent: string }
  | { type: "subagent_end"; id: string; agent: string; turns: number; summary: string }
  | { type: "loop_end"; reason: "complete" | "terminate" | "error" };

export type AgentEventSink = (event: AgentEvent) => void;

export const noopSink: AgentEventSink = () => {};
