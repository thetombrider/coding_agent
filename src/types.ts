export type Role = "system" | "user" | "assistant" | "tool";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "toolResult"; toolCallId: string; output: string; isError?: boolean };

export interface Message {
  role: Role;
  content: ContentBlock[];
}

import type { Workspace } from "./workspace/types.js";

export interface AgentContext {
  messages: Message[];
  cwd: string;
  workspace: Workspace;
}

export type SessionEvent =
  | { type: "user_message";    ts: string; content: ContentBlock[] }
  | { type: "assistant_chunk"; ts: string; content: ContentBlock[] }
  | { type: "tool_result";     ts: string; toolUseId: string; content: ContentBlock[] }
  | { type: "session_meta";    ts: string; sessionId: string; cwd: string; model: string }
  | { type: "session_clear";   ts: string };

export type SessionEventCallback = (event: SessionEvent) => void;
