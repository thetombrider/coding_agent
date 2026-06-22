import { describe, it, expect } from "vitest";
import { toAiMessages } from "./stream.js";
import type { Message } from "../types.js";

describe("toAiMessages tool name resolution", () => {
  it("uses the name stored on the tool result block", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a" } }],
      },
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "tc1", toolName: "read", output: "contents" }],
      },
    ];

    const out = toAiMessages(messages);
    const toolMsg = out.find((m) => m.role === "tool");
    const part = (toolMsg?.content as Array<{ toolName: string }>)[0];
    expect(part.toolName).toBe("read");
  });

  it("preserves the tool name when the initiating assistant message was compacted away", () => {
    // Simulates a turn whose assistant tool-call message has been dropped by
    // compaction: the only remaining record of the name is on the result block.
    const messages: Message[] = [
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "tc1", toolName: "bash", output: "ok" }],
      },
    ];

    const out = toAiMessages(messages);
    const part = (out[0].content as Array<{ toolName: string }>)[0];
    expect(part.toolName).toBe("bash");
  });

  it("falls back to the assistant call map for legacy results without a stored name", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
      },
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "tc1", output: "contents" }],
      },
    ];

    const out = toAiMessages(messages);
    const toolMsg = out.find((m) => m.role === "tool");
    const part = (toolMsg?.content as Array<{ toolName: string }>)[0];
    expect(part.toolName).toBe("read");
  });

  it("falls back to 'unknown' when neither a stored name nor the assistant message exists", () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "tc1", output: "ok" }],
      },
    ];

    const out = toAiMessages(messages);
    const part = (out[0].content as Array<{ toolName: string }>)[0];
    expect(part.toolName).toBe("unknown");
  });
});
