import { tool } from "ai";
import type { ApprovalMode } from "../approval/policy.js";
import {
  isToolBlocked,
  needsInteractiveApproval,
} from "../approval/policy.js";
import { confirmTool } from "../approval/prompt.js";
import type { AgentEventSink } from "./events.js";
import type { StreamAssistantFn } from "../provider/types.js";
import type { AnyTool } from "../tools/registry.js";
import type { AgentContext, Message, SessionEventCallback } from "../types.js";
import { resolvePath } from "../util/paths.js";
import { MutationQueue, writeMutationKey } from "./mutation-queue.js";

export interface RunLoopOptions {
  provider: StreamAssistantFn;
  tools: AnyTool[];
  model: string;
  system?: string;
  signal?: AbortSignal;
  /** @deprecated use approvalMode + autoAcceptCli */
  autoAccept?: boolean;
  approvalMode?: ApprovalMode;
  autoAcceptCli?: boolean;
  confirm?: (name: string, args: unknown) => Promise<boolean>;
  onEvent?: SessionEventCallback;
}

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

interface ExecutedTool {
  message: Message;
  terminate?: boolean;
}

function toolMap(tools: AnyTool[]): Map<string, AnyTool> {
  return new Map(tools.map((t) => [t.name, t]));
}

function toProviderTools(tools: AnyTool[]) {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: t.schema,
      }),
    ]),
  );
}

function toolResultMessage(toolCallId: string, output: string, isError?: boolean): Message {
  return {
    role: "tool",
    content: [{ type: "toolResult", toolCallId, output, isError }],
  };
}

async function executeSingleTool(
  call: ToolCallBlock,
  registry: Map<string, AnyTool>,
  ctx: AgentContext,
  emit: AgentEventSink,
  options: RunLoopOptions,
  ts: () => string,
): Promise<ExecutedTool> {
  const tool = registry.get(call.name);
  if (!tool) {
    const output = `Unknown tool: ${call.name}`;
    const msg = toolResultMessage(call.id, output, true);
    options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
    emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
    return { message: msg };
  }

  const args = tool.schema.parse(call.arguments);
  const mode = options.approvalMode ?? "normal";
  const autoAcceptCli = options.autoAcceptCli ?? options.autoAccept ?? false;

  if (isToolBlocked(mode, call.name)) {
    const output = `Tool ${call.name} blocked in plan mode.`;
    emit({ type: "approval_required", id: call.id, name: call.name, args });
    const msg = toolResultMessage(call.id, output, true);
    options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
    emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
    return { message: msg };
  }

  const requiresApproval = needsInteractiveApproval(
    mode,
    autoAcceptCli,
    call.name,
    tool.needsApproval?.(args, ctx),
  );

  if (requiresApproval) {
    emit({ type: "approval_required", id: call.id, name: call.name, args });
    const approved = await (options.confirm ?? confirmTool)(call.name, args);
    if (!approved) {
      const output = "Tool execution denied by user.";
      const msg = toolResultMessage(call.id, output, true);
      options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
      emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
      return { message: msg };
    }
  }

  emit({ type: "tool_start", id: call.id, name: call.name, args });

  try {
    const result = await tool.execute(args, ctx, options.signal ?? new AbortController().signal);
    const msg = toolResultMessage(call.id, result.output, result.isError);
    options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
    emit({
      type: "tool_end",
      id: call.id,
      name: call.name,
      output: result.output,
      isError: result.isError,
    });
    return { message: msg, terminate: result.terminate };
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    const msg = toolResultMessage(call.id, output, true);
    options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
    emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
    return { message: msg };
  }
}

async function executeToolsParallel(
  calls: ToolCallBlock[],
  registry: Map<string, AnyTool>,
  ctx: AgentContext,
  emit: AgentEventSink,
  options: RunLoopOptions,
  ts: () => string,
): Promise<ExecutedTool[]> {
  const mutationQueue = new MutationQueue();

  return Promise.all(
    calls.map((call) => {
      const key = writeMutationKey(call.name, call.arguments, resolvePath, ctx.cwd);
      const run = () => executeSingleTool(call, registry, ctx, emit, options, ts);
      return key ? mutationQueue.runExclusive(key, run) : run();
    }),
  );
}

export async function runLoop(
  ctx: AgentContext,
  emit: AgentEventSink,
  options: RunLoopOptions,
): Promise<AgentContext> {
  const registry = toolMap(options.tools);

  while (true) {
    const message = await options.provider(
      ctx.messages,
      {
        model: options.model,
        system: options.system,
        tools: toProviderTools(options.tools),
        signal: options.signal,
      },
      (event) => {
        if (event.type === "text_delta") emit({ type: "text_delta", text: event.text });
      },
    );

    const ts = () => new Date().toISOString();
    ctx.messages.push(message);
    options.onEvent?.({ type: "assistant_chunk", ts: ts(), content: message.content });
    emit({ type: "assistant_message", message });

    const toolCalls = message.content.filter((c): c is ToolCallBlock => c.type === "toolCall");
    if (toolCalls.length === 0) {
      emit({ type: "loop_end", reason: "complete" });
      break;
    }

    const results = await executeToolsParallel(toolCalls, registry, ctx, emit, options, ts);

    for (const result of results) {
      ctx.messages.push(result.message);
      if (result.terminate) {
        emit({ type: "loop_end", reason: "terminate" });
        return ctx;
      }
    }
  }

  return ctx;
}

export function lastAssistantText(ctx: AgentContext): string {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i];
    if (m.role !== "assistant") continue;
    return m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}
