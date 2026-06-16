import { spawnSync } from "node:child_process";
import type { HookRegistry } from "./types.js";

const RTK_SUPPORTED = /^(git|ls|cat|grep|tsc|jest|vitest|docker|npm|yarn)/;

export function commandExists(cmd: string): boolean {
  const result = spawnSync("which", [cmd], { stdio: "ignore" });
  return result.status === 0;
}

export function installRtkRewrite(
  hooks: HookRegistry,
  exists: (cmd: string) => boolean = commandExists,
): void {
  hooks.on("before_tool", ({ name, args }, ctx) => {
    if (name !== "bash") return;
    const cmd = (args as { command: string }).command.trim();
    if (!RTK_SUPPORTED.test(cmd) || cmd.startsWith("rtk ")) return;

    const hasRtk = ctx.workspace.kind === "e2b" || exists("rtk");
    if (!hasRtk) return;

    return { args: { ...args as object, command: `rtk ${cmd}` } };
  });
}
