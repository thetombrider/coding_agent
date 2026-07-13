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
  streamingReasoningSegments: [],
  currentBlocks: [],
  phase: "input",
  pendingApproval: null,
  pendingQuestion: null,
  input: "",
  statusHint: "",
  turnStartedAt: null,
  todos: [],
  activeSkills: [],
});

describe("plaintext", () => {
  it("includes reasoning text in turn plaintext", () => {
    const text = turnToPlainText({
      userText: "think",
      reasoningText: "internal steps",
      assistantText: "done",
      tools: [],
      blocks: [],
    });
    expect(text).toContain("thinking:\ninternal steps");
    expect(text).toContain("done");
  });

  it("flattens a turn with tools and assistant text", () => {
    const text = turnToPlainText({
      userText: "read package.json",
      assistantText: "It has two deps.",
      blocks: [],
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

  it("includes written file content from write tool args", () => {
    const text = toolEntryToPlainText({
      id: "1",
      name: "write",
      args: { path: "out.ts", content: "export const x = 1;\n" },
      status: "done",
      output: "Wrote out.ts (18 bytes)",
    });
    expect(text).toBe("write  out.ts\nexport const x = 1;\n");
  });

  it("serializes the visible conversation", () => {
    const state = baseState();
    state.completedTurns = [
      { userText: "hi", assistantText: "hello", tools: [], blocks: [] },
      {
        userText: "run ls",
        assistantText: "done",
        blocks: [],
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
        blocks: [],
        tools: [{ id: "1", name: "read", args: {}, status: "done", output: "old" }],
      },
      {
        userText: "two",
        assistantText: "latest reply",
        blocks: [],
        tools: [{ id: "2", name: "bash", args: { command: "pwd" }, status: "done", output: "/tmp" }],
      },
    ];

    expect(pickFocusedCopyText(state, "hovered")).toBe("hovered");
    expect(pickFocusedCopyText(state)).toBe("latest reply");

    const toolOnly = baseState();
    toolOnly.completedTurns = [
      { userText: "go", assistantText: "", tools: [{ id: "3", name: "bash", args: {}, status: "done", output: "ok" }], blocks: [] },
    ];
    expect(pickFocusedCopyText(toolOnly)).toBe(toolEntryToPlainText(toolOnly.completedTurns[0]!.tools[0]!));

    const assistantOnly = baseState();
    assistantOnly.completedTurns = [{ userText: "hi", assistantText: "only text", tools: [], blocks: [] }];
    expect(pickFocusedCopyText(assistantOnly)).toBe("only text");
  });
});
