import { spawnSync } from "node:child_process";
import { shellQuote } from "../util/shell.js";
import type { Workspace } from "./types.js";

/** Read `git remote get-url origin` from a local directory (host-side seeding only). */
export function getGitOriginUrl(localCwd: string): string | undefined {
  const result = spawnSync("git", ["-C", localCwd, "remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  const url = result.stdout?.trim();
  return result.status === 0 && url ? url : undefined;
}

/** Safe label for UI — strips credentials from git/https URLs. */
export function safeRemoteLabel(url: string): string {
  const normalized = url.replace(/^git@([^:]+):/, "https://$1/");
  try {
    const parsed = new URL(normalized);
    parsed.username = "";
    parsed.password = "";
    const path = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return path || parsed.host || "repository";
  } catch {
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    return match?.[1] ?? "repository";
  }
}

/**
 * Seed a remote workspace with the project at `localCwd` via shallow git clone.
 */
export async function seedRepoIntoWorkspace(
  workspace: Workspace,
  localCwd: string,
  remoteRoot = "/home/user/project",
): Promise<string> {
  const origin = getGitOriginUrl(localCwd);
  if (!origin) {
    return "No git origin found — commit your repo and set a remote before using E2B sandbox";
  }

  await workspace.exec(`mkdir -p ${shellQuote(remoteRoot)}`, "/", { onData: () => {} });
  const { exitCode } = await workspace.exec(
    `git clone --depth 1 ${shellQuote(origin)} .`,
    remoteRoot,
    { onData: () => {}, timeout: 300 },
  );
  const label = safeRemoteLabel(origin);
  if (exitCode === 0) {
    return `Cloned ${label} into sandbox`;
  }
  return `git clone failed (exit ${exitCode})`;
}

/** Default logical cwd inside a fresh E2B sandbox after seeding. */
export const REMOTE_SANDBOX_ROOT = "/home/user/project";
