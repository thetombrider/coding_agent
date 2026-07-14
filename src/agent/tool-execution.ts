import type { HookRegistryImpl } from "../hooks/registry.js";
import type { AnyTool } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import type { AgentContext } from "../types.js";

export interface HookedToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ExecuteHookedToolOptions {
  call: HookedToolCall;
  tool: AnyTool;
  ctx: AgentContext;
  hooks: HookRegistryImpl;
  signal: AbortSignal;
  /** Inner tool invoked via Ratel invoke_tool — skip duplicate approval. */
  innerInvoke?: boolean;
  /** Do not emit tool_start/tool_end (outer invoke_tool owns UI events). */
  quiet?: boolean;
}

/**
 * Run before_tool/execute/after_tool for a single tool. Shared by the main loop
 * and Ratel invoke_tool so inner tools get the same gates and side effects.
 */
export async function executeHookedTool(
  options: ExecuteHookedToolOptions,
): Promise<ToolResult> {
  const { call, tool, ctx, hooks, signal, innerInvoke, quiet } = options;

  const prevInner = ctx.invokeToolInner;
  if (innerInvoke) ctx.invokeToolInner = call.name;

  try {
    const hookResult = await hooks.fireHook(
      "before_tool",
      { id: call.id, name: call.name, args: call.args },
      ctx,
      signal,
    );
    if (hookResult && "block" in hookResult && hookResult.block) {
      const output = `[Blocked: ${hookResult.reason}]`;
      if (!quiet) {
        hooks.emit({
          type: "tool_end",
          id: call.id,
          name: call.name,
          output,
          isError: true,
        });
      }
      return { output, isError: true };
    }

    const effectiveArgs = hookResult && "args" in hookResult ? hookResult.args : call.args;
    if (!quiet) {
      hooks.emit({ type: "tool_start", id: call.id, name: call.name, args: effectiveArgs });
    }

    const result = await tool.execute(effectiveArgs, ctx, signal);
    let output = result.output;
    const afterResult = await hooks.fireHook(
      "after_tool",
      { name: call.name, args: effectiveArgs, output },
      ctx,
      signal,
    );
    if (afterResult && "output" in afterResult) {
      output = afterResult.output;
    }

    if (!quiet) {
      hooks.emit({
        type: "tool_end",
        id: call.id,
        name: call.name,
        output,
        isError: result.isError,
      });
    }

    return { ...result, output };
  } finally {
    ctx.invokeToolInner = prevInner;
  }
}
