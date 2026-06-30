import type { z } from "zod";
import type { AgentContext } from "../types.js";

export interface ToolResult {
  output: string;
  isError?: boolean;
  terminate?: boolean;
}

export interface Tool<A = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  needsApproval?: (args: A, ctx: AgentContext) => boolean;
  /** Override the name and args shown in the approval prompt (e.g. for gateway wrappers). */
  approvalDisplayArgs?: (args: unknown) => { name: string; args: unknown };
  execute(
    args: A,
    ctx: AgentContext,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}
