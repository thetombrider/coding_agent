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
    content: [{ type: "toolResult", toolCallId: id, toolName: "bash", output }],
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

  it("summariseOldTurns uses multi-pass chunking when corpus exceeds cheap model window", async () => {
    // 8 turns, keepLastN=2 → 6 turns to summarise.
    // Each turn is ~100 chars; cheapWindow=100 tokens means each individual message
    // already overflows a single pass, so chunking must fire and call generate multiple times.
    const messages: Message[] = Array.from({ length: 8 }, (_, i) => [
      user(`turn ${i + 1} ${"x".repeat(100)}`),
      assistant("reply"),
    ]).flat();

    const calls: string[] = [];
    const result = await summariseOldTurns(
      messages,
      "cheap:test",
      2,
      async ({ messages: msgs }) => {
        calls.push(msgs[0]!.content);
        return { text: `chunk-summary-${calls.length}` };
      },
      undefined,
      100, // tiny cheap window forces multi-pass
    );

    expect(calls.length).toBeGreaterThan(1); // multiple generate calls
    expect(result[0]?.role).toBe("assistant");
    // Combined summary contains output from each chunk
    const summaryText = result[0]?.content[0]?.type === "text" ? result[0].content[0].text : "";
    expect(summaryText).toContain("chunk-summary-1");
    expect(summaryText).toContain("chunk-summary-2");
    // Recent turns preserved verbatim
    expect(result.slice(1)).toEqual(messages.slice(-4));
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

  it("summariseOldMessages uses multi-pass chunking when corpus exceeds cheap model window", async () => {
    const big = "x".repeat(400);
    const messages: Message[] = [
      user("investigate"),
      assistant("read spec"),
      toolResult(big, "t1"),
      assistant("read readme"),
      toolResult(big, "t2"),
    ];

    const calls: string[] = [];
    const result = await summariseOldMessages(
      messages,
      "cheap:test",
      1,
      async () => {
        calls.push("generate");
        return { text: `part-${calls.length}` };
      },
      undefined,
      50, // tiny cheap window forces chunking
    );

    expect(calls.length).toBeGreaterThan(1);
    expect(result[0]?.role).toBe("assistant");
    const text = result[0]?.content[0]?.type === "text" ? result[0].content[0].text : "";
    expect(text).toContain("part-1");
    expect(text).toContain("part-2");
  });

  it("summariseOldTurns uses originalMessages for corpus instead of elided stubs", async () => {
    const realOutput = "real file content with useful information";
    const elidedOutput = "[result elided — 1 lines. Re-run tool if needed.]";

    const originalMessages: Message[] = [
      user("turn 1"),
      assistant("read file"),
      toolResult(realOutput, "t1"),
      user("turn 2"),
      assistant("done"),
      user("turn 3"),
      assistant("finished"),
    ];

    const elidedMessages: Message[] = [
      user("turn 1"),
      assistant("read file"),
      toolResult(elidedOutput, "t1"),
      user("turn 2"),
      assistant("done"),
      user("turn 3"),
      assistant("finished"),
    ];

    let capturedCorpus = "";
    await summariseOldTurns(
      elidedMessages,
      "cheap:test",
      2,
      async ({ messages: genMessages }) => {
        capturedCorpus = genMessages[0]?.content ?? "";
        return { text: "summary" };
      },
      undefined,
      undefined,
      originalMessages,
    );

    expect(capturedCorpus).toContain(realOutput);
    expect(capturedCorpus).not.toContain(elidedOutput);
  });

  it("summariseOldMessages uses originalMessages for corpus instead of elided stubs", async () => {
    const realOutput = "real file content with useful information";
    const elidedOutput = "[result elided — 1 lines. Re-run tool if needed.]";

    const originalMessages: Message[] = [
      user("investigate"),
      assistant("read file"),
      toolResult(realOutput, "t1"),
      assistant("done"),
    ];

    const elidedMessages: Message[] = [
      user("investigate"),
      assistant("read file"),
      toolResult(elidedOutput, "t1"),
      assistant("done"),
    ];

    let capturedCorpus = "";
    await summariseOldMessages(
      elidedMessages,
      "cheap:test",
      1,
      async ({ messages: genMessages }) => {
        capturedCorpus = genMessages[0]?.content ?? "";
        return { text: "summary" };
      },
      undefined,
      undefined,
      originalMessages,
    );

    expect(capturedCorpus).toContain(realOutput);
    expect(capturedCorpus).not.toContain(elidedOutput);
  });

  it("retries summariseOldMessages with a smaller keepRecent when the first pass leaves context oversized", async () => {
    // Single user turn so summariseOldTurns is a no-op (prefixTurnCount(1, 20) = 0).
    // generate returns a large summary (~465 tokens) so that summary + recent messages
    // still exceeds the 85% threshold after the first pass; the second pass uses half
    // the keepRecent budget, keeps fewer recent messages, and fits under the threshold.
    const contextWindow = 1000; // 85% = 850 tokens
    // keepRecent pass 1 = scaleToWindow(20000, 1000, 0.4) = 400 → ~630 token recent slice
    // Large summary (~465 tokens) + 630 recent ≈ 1095 > 850 → loop continues
    // keepRecent pass 2 = 200 → ~315 token recent slice
    // Large summary (~465 tokens) + 315 ≈ 780 < 850 → fits

    const messages: Message[] = [
      user("O".repeat(800)),
      assistant("A".repeat(1200)),
      assistant("B".repeat(1200)),
      assistant("C".repeat(1200)),
    ];
    expect(shouldCompact(messages, contextWindow)).toBe(true);

    let callCount = 0;
    const largeSummaryText = "S".repeat(1800);
    const generate: SummariseGenerate = async () => {
      callCount++;
      return { text: largeSummaryText };
    };

    const result = await compactMessages(messages, "cheap:test", contextWindow, 20, generate);

    expect(callCount).toBeGreaterThan(1);
    expect(shouldCompact(result, contextWindow)).toBe(false);
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
