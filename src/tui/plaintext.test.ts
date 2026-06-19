import { describe, expect, it } from "vitest";
import type { SessionState } from "./controller.js";
import {
  pickFocusedCopyText,
  sessionToPlainText,
  toolEntryToPlainText,
  turnToPlainText,
} from "./plaintext.js";

const baseState = (): SessionState => ({
  meta: { model: "test", approval: "normal", cwd: "/tmp" },
  completedTurns: [],
  currentUserText: "",
  streamingText: "",
  streamingReasoning: "",
  currentTools: [],
  phase: "input",
  pendingApproval: null,
  input: "",
  statusHint: "",
  todos: [],
});

describe("plaintext", () => {
  it("includes reasoning text in turn plaintext", () => {
    const text = turnToPlainText({
      userText: "think",
      reasoningText: "internal steps",
      assistantText: "done",
      tools: [],
    });
    expect(text).toContain("thinking:\ninternal steps");
    expect(text).toContain("done");
  });

  it("flattens a turn with tools and assistant text", () => {
    const text = turnToPlainText({
      userText: "read package.json",
      assistantText: "It has two deps.",
      tools: [
        {
          id: "1",
          name: "read",
          args: { path: "package.json" },
          status: "done",
          output: '{"name":"orin"}',
        },
      ],
    });
    expect(text).toContain("you: read package.json");
    expect(text).toContain('read  package.json\n{"name":"orin"}');
    expect(text).toContain("It has two deps.");
  });

  it("serializes the visible conversation", () => {
    const state = baseState();
    state.completedTurns = [
      { userText: "hi", assistantText: "hello", tools: [] },
      {
        userText: "run ls",
        assistantText: "done",
        tools: [{ id: "2", name: "bash", args: { command: "ls" }, status: "done", output: "src" }],
      },
    ];
    const text = sessionToPlainText(state);
    expect(text).toContain("you: hi");
    expect(text).toContain("---");
    expect(text).toContain("bash  ls\nsrc");
  });

  it("prefers hovered output, then latest assistant text, then last tool output", () => {
    const state = baseState();
    state.completedTurns = [
      {
        userText: "one",
        assistantText: "first reply",
        tools: [{ id: "1", name: "read", args: {}, status: "done", output: "old" }],
      },
      {
        userText: "two",
        assistantText: "latest reply",
        tools: [{ id: "2", name: "bash", args: { command: "pwd" }, status: "done", output: "/tmp" }],
      },
    ];

    expect(pickFocusedCopyText(state, "hovered")).toBe("hovered");
    expect(pickFocusedCopyText(state)).toBe("latest reply");

    const toolOnly = baseState();
    toolOnly.completedTurns = [
      { userText: "go", assistantText: "", tools: [{ id: "3", name: "bash", args: {}, status: "done", output: "ok" }] },
    ];
    expect(pickFocusedCopyText(toolOnly)).toBe(toolEntryToPlainText(toolOnly.completedTurns[0]!.tools[0]!));

    const assistantOnly = baseState();
    assistantOnly.completedTurns = [{ userText: "hi", assistantText: "only text", tools: [] }];
    expect(pickFocusedCopyText(assistantOnly)).toBe("only text");
  });
});
