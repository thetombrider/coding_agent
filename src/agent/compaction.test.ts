import { describe, expect, it } from "vitest";
import type { Message } from "../types.js";
import {
  capOversizedToolResults,
  compactMessages,
  currentTurnCount,
  estimateMessageTokens,
  evictStaleToolResults,
  findMessageCutIndex,
  pruneOverflowToolResults,
  shouldCompact,
  stripReasoningBlocks,
  summariseOldMessages,
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

  it("strips reasoning blocks from assistant messages", () => {
    const messages: Message[] = [
      user("go"),
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "long internal chain of thought" },
          { type: "text", text: "visible reply" },
        ],
      },
    ];

    const stripped = stripReasoningBlocks(messages);
    expect(stripped[1]?.content).toEqual([{ type: "text", text: "visible reply" }]);
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

  it("records the compaction LLM call with its source and normalized tokens", async () => {
    const messages: Message[] = [
      user("turn 1"),
      assistant("a"),
      user("turn 2"),
      assistant("b"),
      user("turn 3"),
      assistant("c"),
    ];

    const calls: Array<{ model: string; usage: unknown; source: string }> = [];
    await summariseOldTurns(
      messages,
      "cheap:test",
      2,
      async () => ({
        text: "summary",
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      }),
      (call) => calls.push(call),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe("compaction");
    expect(calls[0]?.model).toBe("cheap:test");
    expect(calls[0]?.usage).toMatchObject({ input: 120, output: 30, totalTokens: 150 });
  });

  it("skips recording when the generate result has no usage", async () => {
    const messages: Message[] = [
      user("turn 1"),
      assistant("a"),
      user("turn 2"),
      assistant("b"),
      user("turn 3"),
      assistant("c"),
    ];

    const calls: unknown[] = [];
    await summariseOldTurns(
      messages,
      "cheap:test",
      2,
      async () => ({ text: "summary" }),
      (call) => calls.push(call),
    );

    expect(calls).toHaveLength(0);
  });

  it("caps a single oversized tool result within one user turn", () => {
    const huge = "x".repeat(16_000 * 4 + 1000);
    const messages: Message[] = [
      user("investigate"),
      assistant("grep"),
      toolResult(huge, "t1"),
    ];
    const contextWindow = 1000;

    const compacted = capOversizedToolResults(messages, contextWindow);
    const output = compacted[2]?.content[0];
    expect(output?.type === "toolResult" ? output.output : "").toContain("[result elided");
    expect(shouldCompact(compacted, contextWindow)).toBe(false);
  });

  it("prunes older tool output within a single user turn when over threshold", () => {
    const big = "x".repeat(20_000 * 4);
    const messages: Message[] = [
      user("one turn"),
      assistant("first"),
      toolResult(big, "t1"),
      assistant("second"),
      toolResult(big, "t2"),
      assistant("third"),
      toolResult(big, "t3"),
    ];
    const contextWindow = Math.floor(estimateMessageTokens(messages) * 0.9);

    const compacted = pruneOverflowToolResults(messages, contextWindow);
    const outputs = compacted
      .filter((m) => m.role === "tool")
      .map((m) => m.content[0])
      .filter((c) => c.type === "toolResult")
      .map((c) => c.output);

    expect(outputs[0]).toContain("[result elided");
    expect(outputs[outputs.length - 1]).toBe(big);
  });

  it("prunes tool output on a small window the absolute budget would have spared", () => {
    // Four ~3.5k-token results (14k total) sit under the absolute 40k protect
    // budget, so the old constant pruned nothing. On a small 16k window the
    // window-relative protect (~8k) forces the older results to be elided while
    // the most recent stays intact — this is what keeps small-window explore
    // subagents under the limit instead of erroring (#183).
    const chunk = "x".repeat(3_500 * 4);
    const messages: Message[] = [
      user("one turn"),
      assistant("first"),
      toolResult(chunk, "t1"),
      assistant("second"),
      toolResult(chunk, "t2"),
      assistant("third"),
      toolResult(chunk, "t3"),
      assistant("fourth"),
      toolResult(chunk, "t4"),
    ];
    const contextWindow = 16_000;

    const compacted = pruneOverflowToolResults(messages, contextWindow);
    const outputs = compacted
      .filter((m) => m.role === "tool")
      .map((m) => m.content[0])
      .filter((c) => c.type === "toolResult")
      .map((c) => c.output);

    expect(outputs[0]).toContain("[result elided");
    expect(outputs[outputs.length - 1]).toBe(chunk);
  });

  it("truncates large tool results in the summarisation corpus but keeps recent turns intact", async () => {
    // ~5k tokens * 4 chars/token = 20k chars; build something clearly over that
    const hugeOutput = "x".repeat(20_001) + "\n" + "y".repeat(100);
    const messages: Message[] = [
      user("turn 1"),
      assistant("read big file"),
      toolResult(hugeOutput, "t1"),
      user("turn 2"),
      assistant("analysed"),
      user("turn 3"),
      assistant("done"),
    ];

    let capturedCorpus = "";
    await summariseOldTurns(
      messages,
      "cheap:test",
      2,
      async ({ messages: genMessages }) => {
        capturedCorpus = genMessages[0]?.content ?? "";
        return { text: "summary" };
      },
    );

    expect(capturedCorpus).toContain("[truncated for summary");
    // The truncation note should report the total line count of the original output
    expect(capturedCorpus).toContain("2 lines total");
    // The huge output should not appear verbatim in the corpus
    expect(capturedCorpus).not.toContain(hugeOutput);
  });

  it("does not truncate small tool results in the summarisation corpus", async () => {
    const smallOutput = "short output";
    const messages: Message[] = [
      user("turn 1"),
      assistant("read file"),
      toolResult(smallOutput, "t1"),
      user("turn 2"),
      assistant("done"),
      user("turn 3"),
      assistant("finished"),
    ];

    let capturedCorpus = "";
    await summariseOldTurns(
      messages,
      "cheap:test",
      2,
      async ({ messages: genMessages }) => {
        capturedCorpus = genMessages[0]?.content ?? "";
        return { text: "summary" };
      },
    );

    expect(capturedCorpus).toContain(smallOutput);
    expect(capturedCorpus).not.toContain("[truncated for summary");
  });

  it("finds a message cut index that preserves recent context", () => {
    const messages: Message[] = [
      user("old"),
      assistant("a"),
      user("recent"),
      assistant("b"),
    ];
    const cut = findMessageCutIndex(messages, estimateMessageTokens(messages.slice(2)));
    expect(cut).toBe(2);
    expect(messages.slice(cut).every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });

  it("summarises old messages within a single user turn", async () => {
    const messages: Message[] = [
      user("investigate"),
      assistant("read spec"),
      toolResult("spec body", "t1"),
      assistant("read readme"),
      toolResult("readme body", "t2"),
    ];

    const result = await summariseOldMessages(
      messages,
      "cheap:test",
      1,
      async () => ({ text: "[Session summary]\n\nInvestigated docs" }),
    );

    expect(result[0]?.role).toBe("assistant");
    expect(result.some((m) => m.role === "tool" && m.content[0]?.type === "toolResult")).toBe(true);
  });

  it("summariseOldTurns returns original messages when generate throws", async () => {
    const messages: Message[] = [
      user("turn 1"),
      assistant("a"),
      user("turn 2"),
      assistant("b"),
      user("turn 3"),
      assistant("c"),
    ];

    const result = await summariseOldTurns(
      messages,
      "cheap:test",
      2,
      async () => { throw new Error("rate limit"); },
    );

    expect(result).toBe(messages);
  });

  it("summariseOldMessages returns original messages when generate throws", async () => {
    const messages: Message[] = [
      user("investigate"),
      assistant("read spec"),
      toolResult("spec body", "t1"),
      assistant("read readme"),
      toolResult("readme body", "t2"),
    ];

    const result = await summariseOldMessages(
      messages,
      "cheap:test",
      1,
      async () => { throw new Error("context overflow"); },
    );

    expect(result).toBe(messages);
  });

  it("compactMessages shrinks a single-turn session without summarising when pruning suffices", async () => {
    const huge = "line\n".repeat(50_000);
    const messages: Message[] = [
      user("investigate"),
      assistant("grep"),
      toolResult(huge, "t1"),
    ];
    const contextWindow = Math.floor(estimateMessageTokens(messages) * 0.9);

    const result = await compactMessages(messages, "cheap:test", contextWindow);
    expect(result).toHaveLength(3);
    expect(result[2]?.content[0]?.type === "toolResult" ? result[2].content[0].output : "").toContain(
      "[result elided",
    );
    expect(shouldCompact(result, contextWindow)).toBe(false);
  });
});
