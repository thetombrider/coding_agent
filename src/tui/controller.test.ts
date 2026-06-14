import { describe, expect, it } from "vitest";
import { createSessionController } from "./controller.js";

describe("createSessionController", () => {
  const meta = { model: "test/model", approval: "normal", cwd: "/tmp" };

  it("tracks a turn lifecycle", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("hello");

    controller.handleEvent({ type: "text_delta", text: "Hi" });
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
    controller.finalizeTurn();

    const state = controller.getState();
    expect(state.completedTurns).toHaveLength(1);
    expect(state.completedTurns[0]?.assistantText).toBe("Hi");
    expect(state.completedTurns[0]?.tools[0]?.status).toBe("done");
    expect(state.phase).toBe("input");
  });

  it("resolves approval via respondApproval", async () => {
    const controller = createSessionController(meta);
    const pending = controller.requestApproval("bash", { command: "ls" });
    expect(controller.getState().phase).toBe("approval");
    controller.respondApproval(true);
    await expect(pending).resolves.toBe(true);
    expect(controller.getState().pendingApproval).toBeNull();
  });

  it("manages input buffer", () => {
    const controller = createSessionController(meta);
    controller.appendInput("hi");
    expect(controller.getState().input).toBe("hi");
    controller.backspaceInput();
    expect(controller.getState().input).toBe("h");
    controller.clearInput();
    expect(controller.getState().input).toBe("");
  });

  it("retains turns until history is cleared", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("one");
    controller.finalizeTurn();
    controller.beginTurn("two");
    controller.finalizeTurn();
    expect(controller.getState().completedTurns).toHaveLength(2);
    controller.clearHistory();
    expect(controller.getState().completedTurns).toHaveLength(0);
  });
});
