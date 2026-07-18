import type { AgentEvent } from "../agent/events.js";
import type { AgentContext, Message } from "../types.js";

export interface HookMap {
  before_tool: {
    in: { id: string; name: string; args: unknown };
    out: void | { block: true; reason: string } | { args: unknown };
  };
  after_tool: {
    in: { name: string; args: unknown; output: string; isError?: boolean };
    out: void | { output: string };
  };
  before_prompt: {
    in: { messages: Message[]; model: string };
    out: void | { messages: Message[] };
  };
  before_compact: {
    in: { messages: Message[] };
    out: void;
  };
  session_start: {
    in: { cwd: string };
    out: void;
  };
  session_end: {
    in: { reason: string };
    out: void;
  };
}

export type HookHandler<K extends keyof HookMap> = (
  payload: HookMap[K]["in"],
  ctx: AgentContext,
  signal?: AbortSignal,
) => HookMap[K]["out"] | Promise<HookMap[K]["out"]>;

export interface HookRegistry {
  on<K extends keyof HookMap>(event: K, handler: HookHandler<K>): () => void;
  observe(fn: (e: AgentEvent) => void): () => void;
}
