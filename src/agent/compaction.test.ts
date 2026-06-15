import { describe, expect, it } from "vitest";
import type { Message } from "../types.js";
import {
  currentTurnCount,
  estimateMessageTokens,
  evictStaleToolResults,
  shouldCompact,
  summariseOldTurns,
} from "./compaction.js";

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResult(output: string, id = "tc1"): Message {
  return {
    role: "tool",
    content: [{ type: "toolResult", toolCallId: id, output }],
  };
}

function largeOutput(lines: number): string {
  const line = "x".repeat(30);
  return Array.from({ length: lines }, () => line).join("\n");
}

describe("compaction", () => {
  it("estimates tokens from serialized message size", () => {
    const messages = [user("hello")];
    expect(estimateMessageTokens(messages)).toBeGreaterThan(0);
  });

  it("shouldCompact triggers above 85% of the context window", () => {
    const messages = [user("x".repeat(4000))];
    expect(shouldCompact(messages, 1000)).toBe(true);
    expect(shouldCompact(messages, 100000)).toBe(false);
  });

  it("evicts large tool results from turns older than keepLastK", () => {
    const big = largeOutput(400);
    const messages: Message[] = [
      user("turn 1"),
      assistant("working"),
      toolResult(big, "t1"),
      user("turn 2"),
      assistant("working"),
      toolResult(big, "t2"),
      user("turn 3"),
      assistant("working"),
      toolResult(big, "t3"),
      user("turn 4"),
      assistant("working"),
      toolResult(big, "t4"),
      user("turn 5"),
      assistant("working"),
      toolResult(big, "t5"),
    ];

    const compacted = evictStaleToolResults(messages, currentTurnCount(messages), 3);
    const outputs = compacted
      .filter((m) => m.role === "tool")
      .map((m) => m.content[0])
      .filter((c) => c.type === "toolResult")
      .map((c) => c.output);

    expect(outputs[0]).toContain("[result elided — 400 lines");
    expect(outputs[1]).toContain("[result elided — 400 lines");
    expect(outputs[2]).toBe(big);
    expect(outputs[3]).toBe(big);
    expect(outputs[4]).toBe(big);
  });

  it("keeps small stale tool results intact", () => {
    const messages: Message[] = [
      user("turn 1"),
      toolResult("ok", "t1"),
      user("turn 2"),
      toolResult("ok", "t2"),
      user("turn 3"),
      toolResult("ok", "t3"),
      user("turn 4"),
      toolResult("ok", "t4"),
    ];

    const compacted = evictStaleToolResults(messages, currentTurnCount(messages), 3);
    const first = compacted.find((m) => m.role === "tool")?.content[0];
    expect(first?.type === "toolResult" ? first.output : "").toBe("ok");
  });

  it("summarises old turns and keeps recent turns verbatim", async () => {
    const messages: Message[] = [
      user("turn 1"),
      assistant("read package.json"),
      user("turn 2"),
      assistant("edited file"),
      user("turn 3"),
      assistant("ran tests"),
      user("turn 4"),
      assistant("done"),
    ];

    const result = await summariseOldTurns(
      messages,
      "cheap:test",
      2,
      async () => ({ text: "[Session summary — turns 1–2]\n\nSummary body" }),
    );

    expect(result).toHaveLength(5);
    expect(result[0]?.role).toBe("assistant");
    expect(result[0]?.content[0]?.type === "text" ? result[0].content[0].text : "").toContain(
      "Session summary",
    );
    expect(result.slice(1)).toEqual(messages.slice(4));
  });
});
