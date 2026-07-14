import { describe, expect, it } from "vitest";
import { MutationQueue, isWriteToolName, mutationLock } from "./mutation-queue.js";

describe("MutationQueue", () => {
  it("serializes exclusive operations on the same key", async () => {
    const queue = new MutationQueue();
    const order: number[] = [];

    const first = queue.runExclusive("foo", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
    });

    const second = queue.runExclusive("foo", async () => {
      order.push(3);
    });

    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("runs different keys in parallel", async () => {
    const queue = new MutationQueue();
    let concurrent = 0;
    let maxConcurrent = 0;

    const run = (key: string) =>
      queue.runExclusive(key, async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent -= 1;
      });

    await Promise.all([run("a"), run("b"), run("c")]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("runs shared reads on the same key in parallel", async () => {
    const queue = new MutationQueue();
    let concurrent = 0;
    let maxConcurrent = 0;

    const read = () =>
      queue.runShared("foo", async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent -= 1;
      });

    await Promise.all([read(), read(), read()]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("runs a read enqueued after a write only once the write completes", async () => {
    const queue = new MutationQueue();
    const order: string[] = [];

    const write = queue.runExclusive("foo", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("write");
    });
    const read = queue.runShared("foo", async () => {
      order.push("read");
    });

    await Promise.all([write, read]);
    expect(order).toEqual(["write", "read"]);
  });

  it("runs a write enqueued after a read only once the read completes", async () => {
    const queue = new MutationQueue();
    const order: string[] = [];

    const read = queue.runShared("foo", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("read");
    });
    const write = queue.runExclusive("foo", async () => {
      order.push("write");
    });

    await Promise.all([read, write]);
    expect(order).toEqual(["read", "write"]);
  });

  it("does not let a failed write block a later read", async () => {
    const queue = new MutationQueue();
    let read = false;

    const write = queue.runExclusive("foo", async () => {
      throw new Error("boom");
    });
    const reading = queue.runShared("foo", async () => {
      read = true;
    });

    await expect(write).rejects.toThrow("boom");
    await reading;
    expect(read).toBe(true);
  });
});

describe("mutation helpers", () => {
  it("identifies write tools", () => {
    expect(isWriteToolName("write")).toBe(true);
    expect(isWriteToolName("edit")).toBe(true);
    expect(isWriteToolName("read")).toBe(false);
  });

  it("classifies writes as exclusive locks", () => {
    const lock = mutationLock(
      "edit",
      { path: "src/foo.ts" },
      (cwd, p) => `${cwd}/${p}`,
      "/proj",
    );
    expect(lock).toEqual({ key: "/proj/src/foo.ts", mode: "exclusive" });
  });

  it("classifies reads as shared locks", () => {
    const lock = mutationLock(
      "read",
      { path: "src/foo.ts" },
      (cwd, p) => `${cwd}/${p}`,
      "/proj",
    );
    expect(lock).toEqual({ key: "/proj/src/foo.ts", mode: "shared" });
  });

  it("returns null for tools without a single path", () => {
    expect(mutationLock("grep", { pattern: "x" }, (cwd, p) => `${cwd}/${p}`, "/proj")).toBeNull();
    expect(mutationLock("read", {}, (cwd, p) => `${cwd}/${p}`, "/proj")).toBeNull();
  });

  it("classifies invoke_tool read/write through to the inner tool", () => {
    const lock = mutationLock(
      "invoke_tool",
      { toolId: "read", args: { path: "src/foo.ts" } },
      (cwd, p) => `${cwd}/${p}`,
      "/proj",
    );
    expect(lock).toEqual({ key: "/proj/src/foo.ts", mode: "shared" });
  });
});
