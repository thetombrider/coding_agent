import type { AgentEvent } from "../agent/events.js";
import type { AgentContext } from "../types.js";
import type { HookHandler, HookMap, HookRegistry } from "./types.js";

type HandlerMap = {
  [K in keyof HookMap]: Array<HookHandler<K>>;
};

export type HookRegistryOptions = {
  /** Rethrow observer errors instead of logging (for tests). */
  strictObservers?: boolean;
};

export type HookRegistryImpl = HookRegistry & {
  fireHook<K extends keyof HookMap>(
    event: K,
    input: HookMap[K]["in"],
    ctx: AgentContext,
    signal?: AbortSignal,
  ): Promise<HookMap[K]["out"] | void>;
  emit(event: AgentEvent): void;
};

function isBlockResult(
  value: unknown,
): value is { block: true; reason: string } {
  return (
    typeof value === "object"
    && value !== null
    && "block" in value
    && (value as { block: unknown }).block === true
  );
}

function hasArgs(value: unknown): value is { args: unknown } {
  return typeof value === "object" && value !== null && "args" in value;
}

function hasOutput(value: unknown): value is { output: string } {
  return typeof value === "object" && value !== null && "output" in value;
}

function hasMessages(value: unknown): value is { messages: HookMap["before_prompt"]["in"]["messages"] } {
  return typeof value === "object" && value !== null && "messages" in value;
}

function hookErrorReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Hook error: ${message}`;
}

export function logHookError(scope: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[orin hooks] ${scope} failed: ${message}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
}

export function createHookRegistry(options: HookRegistryOptions = {}): HookRegistryImpl {
  const { strictObservers = false } = options;
  const handlers: HandlerMap = {
    before_tool: [],
    after_tool: [],
    before_prompt: [],
    before_compact: [],
    session_start: [],
    session_end: [],
  };
  const observers: Array<(e: AgentEvent) => void> = [];

  function on<K extends keyof HookMap>(event: K, handler: HookHandler<K>): () => void {
    const list = handlers[event] as Array<HookHandler<K>>;
    list.push(handler);
    return () => {
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  function observe(fn: (e: AgentEvent) => void): () => void {
    observers.push(fn);
    return () => {
      const idx = observers.indexOf(fn);
      if (idx !== -1) observers.splice(idx, 1);
    };
  }

  function emit(event: AgentEvent): void {
    for (const fn of observers) {
      if (strictObservers) {
        fn(event);
        continue;
      }
      void Promise.resolve()
        .then(() => fn(event))
        .catch((err) => {
          logHookError("observer", err);
        });
    }
  }

  async function fireBeforeTool(
    input: HookMap["before_tool"]["in"],
    ctx: AgentContext,
    signal?: AbortSignal,
  ): Promise<HookMap["before_tool"]["out"] | void> {
    let currentArgs = input.args;
    for (const handler of handlers.before_tool) {
      let result: HookMap["before_tool"]["out"] | void;
      try {
        result = await handler(
          { id: input.id, name: input.name, args: currentArgs },
          ctx,
          signal,
        );
      } catch (err) {
        logHookError("before_tool handler", err);
        return { block: true, reason: hookErrorReason(err) };
      }
      if (isBlockResult(result)) return result;
      if (hasArgs(result)) currentArgs = result.args;
    }
    if (currentArgs !== input.args) return { args: currentArgs };
  }

  async function fireAfterTool(
    input: HookMap["after_tool"]["in"],
    ctx: AgentContext,
    signal?: AbortSignal,
  ): Promise<HookMap["after_tool"]["out"] | void> {
    let currentOutput = input.output;
    for (const handler of handlers.after_tool) {
      let result: HookMap["after_tool"]["out"] | void;
      try {
        result = await handler(
          { name: input.name, args: input.args, output: currentOutput },
          ctx,
          signal,
        );
      } catch (err) {
        logHookError("after_tool handler", err);
        continue;
      }
      if (hasOutput(result)) currentOutput = result.output;
    }
    if (currentOutput !== input.output) return { output: currentOutput };
  }

  async function fireBeforePrompt(
    input: HookMap["before_prompt"]["in"],
    ctx: AgentContext,
    signal?: AbortSignal,
  ): Promise<HookMap["before_prompt"]["out"] | void> {
    let currentMessages = input.messages;
    for (const handler of handlers.before_prompt) {
      let result: HookMap["before_prompt"]["out"] | void;
      try {
        result = await handler(
          { messages: currentMessages, model: input.model },
          ctx,
          signal,
        );
      } catch (err) {
        logHookError("before_prompt handler", err);
        continue;
      }
      if (hasMessages(result)) currentMessages = result.messages;
    }
    if (currentMessages !== input.messages) return { messages: currentMessages };
  }

  async function fireVoidHook<K extends "before_compact" | "session_start" | "session_end">(
    event: K,
    input: HookMap[K]["in"],
    ctx: AgentContext,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const handler of handlers[event]) {
      try {
        await handler(input, ctx, signal);
      } catch (err) {
        logHookError(`${event} handler`, err);
      }
    }
  }

  async function fireHook<K extends keyof HookMap>(
    event: K,
    input: HookMap[K]["in"],
    ctx: AgentContext,
    signal?: AbortSignal,
  ): Promise<HookMap[K]["out"] | void> {
    switch (event) {
      case "before_tool":
        return fireBeforeTool(input as HookMap["before_tool"]["in"], ctx, signal) as Promise<
          HookMap[K]["out"] | void
        >;
      case "after_tool":
        return fireAfterTool(input as HookMap["after_tool"]["in"], ctx, signal) as Promise<
          HookMap[K]["out"] | void
        >;
      case "before_prompt":
        return fireBeforePrompt(input as HookMap["before_prompt"]["in"], ctx, signal) as Promise<
          HookMap[K]["out"] | void
        >;
      case "before_compact":
      case "session_start":
      case "session_end":
        return fireVoidHook(event, input as never, ctx, signal) as Promise<HookMap[K]["out"] | void>;
      default:
        return undefined;
    }
  }

  return { on, observe, fireHook, emit };
}
