import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { collectStreamEvents, normalizeToolInput, streamAssistant, toAiMessages } from "./stream.js";
import { createFauxProvider } from "./faux.js";
import type { Message } from "../types.js";
import type { StreamEvent } from "./types.js";

vi.mock("./registry.js", () => ({
  resolveActiveProvider: () => ({
    id: "faux",
    languageModel: () => ({}),
  }),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: vi.fn(() => ({
      fullStream: (async function* () {
        yield { type: "tool-input-start", id: "call_1", toolName: "write" };
        yield { type: "tool-input-delta", id: "call_1", delta: '{"path":"a.ts",' };
        yield { type: "tool-input-delta", id: "call_1", delta: '"content":"hello"}' };
        yield {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "write",
          input: { path: "a.ts", content: "hello" },
        };
      })(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      finishReason: Promise.resolve("tool-calls"),
    })),
  };
});

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

  it("falls back to 'unknown' for legacy tool results without a toolName field", () => {
    // Simulates pre-field log data read from JSON: the type requires toolName but
    // old persisted records never wrote it — JSON.parse silently omits the key.
    const messages = [
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "orphan", output: "x" }],
      },
    ] as unknown as Message[];

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

describe("normalizeToolInput", () => {
  it("returns parsed JSON for string input", () => {
    expect(normalizeToolInput('{"path":"a.ts"}')).toEqual({ value: { path: "a.ts" } });
  });

  it("returns empty object and error for malformed JSON strings", () => {
    const result = normalizeToolInput('{"path":');
    expect(result.value).toEqual({});
    expect(result.error).toMatch(/invalid JSON/);
  });

  it("returns empty object and error for missing input", () => {
    const result = normalizeToolInput(undefined);
    expect(result.value).toEqual({});
    expect(result.error).toBe("missing tool arguments");
  });

  it("passes through already-parsed objects", () => {
    const input = { path: "a.ts", content: "hello" };
    expect(normalizeToolInput(input)).toEqual({ value: input });
  });
});

describe("streamAssistant tool-input streaming", () => {
  it("emits tool_input_start then a running char count on each tool_input_delta", async () => {
    const delta1 = '{"path":"a.ts",';
    const delta2 = '"content":"hello"}';
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const events: StreamEvent[] = [];

    await streamAssistant(messages, { model: "faux:test" }, (e) => events.push(e));

    expect(events.map((e) => e.type)).toEqual([
      "tool_input_start",
      "tool_input_delta",
      "tool_input_delta",
      "tool_call_delta",
      "done",
    ]);
    expect(events[0]).toMatchObject({ type: "tool_input_start", id: "call_1", name: "write" });
    expect(events[1]).toMatchObject({
      type: "tool_input_delta",
      id: "call_1",
      name: "write",
      chars: delta1.length,
    });
    expect(events[2]).toMatchObject({
      type: "tool_input_delta",
      id: "call_1",
      name: "write",
      chars: delta1.length + delta2.length,
    });
  });
});

describe("streamAssistant malformed tool arguments", () => {
  it("does not throw when tool-call input is invalid JSON string", async () => {
    const { streamText } = await import("ai");
    vi.mocked(streamText).mockReturnValueOnce({
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "call_bad",
          toolName: "read",
          input: '{"path":',
        };
      })(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      finishReason: Promise.resolve("tool-calls"),
    } as never);

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const message = await streamAssistant(messages, { model: "faux:test" }, () => {});

    expect(message.content).toContainEqual({
      type: "toolCall",
      id: "call_bad",
      name: "read",
      arguments: {},
    });
    expect(message.content.some((c) => c.type === "text" && c.text.includes("malformed arguments"))).toBe(true);
  });

  it("does not throw when tool-call input is missing", async () => {
    const { streamText } = await import("ai");
    vi.mocked(streamText).mockReturnValueOnce({
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "call_empty",
          toolName: "read",
          input: undefined,
        };
      })(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      finishReason: Promise.resolve("tool-calls"),
    } as never);

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const message = await streamAssistant(messages, { model: "faux:test" }, () => {});

    expect(message.content).toContainEqual({
      type: "toolCall",
      id: "call_empty",
      name: "read",
      arguments: {},
    });
  });
});
