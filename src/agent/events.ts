import type { AssistantMessage } from "../provider/types.js";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "assistant_message"; message: AssistantMessage }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_end"; id: string; name: string; output: string; isError?: boolean }
  | { type: "approval_required"; id: string; name: string; args: unknown }
  | { type: "loop_end"; reason: "complete" | "terminate" | "error" };

export type AgentEventSink = (event: AgentEvent) => void;

export const noopSink: AgentEventSink = () => {};
