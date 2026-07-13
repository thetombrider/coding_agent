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

  it("inserts a newline between assistant text streams across LLM calls", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("multi-round");

    controller.handleEvent({ type: "text_delta", text: "Checking " });
    controller.handleEvent({
      type: "tool_start",
      id: "read1",
      name: "read",
      args: { path: "a.ts" },
    });
    controller.handleEvent({
      type: "tool_end",
      id: "read1",
      name: "read",
      output: "ok",
    });
    controller.handleEvent({ type: "llm_start", id: "call-2", model: "test/model" });
    controller.handleEvent({ type: "text_delta", text: "Done." });
    controller.finalizeTurn();

    const turn = controller.getState().completedTurns[0];
    expect(turn?.assistantText).toBe("Checking \nDone.");
  });

  it("drops empty reasoning blocks left by llm_start without reasoning deltas", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("tool then text");

    controller.handleEvent({ type: "reasoning_delta", text: "Plan the read." });
    controller.handleEvent({
      type: "tool_start",
      id: "read1",
      name: "read",
      args: { path: "a.ts" },
    });
    controller.handleEvent({
      type: "tool_end",
      id: "read1",
      name: "read",
      output: "ok",
    });
    controller.handleEvent({ type: "llm_start", id: "call-2", model: "test/model" });
    controller.handleEvent({ type: "text_delta", text: "Done." });
    controller.finalizeTurn();

    const turn = controller.getState().completedTurns[0];
    expect(turn?.reasoningText).toBe("Plan the read.");
    expect(turn?.blocks.filter((b) => b.type === "reasoning")).toEqual([
      { type: "reasoning", id: expect.any(String), text: "Plan the read." },
    ]);
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

  it("rejectPendingApproval denies a waiting approval gate", async () => {
    const controller = createSessionController(meta);
    const pending = controller.requestApproval("bash", { command: "ls" });
    controller.rejectPendingApproval();
    await expect(pending).resolves.toBe(false);
    expect(controller.getState().phase).toBe("running");
  });

  it("resolves a question with the chosen answer via respondQuestion", async () => {
    const controller = createSessionController(meta);
    const pending = controller.requestQuestion("Which DB?", ["Postgres", "SQLite"]);
    expect(controller.getState().phase).toBe("question");
    expect(controller.getState().pendingQuestion).toEqual({
      id: expect.any(String),
      question: "Which DB?",
      options: ["Postgres", "SQLite"],
    });

    controller.respondQuestion("SQLite");
    await expect(pending).resolves.toBe("SQLite");
    expect(controller.getState().pendingQuestion).toBeNull();
    expect(controller.getState().phase).toBe("running");
  });

  it("queues a second concurrent question instead of clobbering the first", async () => {
    const controller = createSessionController(meta);

    // Two `askuser` tool calls in the same parallel batch both call
    // requestQuestion before either resolves.
    const first = controller.requestQuestion("Which DB?", ["Postgres", "SQLite"]);
    const second = controller.requestQuestion("Which cache?", ["Redis", "Memcached"]);

    // Only the first question drives the UI; the second waits its turn
    // instead of overwriting pendingQuestion and orphaning `first`.
    expect(controller.getState().pendingQuestion).toMatchObject({
      question: "Which DB?",
      options: ["Postgres", "SQLite"],
    });

    controller.respondQuestion("SQLite");
    await expect(first).resolves.toBe("SQLite");

    expect(controller.getState().phase).toBe("question");
    expect(controller.getState().pendingQuestion).toMatchObject({
      question: "Which cache?",
      options: ["Redis", "Memcached"],
    });

    controller.respondQuestion("Redis");
    await expect(second).resolves.toBe("Redis");
    expect(controller.getState().pendingQuestion).toBeNull();
    expect(controller.getState().phase).toBe("running");
  });

  it("rejectPendingQuestion abandons every queued question, not just the visible one", async () => {
    const controller = createSessionController(meta);
    const first = controller.requestQuestion("Which DB?", ["Postgres", "SQLite"]);
    const second = controller.requestQuestion("Which cache?", ["Redis", "Memcached"]);

    controller.rejectPendingQuestion();

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(controller.getState().pendingQuestion).toBeNull();
    expect(controller.getState().phase).toBe("running");
  });

  it("rejectPendingQuestion dismisses a waiting question with null", async () => {
    const controller = createSessionController(meta);
    const pending = controller.requestQuestion("A or B?", ["A", "B"]);
    controller.rejectPendingQuestion();
    await expect(pending).resolves.toBeNull();
    expect(controller.getState().phase).toBe("running");
    expect(controller.getState().pendingQuestion).toBeNull();
  });

  it("rejectPendingQuestion is a no-op when no question is pending", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("hi");
    controller.rejectPendingQuestion();
    expect(controller.getState().phase).toBe("running");
  });

  it("keeps the question modal when a sibling tool starts mid-askuser", async () => {
    const controller = createSessionController(meta);
    controller.beginTurn("plan");

    // askuser blocks here, surfacing the question to the UI.
    const pending = controller.requestQuestion("Pick one", ["A", "B"]);
    expect(controller.getState().phase).toBe("question");

    // A sibling tool from the same parallel batch starts while the question
    // waits. It must record the tool without knocking the UI out of the
    // question (which would freeze arrow/Enter handling and Ctrl+C).
    controller.handleEvent({
      type: "tool_start",
      id: "read1",
      name: "read",
      args: { path: "a.ts" },
    });

    expect(controller.getState().phase).toBe("question");
    expect(controller.getState().pendingQuestion).toEqual({
      id: expect.any(String),
      question: "Pick one",
      options: ["A", "B"],
    });
    expect(controller.getState().currentTools.some((t) => t.id === "read1")).toBe(true);

    // The user can still answer, and the loop unblocks.
    controller.respondQuestion("B");
    await expect(pending).resolves.toBe("B");
  });

  it("still cancels a pending question after the phase was clobbered", async () => {
    const controller = createSessionController(meta);
    controller.beginTurn("plan");
    const pending = controller.requestQuestion("A or B?", ["A", "B"]);

    // Even if a stray event flips the phase, a stop must unblock the prompt.
    controller.rejectPendingQuestion();
    await expect(pending).resolves.toBeNull();
    expect(controller.getState().pendingQuestion).toBeNull();
  });

  it("keeps the approval modal when a sibling tool starts mid-approval", async () => {
    const controller = createSessionController(meta);
    controller.beginTurn("do");

    const pending = controller.requestApproval("bash", { command: "ls" });
    expect(controller.getState().phase).toBe("approval");

    controller.handleEvent({
      type: "tool_start",
      id: "read1",
      name: "read",
      args: { path: "a.ts" },
    });

    expect(controller.getState().phase).toBe("approval");
    expect(controller.getState().pendingApproval).toEqual({ name: "bash", args: { command: "ls" } });

    controller.respondApproval(true);
    await expect(pending).resolves.toBe(true);
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
      { userText: "hello", assistantText: "hi there", tools: [], blocks: [] },
      { userText: "how are you?", assistantText: "fine", tools: [], blocks: [] },
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

  it("folds a telemetry snapshot into the header meta on setSessionCost", () => {
    const controller = createSessionController(meta);

    controller.setSessionCost({
      costUsd: 0.042,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    });
    expect(controller.getState().meta.costUsd).toBeCloseTo(0.042);
    expect(controller.getState().meta.tokenTotals).toBe(150);

    // A null cost (pricing unknown) is preserved alongside the token total.
    controller.setSessionCost({
      costUsd: null,
      tokens: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 300 },
    });
    expect(controller.getState().meta.costUsd).toBeNull();
    expect(controller.getState().meta.tokenTotals).toBe(300);
  });

  it("nests subagent tool calls under the running task tool", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("explore");

    controller.handleEvent({
      type: "tool_start",
      id: "task1",
      name: "task",
      args: { description: "scan repo", prompt: "list files", agent: "explore" },
    });
    controller.handleEvent({
      type: "subagent_start",
      id: "sub1",
      description: "scan repo",
      agent: "explore",
    });
    controller.handleEvent({
      type: "tool_start",
      id: "read1",
      name: "read",
      args: { path: "package.json" },
      subagentId: "sub1",
    });
    controller.handleEvent({
      type: "tool_end",
      id: "read1",
      name: "read",
      output: "ok",
      subagentId: "sub1",
    });
    controller.handleEvent({
      type: "subagent_end",
      id: "sub1",
      agent: "explore",
      turns: 2,
      summary: "Found package.json",
    });
    controller.handleEvent({
      type: "tool_end",
      id: "task1",
      name: "task",
      output: "Subagent finished",
    });
    controller.finalizeTurn();

    const task = controller.getState().completedTurns[0]?.tools[0];
    expect(task?.name).toBe("task");
    expect(task?.subagent?.agent).toBe("explore");
    expect(task?.subagent?.tools).toHaveLength(1);
    expect(task?.subagent?.tools[0]?.name).toBe("read");
    expect(task?.subagent?.active).toBe(false);

    const taskBlock = controller.getState().completedTurns[0]?.blocks.find(
      (b) => b.type === "tool" && b.entry.id === "task1",
    );
    expect(taskBlock?.type).toBe("tool");
    if (taskBlock?.type === "tool") {
      expect(taskBlock.entry.subagent?.agent).toBe("explore");
      expect(taskBlock.entry.subagent?.tools[0]?.name).toBe("read");
    }
  });

  it("surfaces tool_input_start/tool_input_delta as a live footer progress hint", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("write a big file");

    controller.handleEvent({ type: "tool_input_start", id: "tc1", name: "write" });
    expect(controller.getState().statusHint).toBe("Writing…");

    controller.handleEvent({ type: "tool_input_delta", id: "tc1", name: "write", chars: 200 });
    expect(controller.getState().statusHint).toBe("Writing… (200 chars so far)");

    controller.handleEvent({ type: "tool_input_delta", id: "tc1", name: "write", chars: 2048 });
    expect(controller.getState().statusHint).toBe("Writing… (2.0 KB so far)");
  });

  it("prefixes tool_input progress with the subagent name and skips it while a modal is pending", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("explore");

    controller.handleEvent({
      type: "tool_start",
      id: "task1",
      name: "task",
      args: { description: "scan repo", prompt: "list files", agent: "explore" },
    });
    controller.handleEvent({
      type: "subagent_start",
      id: "sub1",
      description: "scan repo",
      agent: "explore",
    });
    controller.handleEvent({
      type: "tool_input_delta",
      id: "write1",
      name: "write",
      chars: 500,
      subagentId: "sub1",
    });
    expect(controller.getState().statusHint).toBe("Subagent (explore): Writing… (500 chars so far)");

    controller.handleEvent({
      type: "approval_required",
      id: "write1",
      name: "write",
      args: { path: "a.txt" },
    });
    const hintDuringApproval = controller.getState().statusHint;
    controller.handleEvent({
      type: "tool_input_delta",
      id: "write1",
      name: "write",
      chars: 900,
      subagentId: "sub1",
    });
    expect(controller.getState().statusHint).toBe(hintDuringApproval);
  });

  it("mirrors subagent nesting into currentBlocks while the turn is live", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("explore");

    controller.handleEvent({ type: "llm_start", id: "call-1", model: "test/model" });
    controller.handleEvent({
      type: "tool_start",
      id: "task1",
      name: "task",
      args: { description: "scan repo", prompt: "list files", agent: "explore" },
    });
    controller.handleEvent({
      type: "subagent_start",
      id: "sub1",
      description: "scan repo",
      agent: "explore",
    });
    controller.handleEvent({
      type: "tool_start",
      id: "read1",
      name: "read",
      args: { path: "package.json" },
      subagentId: "sub1",
    });

    const taskBlock = controller.getState().currentBlocks.find(
      (b) => b.type === "tool" && b.entry.id === "task1",
    );
    expect(taskBlock?.type).toBe("tool");
    if (taskBlock?.type === "tool") {
      expect(taskBlock.entry.subagent?.tools).toHaveLength(1);
      expect(taskBlock.entry.subagent?.tools[0]?.name).toBe("read");
    }
  });

  it("does not leak a subagent's internal llm_start/reasoning/text events into the parent turn", () => {
    const controller = createSessionController(meta);
    controller.beginTurn("explore");

    controller.handleEvent({
      type: "tool_start",
      id: "task1",
      name: "task",
      args: { description: "scan repo", prompt: "list files", agent: "explore" },
    });
    controller.handleEvent({
      type: "subagent_start",
      id: "sub1",
      description: "scan repo",
      agent: "explore",
    });
    // A subagent loop fires its own llm_start/reasoning_delta/text_delta per
    // internal LLM call — these must stay scoped to the subagent, not bleed
    // into the parent turn's reasoning blocks or streamed text.
    for (let i = 0; i < 5; i++) {
      controller.handleEvent({ type: "llm_start", id: `sub-call-${i}`, model: "test/model", subagentId: "sub1" });
      controller.handleEvent({ type: "reasoning_delta", text: "sub thinking", subagentId: "sub1" });
      controller.handleEvent({ type: "text_delta", text: "sub text", subagentId: "sub1" });
    }
    controller.handleEvent({
      type: "subagent_end",
      id: "sub1",
      agent: "explore",
      turns: 5,
      summary: "Found package.json",
    });
    controller.handleEvent({
      type: "tool_end",
      id: "task1",
      name: "task",
      output: "Subagent finished",
    });
    controller.handleEvent({ type: "llm_start", id: "call-2", model: "test/model" });
    controller.handleEvent({ type: "text_delta", text: "Done." });
    controller.finalizeTurn();

    const turn = controller.getState().completedTurns[0];
    expect(turn?.blocks.filter((b) => b.type === "reasoning")).toEqual([]);
    expect(turn?.reasoningText).toBeUndefined();
    expect(turn?.assistantText).toBe("Done.");
  });
});
