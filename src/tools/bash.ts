import { spawn } from "node:child_process";
import { z } from "zod";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  command: z.string().describe("Shell command to run"),
});

export type BashArgs = z.infer<typeof schema>;

export const bashTool: Tool<BashArgs> = {
  name: "bash",
  description: loadToolDescription("bash"),
  schema,
  needsApproval: () => true,
  execute({ command }, ctx, signal) {
    return new Promise((resolvePromise) => {
      const child = spawn(command, {
        cwd: ctx.cwd,
        shell: true,
        env: process.env,
        signal,
      });

      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });

      child.on("close", (code) => {
        const suffix = code === 0 ? "" : `\n[exit ${code}]`;
        resolvePromise({
          output: output + suffix,
          isError: code !== 0 && code !== null,
        });
      });

      child.on("error", (err) => {
        resolvePromise({ output: err.message, isError: true });
      });
    });
  },
};
