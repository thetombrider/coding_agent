import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundProcessRegistry } from "./background-jobs.js";
import { createLocalWorkspace } from "./local.js";

describe("BackgroundProcessRegistry", () => {
  let jobsDir: string;

  beforeEach(async () => {
    jobsDir = await mkdtemp(join(tmpdir(), "orin-bg-"));
  });

  afterEach(async () => {
    await rm(jobsDir, { recursive: true, force: true });
  });

  it("starts a job, tails output, and kills it", async () => {
    const registry = new BackgroundProcessRegistry(jobsDir);
    const { jobId, outputTail, status } = await registry.start(
      'sh -c "echo hello-bg; sleep 30"',
      process.cwd(),
      { waitMs: 300 },
    );

    expect(outputTail).toContain("hello-bg");
    expect(status).toBe("running");

    const jobs = registry.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(jobId);

    await registry.kill(jobId);
    expect(registry.list(jobId)[0]?.status).toBe("killed");
    await registry.dispose();
  }, 10_000);

  it("cleans up running jobs on dispose", async () => {
    const registry = new BackgroundProcessRegistry(jobsDir);
    const { jobId } = await registry.start("sleep 120", process.cwd());
    expect(registry.list(jobId)[0]?.status).toBe("running");
    await registry.dispose();
    expect(registry.list(jobId)[0]?.status).toBe("killed");
  });
});

describe("createLocalWorkspace background integration", () => {
  it("exposes backgroundJobs registry", () => {
    const ws = createLocalWorkspace();
    expect(ws.backgroundJobs).toBeDefined();
  });
});
