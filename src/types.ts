export type Role = "system" | "user" | "assistant" | "tool";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "toolResult"; toolCallId: string; output: string; isError?: boolean };

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface AgentContext {
  messages: Message[];
  cwd: string;
}
