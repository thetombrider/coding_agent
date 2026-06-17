import { describe, expect, it } from "vitest";
import {
  enrichAssistantMessage,
  parseJsonToolCalls,
  parseXmlToolCalls,
  parseToolCallsFromText,
} from "./tool-call-parser.js";
import type { AssistantMessage } from "./types.js";

describe("parseXmlToolCalls", () => {
  it("parses <tool_call name=...> blocks from the issue spec", () => {
    const calls = parseXmlToolCalls(
      'Checking file <tool_call name="read"><path>foo.ts</path></tool_call>',
    );
    expect(calls).toEqual([
      expect.objectContaining({ name: "read", arguments: { path: "foo.ts" } }),
    ]);
  });

  it("parses <tool><param> blocks when tool name is known", () => {
    const calls = parseXmlToolCalls("<read><path>bar.ts</path></read>", new Set(["read"]));
    expect(calls).toEqual([
      expect.objectContaining({ name: "read", arguments: { path: "bar.ts" } }),
    ]);
  });
});

describe("parseJsonToolCalls", () => {
  it("parses fenced JSON tool calls", () => {
    const calls = parseJsonToolCalls(
      '```json\n{"name":"read","arguments":{"path":"baz.ts"}}\n```',
    );
    expect(calls).toEqual([
      expect.objectContaining({ name: "read", arguments: { path: "baz.ts" } }),
    ]);
  });

  it("parses inline JSON arrays", () => {
    const calls = parseJsonToolCalls('[{"name":"grep","arguments":{"pattern":"foo"}}]');
    expect(calls).toEqual([
      expect.objectContaining({ name: "grep", arguments: { pattern: "foo" } }),
    ]);
  });
});

describe("parseToolCallsFromText", () => {
  it("prefers XML over JSON when both are present", () => {
    const calls = parseToolCallsFromText(
      '<tool_call name="read"><path>x.ts</path></tool_call>\n{"name":"write","arguments":{"path":"y"}}',
    );
    expect(calls?.[0]?.name).toBe("read");
  });
});

describe("enrichAssistantMessage", () => {
  const base: AssistantMessage = {
    role: "assistant",
    model: "faux:test",
    content: [{ type: "text", text: '<tool_call name="read"><path>foo.ts</path></tool_call>' }],
  };

  it("adds parsed tool calls when none are present", () => {
    const { message, usedFallback } = enrichAssistantMessage(base);
    expect(usedFallback).toBe(true);
    expect(message.content.some((c) => c.type === "toolCall")).toBe(true);
    expect(message.content.find((c) => c.type === "toolCall")).toMatchObject({
      name: "read",
      arguments: { path: "foo.ts" },
    });
  });

  it("is a no-op when structured tool calls already exist", () => {
    const withCalls: AssistantMessage = {
      ...base,
      content: [
        { type: "text", text: "hi" },
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
      ],
    };
    const { message, usedFallback } = enrichAssistantMessage(withCalls);
    expect(usedFallback).toBe(false);
    expect(message).toBe(withCalls);
  });
});

describe("formatEditMismatchError", () => {
  it("includes similarity, line, context, and matcher list", async () => {
    const { formatEditMismatchError } = await import("./tool-call-parser.js");
    const msg = formatEditMismatchError({
      oldText: "const x = 1;",
      similarity: 0.75,
      closestCandidate: "const y = 1;",
      closestLine: 5,
      context: "    4 | const y = 0;\n>    5 | const y = 1;",
      triedMatchers: ["exact match", "middle-out fuzzy match"],
    });
    expect(msg).toMatch(/75% similar/);
    expect(msg).toMatch(/line 5/);
    expect(msg).toMatch(/const y = 1/);
    expect(msg).toMatch(/exact match/);
    expect(msg).toMatch(/startLine hint/);
  });
});
