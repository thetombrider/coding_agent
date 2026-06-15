import { describe, expect, it } from "vitest";
import { MutationQueue, isWriteToolName, writeMutationKey } from "./mutation-queue.js";

describe("MutationQueue", () => {
  it("serializes operations on the same key", async () => {
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
});

describe("write helpers", () => {
  it("identifies write tools", () => {
    expect(isWriteToolName("write")).toBe(true);
    expect(isWriteToolName("edit")).toBe(true);
    expect(isWriteToolName("read")).toBe(false);
  });

  it("builds a mutation key from tool args", () => {
    const key = writeMutationKey(
      "edit",
      { path: "src/foo.ts" },
      (cwd, p) => `${cwd}/${p}`,
      "/proj",
    );
    expect(key).toBe("/proj/src/foo.ts");
  });
});
