import { z } from "zod";
import { loadToolDescription } from "../util/load-txt.js";
import type { LocalWorkspace } from "../workspace/local.js";
import type { Tool } from "./types.js";

const schema = z.object({
  job_id: z.string().describe("Job id from bash background mode"),
});

export type BashKillArgs = z.infer<typeof schema>;

function asLocalWorkspace(ctx: { workspace: { kind: string } }): LocalWorkspace | undefined {
  if (ctx.workspace.kind !== "local") return undefined;
  return ctx.workspace as LocalWorkspace;
}

export const bashKillTool: Tool<BashKillArgs> = {
  name: "bash_kill",
  description: loadToolDescription("bash-kill"),
  schema,
  needsApproval: () => true,
  async execute({ job_id }, ctx) {
    const local = asLocalWorkspace(ctx);
    if (!local) {
      return { output: "Background jobs are only available in the local workspace.", isError: true };
    }

    const killed = await local.backgroundJobs.kill(job_id);
    if (!killed) {
      return { output: `No job with id ${job_id}`, isError: true };
    }

    return { output: `Killed job ${job_id}` };
  },
};
