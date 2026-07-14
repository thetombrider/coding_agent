import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookRegistry, logHookError } from "./registry.js";
import { testAgentContext } from "../test-helpers.js";

const ctx = testAgentContext("/tmp");

describe("createHookRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("before_tool short-circuits on first block", async () => {
    const hooks = createHookRegistry();
    const calls: string[] = [];

    hooks.on("before_tool", () => {
      calls.push("first");
      return { block: true, reason: "nope" };
    });
    hooks.on("before_tool", () => {
      calls.push("second");
    });

    const result = await hooks.fireHook("before_tool", { id: "tc1", name: "bash", args: {} }, ctx);
    expect(result).toEqual({ block: true, reason: "nope" });
    expect(calls).toEqual(["first"]);
  });

  it("before_tool chains arg rewrites in registration order", async () => {
    const hooks = createHookRegistry();

    hooks.on("before_tool", ({ args }) => ({
      args: { ...(args as object), n: ((args as { n: number }).n ?? 0) + 1 },
    }));
    hooks.on("before_tool", ({ args }) => ({
      args: { ...(args as object), n: ((args as { n: number }).n ?? 0) + 1 },
    }));

    const result = await hooks.fireHook("before_tool", { id: "tc1", name: "t", args: { n: 0 } }, ctx);
    expect(result).toEqual({ args: { n: 2 } });
  });

  it("after_tool rewrites output", async () => {
    const hooks = createHookRegistry();
    hooks.on("after_tool", () => ({ output: "rewritten" }));

    const result = await hooks.fireHook(
      "after_tool",
      { name: "read", args: {}, output: "original" },
      ctx,
    );
    expect(result).toEqual({ output: "rewritten" });
  });

  it("before_tool handler throw blocks the tool without crashing", async () => {
    const hooks = createHookRegistry();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const calls: string[] = [];

    hooks.on("before_tool", () => {
      calls.push("first");
      throw new Error("gate blew up");
    });
    hooks.on("before_tool", () => {
      calls.push("second");
    });

    const result = await hooks.fireHook("before_tool", { id: "tc1", name: "bash", args: {} }, ctx);
    expect(result).toEqual({ block: true, reason: "Hook error: gate blew up" });
    expect(calls).toEqual(["first"]);
    expect(stderr).toHaveBeenCalled();
  });

  it("after_tool handler throw logs and continues with prior output", async () => {
    const hooks = createHookRegistry();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    hooks.on("after_tool", () => {
      throw new Error("rewrite failed");
    });
    hooks.on("after_tool", () => ({ output: "rewritten" }));

    const result = await hooks.fireHook(
      "after_tool",
      { name: "read", args: {}, output: "original" },
      ctx,
    );
    expect(result).toEqual({ output: "rewritten" });
    expect(stderr).toHaveBeenCalled();
  });

  it("void hook handler throw is logged and does not propagate", async () => {
    const hooks = createHookRegistry();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const calls: number[] = [];

    hooks.on("session_start", () => {
      throw new Error("startup failed");
    });
    hooks.on("session_start", () => {
      calls.push(1);
    });

    await hooks.fireHook("session_start", { cwd: "/tmp" }, ctx);
    expect(calls).toEqual([1]);
    expect(stderr).toHaveBeenCalled();
  });

  it("observe is fire-and-forget and logs errors without affecting other observers", async () => {
    const hooks = createHookRegistry();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const ok = vi.fn();
    const bad = vi.fn(() => {
      throw new Error("observer failed");
    });

    hooks.observe(bad);
    hooks.observe(ok);
    hooks.emit({ type: "text_delta", text: "hi" });

    await new Promise((r) => setTimeout(r, 10));
    expect(ok).toHaveBeenCalledWith({ type: "text_delta", text: "hi" });
    expect(bad).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
  });

  it("strictObservers rethrows observer errors", () => {
    const hooks = createHookRegistry({ strictObservers: true });
    hooks.observe(() => {
      throw new Error("observer failed");
    });

    expect(() => hooks.emit({ type: "text_delta", text: "hi" })).toThrow("observer failed");
  });

  it("on returns an unsubscribe function", async () => {
    const hooks = createHookRegistry();
    const calls: number[] = [];
    const unsub = hooks.on("session_start", () => {
      calls.push(1);
    });

    await hooks.fireHook("session_start", { cwd: "/tmp" }, ctx);
    unsub();
    await hooks.fireHook("session_start", { cwd: "/tmp" }, ctx);

    expect(calls).toHaveLength(1);
  });
});

describe("logHookError", () => {
  it("writes message and stack to stderr", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = new Error("boom");
    logHookError("test scope", err);
    expect(stderr).toHaveBeenCalledWith("[orin hooks] test scope failed: boom\n");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Error: boom"));
    stderr.mockRestore();
  });
});
