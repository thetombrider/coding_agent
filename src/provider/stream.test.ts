import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { collectStreamEvents, toAiMessages } from "./stream.js";
import { createFauxProvider } from "./faux.js";
import type { Message } from "../types.js";

describe("toAiMessages", () => {
  it("converts a plain user message to a string-content message", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    expect(toAiMessages(messages)).toEqual([{ role: "user", content: "hello" }]);
  });

  it("concatenates multiple text blocks for non-assistant roles", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "foo" }, { type: "text", text: "bar" }] },
    ];
    expect(toAiMessages(messages)).toEqual([{ role: "user", content: "foobar" }]);
  });

  it("maps assistant text and tool calls into structured parts", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
        ],
      },
    ];

    const result = toAiMessages(messages);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "a.ts" } },
        ],
      },
    ]);
  });

  it("drops assistant reasoning blocks (not sent back to the model)", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking..." },
          { type: "text", text: "answer" },
        ],
      },
    ];

    const [assistant] = toAiMessages(messages) as [Extract<ModelMessage, { role: "assistant" }>];
    expect(assistant.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("resolves tool result names from the preceding assistant tool call", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_42", name: "bash", arguments: { command: "ls" } }],
      },
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "call_42", output: "file.txt" }],
      },
    ];

    const result = toAiMessages(messages);
    expect(result[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_42",
          toolName: "bash",
          output: { type: "text", value: "file.txt" },
        },
      ],
    });
  });

  it("falls back to 'unknown' tool name when no matching call exists", () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "orphan", output: "x" }],
      },
    ];

    const result = toAiMessages(messages) as [Extract<ModelMessage, { role: "tool" }>];
    expect(result[0].content[0]).toMatchObject({ toolName: "unknown" });
  });
});

describe("collectStreamEvents", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  const options = { model: "faux:test" };

  it("collects deltas in order: reasoning, text, tool call, done", async () => {
    const provider = createFauxProvider({
      reasoning: ["thinking "],
      text: ["hello ", "world"],
      toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.ts" } }],
    });

    const { events, message } = await collectStreamEvents(provider, messages, options);

    expect(events.map((e) => e.type)).toEqual([
      "reasoning_delta",
      "text_delta",
      "text_delta",
      "tool_call_delta",
      "done",
    ]);

    const toolEvent = events.find((e) => e.type === "tool_call_delta");
    expect(toolEvent).toMatchObject({ id: "c1", name: "read", argumentsDelta: '{"path":"a.ts"}' });

    const doneEvent = events.at(-1);
    expect(doneEvent).toMatchObject({ type: "done" });
    expect(message.content).toContainEqual({ type: "text", text: "hello world" });
    expect(message.stopReason).toBe("tool_calls");
  });

  it("returns the same message that the done event carries", async () => {
    const provider = createFauxProvider({ text: ["answer"] });
    const { events, message } = await collectStreamEvents(provider, messages, options);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.message).toBe(message);
  });

  it("emits only text and done when there are no tool calls", async () => {
    const provider = createFauxProvider({ text: ["just text"] });
    const { events, message } = await collectStreamEvents(provider, messages, options);

    expect(events.map((e) => e.type)).toEqual(["text_delta", "done"]);
    expect(message.stopReason).toBe("stop");
  });
});
