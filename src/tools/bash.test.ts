import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTool } from "./bash.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";

describe("bashTool", () => {
  let cwd: string;
  let ctx: AgentContext;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-bash-"));
    ctx = { cwd, messages: [], workspace: createLocalWorkspace() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("always requires approval", () => {
    expect(bashTool.needsApproval?.({ command: "ls" }, ctx)).toBe(true);
  });

  it("captures stdout on success", async () => {
    const result = await bashTool.execute(
      { command: "echo hello" },
      ctx,
      new AbortController().signal,
    );

    expect(result.output).toBe("hello\n");
    expect(result.isError).toBe(false);
  });

  it("runs in the workspace cwd", async () => {
    const result = await bashTool.execute(
      { command: "pwd" },
      ctx,
      new AbortController().signal,
    );

    // macOS resolves tmpdir symlinks, so compare on the trailing path segment.
    expect(result.output.trim()).toContain(cwd.split("/").pop() as string);
  });

  it("captures stderr and marks non-zero exit as error", async () => {
    const result = await bashTool.execute(
      { command: "echo oops >&2; exit 3" },
      ctx,
      new AbortController().signal,
    );

    expect(result.output).toContain("oops");
    expect(result.output).toContain("[exit 3]");
    expect(result.isError).toBe(true);
  });

  it("can mutate the workspace", async () => {
    await bashTool.execute(
      { command: "echo written > created.txt" },
      ctx,
      new AbortController().signal,
    );

    expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("written\n");
  });

  it("aborts a long-running command via signal", async () => {
    const controller = new AbortController();
    const promise = bashTool.execute({ command: "sleep 30" }, ctx, controller.signal);
    controller.abort();

    const result = await promise;
    expect(result.isError).toBe(true);
  });
});
