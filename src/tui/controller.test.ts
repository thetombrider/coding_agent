import { describe, expect, it } from "vitest";
import { createSessionController } from "./controller.js";

describe("createSessionController", () => {
  const meta = { model: "test/model", approval: "normal", cwd: "/tmp" };

  it("accumulates reasoning deltas separately from assistant text", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("think");

    controller.handleEvent({ type: "reasoning_delta", text: "Step 1. " });
    controller.handleEvent({ type: "reasoning_delta", text: "Step 2." });
    controller.handleEvent({ type: "text_delta", text: "Answer." });
    controller.finalizeTurn();

    const turn = controller.getState().completedTurns[0];
    expect(turn?.reasoningText).toBe("Step 1. Step 2.");
    expect(turn?.assistantText).toBe("Answer.");
  });

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

  it("loadHistory replaces completedTurns and resets to input phase", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("live turn");

    const turns = [
      { userText: "hello", assistantText: "hi there", tools: [] },
      { userText: "how are you?", assistantText: "fine", tools: [] },
    ];
    controller.loadHistory(turns);

    const state = controller.getState();
    expect(state.completedTurns).toHaveLength(2);
    expect(state.completedTurns[0]?.userText).toBe("hello");
    expect(state.completedTurns[1]?.assistantText).toBe("fine");
    expect(state.phase).toBe("input");
    expect(state.currentUserText).toBe("");
    expect(state.streamingText).toBe("");
  });

  it("loadHistory with empty turns clears the conversation", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("something");
    controller.finalizeTurn();
    controller.loadHistory([]);
    expect(controller.getState().completedTurns).toHaveLength(0);
  });

  it("batches rapid updates into one deferred notification", async () => {
    const controller = createSessionController(meta);
    let notifyCount = 0;
    controller.subscribe(() => {
      notifyCount += 1;
    });
    notifyCount = 0;

    controller.setInput("a");
    controller.setInput("ab");
    controller.setInput("abc");
    expect(notifyCount).toBe(0);

    await Promise.resolve();
    expect(notifyCount).toBe(1);
    expect(controller.getState().input).toBe("abc");
  });

  it("previews todo sidebar updates when todowrite starts", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("plan");

    controller.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "todowrite",
      args: {
        todos: [
          { id: "1", content: "Ship feature", status: "completed" },
          { id: "2", content: "Add tests", status: "in_progress" },
        ],
      },
    });

    expect(controller.getState().todos).toEqual([
      { id: "1", content: "Ship feature", status: "completed" },
      { id: "2", content: "Add tests", status: "in_progress" },
    ]);
  });
});
