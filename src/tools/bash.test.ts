import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashKillTool } from "./bash-kill.js";
import { bashStatusTool } from "./bash-status.js";
import { bashTool, DEFAULT_BASH_TIMEOUT_SEC } from "./bash.js";
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
    await ctx.workspace.dispose();
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

  it("truncates runaway output and does not mark it an error", async () => {
    const result = await bashTool.execute({ command: "yes x" }, ctx, new AbortController().signal);
    expect(result.output).toContain("[output truncated");
    expect(result.isError).toBeFalsy();
  });

  it("aborts a long-running command via signal", async () => {
    const controller = new AbortController();
    const promise = bashTool.execute({ command: "exec sleep 30" }, ctx, controller.signal);
    controller.abort();

    const result = await promise;
    expect(result.isError).toBe(true);
  });

  it("times out foreground commands after the default timeout", async () => {
    const result = await bashTool.execute(
      { command: "exec sleep 30", timeout: 1 },
      ctx,
      new AbortController().signal,
    );

    expect(result.output).toContain("[timed out after 1s");
    expect(result.isError).toBe(true);
  });

  it("uses the default timeout constant", () => {
    expect(DEFAULT_BASH_TIMEOUT_SEC).toBe(120);
  });

  it("resolves when a background child holds stdout after shell exits", async () => {
    const result = await bashTool.execute(
      { command: "sleep 2 & sleep 0.1" },
      ctx,
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
  }, 10_000);

  it("starts a background job and returns job id", async () => {
    const result = await bashTool.execute(
      { command: "sleep 60", background: true, wait_ms: 100 },
      ctx,
      new AbortController().signal,
    );

    expect(result.output).toMatch(/job_id: [a-f0-9]{8}/);
    expect(result.output).toContain("status: running");
    expect(result.isError).toBeFalsy();

    const status = await bashStatusTool.execute({}, ctx, new AbortController().signal);
    expect(status.output).toContain("sleep 60");

    const jobId = result.output.match(/job_id: ([a-f0-9]{8})/)?.[1];
    expect(jobId).toBeTruthy();
    const killed = await bashKillTool.execute({ job_id: jobId! }, ctx, new AbortController().signal);
    expect(killed.output).toContain("Killed job");
  }, 15_000);

  it("background start + curl probe + kill", async () => {
    const start = await bashTool.execute(
      {
        command: 'sh -c "echo ready-on-9876; while true; do sleep 1; done"',
        background: true,
        wait_ms: 500,
      },
      ctx,
      new AbortController().signal,
    );
    expect(start.output).toContain("job_id:");
    expect(start.output).toContain("ready-on-9876");

    const jobId = start.output.match(/job_id: ([a-f0-9]{8})/)?.[1]!;
    await bashKillTool.execute({ job_id: jobId }, ctx, new AbortController().signal);
    const status = await bashStatusTool.execute({ job_id: jobId }, ctx, new AbortController().signal);
    expect(status.output).toContain("status: killed");
  }, 15_000);
});

describe("bashStatusTool", () => {
  it("lists no jobs when empty", async () => {
    const ctx: AgentContext = {
      cwd: "/tmp",
      messages: [],
      workspace: createLocalWorkspace(),
    };
    const result = await bashStatusTool.execute({}, ctx, new AbortController().signal);
    expect(result.output).toBe("No background jobs");
    await ctx.workspace.dispose();
  });
});

describe("bashKillTool", () => {
  it("requires approval", () => {
    const ctx: AgentContext = {
      cwd: "/tmp",
      messages: [],
      workspace: createLocalWorkspace(),
    };
    expect(bashKillTool.needsApproval?.({ job_id: "abc" }, ctx)).toBe(true);
  });
});
