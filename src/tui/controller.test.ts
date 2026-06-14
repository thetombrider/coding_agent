import { describe, expect, it } from "vitest";
import { createTuiController } from "./controller.js";

describe("createTuiController", () => {
  it("tracks streaming text and tool lifecycle", () => {
    const controller = createTuiController("test");
    const states: ReturnType<typeof controller.getState>[] = [];
    controller.subscribe((s) => states.push({ ...s, tools: [...s.tools] }));

    controller.handleEvent({ type: "text_delta", text: "Hello" });
    controller.handleEvent({
      type: "tool_start",
      id: "1",
      name: "read",
      args: { path: "a.ts" },
    });
    controller.handleEvent({
      type: "tool_end",
      id: "1",
      name: "read",
      output: "ok",
    });
    controller.handleEvent({ type: "loop_end", reason: "complete" });

    const last = states.at(-1)!;
    expect(last.assistantText).toBe("Hello");
    expect(last.tools).toHaveLength(1);
    expect(last.tools[0]?.status).toBe("done");
    expect(last.loopDone).toBe(true);
  });

  it("resolves approval via respondApproval", async () => {
    const controller = createTuiController("test");
    const pending = controller.requestApproval("bash", { command: "ls" });
    expect(controller.getState().pendingApproval?.name).toBe("bash");
    controller.respondApproval(true);
    await expect(pending).resolves.toBe(true);
    expect(controller.getState().pendingApproval).toBeNull();
  });
});
