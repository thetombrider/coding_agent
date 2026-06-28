import { z } from "zod";
import { loadToolDescription } from "../util/load-txt.js";
import type { LocalWorkspace } from "../workspace/local.js";
import type { Tool } from "./types.js";

const schema = z.object({
  job_id: z
    .string()
    .optional()
    .describe("Job id from bash background mode; omit to list all jobs"),
});

export type BashStatusArgs = z.infer<typeof schema>;

function asLocalWorkspace(ctx: { workspace: { kind: string } }): LocalWorkspace | undefined {
  if (ctx.workspace.kind !== "local") return undefined;
  return ctx.workspace as LocalWorkspace;
}

export const bashStatusTool: Tool<BashStatusArgs> = {
  name: "bash_status",
  description: loadToolDescription("bash-status"),
  schema,
  async execute({ job_id }, ctx) {
    const local = asLocalWorkspace(ctx);
    if (!local) {
      return { output: "Background jobs are only available in the local workspace.", isError: true };
    }

    const jobs = local.backgroundJobs.list(job_id);
    if (jobs.length === 0) {
      return {
        output: job_id ? `No job with id ${job_id}` : "No background jobs",
        isError: !!job_id,
      };
    }

    const lines: string[] = [];
    for (const job of jobs) {
      lines.push(`job_id: ${job.id}`);
      lines.push(`command: ${job.command}`);
      if (job.pid !== undefined) lines.push(`pid: ${job.pid}`);
      lines.push(`status: ${job.status}`);
      if (job.exitCode !== undefined) lines.push(`exit_code: ${job.exitCode ?? "signal"}`);
      const tail = await local.backgroundJobs.tail(job.id);
      if (tail) lines.push(`\n--- output ---\n${tail}`);
      lines.push("");
    }

    return { output: lines.join("\n").trim() };
  },
};
