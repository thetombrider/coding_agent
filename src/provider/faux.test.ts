import { describe, expect, it } from "vitest";
import { collectStreamEvents } from "../provider/stream.js";
import { createFauxProvider, fauxOneShot } from "../provider/faux.js";
import type { Message } from "../types.js";

describe("faux provider", () => {
  it("streams text in chunks and assembles a final message", async () => {
    const provider = fauxOneShot("Hello, world!");
    const { events, message } = await collectStreamEvents(
      provider,
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "faux:test" },
    );

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    expect(
      message.content
        .filter((c) => c.type === "text")
        .map((c) => (c.type === "text" ? c.text : ""))
        .join(""),
    ).toBe("Hello, world!");
  });

  it("streams reasoning chunks before visible text", async () => {
    const provider = createFauxProvider({
      reasoning: ["Let me ", "check deps."],
      text: ["Two runtime deps."],
    });
    const { events, message } = await collectStreamEvents(
      provider,
      [{ role: "user", content: [{ type: "text", text: "what deps?" }] }],
      { model: "faux:test" },
    );

    expect(events.filter((e) => e.type === "reasoning_delta").map((e) => e.text)).toEqual([
      "Let me ",
      "check deps.",
    ]);
    const reasoning = message.content.find((c) => c.type === "reasoning");
    expect(reasoning).toMatchObject({ type: "reasoning", text: "Let me check deps." });
    const text = message.content.find((c) => c.type === "text");
    expect(text).toMatchObject({ type: "text", text: "Two runtime deps." });
  });

  it("emits tool calls when scripted", async () => {
    const provider = createFauxProvider({
      text: ["Checking"],
      toolCalls: [{ id: "tc1", name: "read", arguments: { path: "package.json" } }],
    });

    const { message } = await collectStreamEvents(
      provider,
      [] as Message[],
      { model: "faux:test" },
    );

    const toolCall = message.content.find((c) => c.type === "toolCall");
    expect(toolCall).toMatchObject({ name: "read", id: "tc1" });
  });

  it("parses XML tool calls embedded in assistant text", async () => {
    const provider = createFauxProvider({
      text: ['<tool_call name="read"><path>package.json</path></tool_call>'],
    });

    const { message } = await collectStreamEvents(
      provider,
      [] as Message[],
      { model: "faux:test", tools: {} },
    );

    const toolCall = message.content.find((c) => c.type === "toolCall");
    expect(toolCall).toMatchObject({
      name: "read",
      arguments: { path: "package.json" },
    });
  });
});
