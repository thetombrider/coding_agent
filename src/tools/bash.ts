import { z } from "zod";
import { loadToolDescription } from "../util/load-txt.js";
import type { LocalWorkspace } from "../workspace/local.js";
import { MAX_COMMAND_OUTPUT_BYTES, truncationNote } from "./output-limits.js";
import type { Tool } from "./types.js";

/** Default foreground timeout — matches opencode/nanocoder (2 minutes). */
export const DEFAULT_BASH_TIMEOUT_SEC = 120;

const schema = z.object({
  command: z.string().describe("Shell command to run"),
  timeout: z
    .number()
    .optional()
    .describe("Foreground only: max seconds to wait before killing the process (default 120)"),
  background: z
    .boolean()
    .optional()
    .describe("Start the command in the background and return immediately with a job id"),
  wait_ms: z
    .number()
    .optional()
    .describe("Background only: collect output for this many milliseconds before returning"),
});

export type BashArgs = z.infer<typeof schema>;

function asLocalWorkspace(ctx: { workspace: { kind: string } }): LocalWorkspace | undefined {
  if (ctx.workspace.kind !== "local") return undefined;
  return ctx.workspace as LocalWorkspace;
}

export const bashTool: Tool<BashArgs> = {
  name: "bash",
  description: loadToolDescription("bash"),
  schema,
  needsApproval: () => true,
  async execute({ command, timeout, background, wait_ms }, ctx, signal) {
    if (background) {
      const local = asLocalWorkspace(ctx);
      if (!local) {
        return {
          output: "Background mode is only supported in the local workspace.",
          isError: true,
        };
      }

      const result = await local.backgroundJobs.start(command, ctx.cwd, { waitMs: wait_ms });
      const lines = [
        `job_id: ${result.jobId}`,
        result.pid !== undefined ? `pid: ${result.pid}` : "",
        `status: ${result.status}`,
        result.outputTail ? `\n--- output ---\n${result.outputTail}` : "",
        "\nProbe with curl in foreground bash, check output with bash_status, stop with bash_kill.",
      ].filter(Boolean);

      return { output: lines.join("\n") };
    }

    let output = "";
    const effectiveTimeout = timeout ?? DEFAULT_BASH_TIMEOUT_SEC;
    const { exitCode, truncated, timedOut } = await ctx.workspace.exec(command, ctx.cwd, {
      onData: (chunk) => {
        output += chunk.toString();
      },
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: effectiveTimeout,
      signal,
    });

    if (truncated) {
      return { output: output + truncationNote(MAX_COMMAND_OUTPUT_BYTES) };
    }

    if (timedOut) {
      return {
        output:
          output
          + `\n[timed out after ${effectiveTimeout}s — retry with a larger timeout or use background: true for servers]`,
        isError: true,
      };
    }

    const suffix = exitCode === 0 ? "" : `\n[exit ${exitCode ?? "signal"}]`;
    return {
      output: output + suffix,
      isError: exitCode !== 0,
    };
  },
};
