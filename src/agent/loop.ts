import { tool } from "ai";
import type { AgentEventSink } from "./events.js";
import type { StreamAssistantFn } from "../provider/types.js";
import type { AnyTool } from "../tools/registry.js";
import type { AgentContext, Message } from "../types.js";

export interface RunLoopOptions {
  provider: StreamAssistantFn;
  tools: AnyTool[];
  model: string;
  system?: string;
  signal?: AbortSignal;
  autoAccept?: boolean;
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

    ctx.messages.push(message);
    emit({ type: "assistant_message", message });

    const toolCalls = message.content.filter((c) => c.type === "toolCall");
    if (toolCalls.length === 0) {
      emit({ type: "loop_end", reason: "complete" });
      break;
    }

    for (const call of toolCalls) {
      if (call.type !== "toolCall") continue;

      const tool = registry.get(call.name);
      if (!tool) {
        const output = `Unknown tool: ${call.name}`;
        ctx.messages.push(toolResultMessage(call.id, output, true));
        emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
        continue;
      }

      const args = tool.schema.parse(call.arguments);

      if (tool.needsApproval?.(args, ctx) && !options.autoAccept) {
        emit({ type: "approval_required", id: call.id, name: call.name, args });
        const output = "Tool execution denied (approval required).";
        ctx.messages.push(toolResultMessage(call.id, output, true));
        emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
        continue;
      }

      emit({ type: "tool_start", id: call.id, name: call.name, args });

      try {
        const result = await tool.execute(args, ctx, options.signal ?? new AbortController().signal);
        ctx.messages.push(
          toolResultMessage(call.id, result.output, result.isError),
        );
        emit({
          type: "tool_end",
          id: call.id,
          name: call.name,
          output: result.output,
          isError: result.isError,
        });

        if (result.terminate) {
          emit({ type: "loop_end", reason: "terminate" });
          return ctx;
        }
      } catch (err) {
        const output = err instanceof Error ? err.message : String(err);
        ctx.messages.push(toolResultMessage(call.id, output, true));
        emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
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
