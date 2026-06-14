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
});
