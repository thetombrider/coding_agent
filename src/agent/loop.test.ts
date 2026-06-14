import { describe, expect, it } from "vitest";
import { runLoop, lastAssistantText } from "../agent/loop.js";
import { noopSink } from "../agent/events.js";
import { createStatefulFauxProvider } from "../provider/faux.js";
import { getCoreTools } from "../tools/registry.js";
import type { AgentContext } from "../types.js";

describe("runLoop", () => {
  it("executes read then completes on second turn", async () => {
    const provider = createStatefulFauxProvider([
      {
        toolCalls: [{ id: "tc1", name: "read", arguments: { path: "package.json" } }],
      },
      { text: ["Your package.json has 2 dependencies."] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "what's in package.json and how many deps?" }],
        },
      ],
    };

    const result = await runLoop(ctx, noopSink, {
      provider,
      tools: getCoreTools().filter((t) => t.name === "read"),
      model: "faux:test",
      approvalMode: "auto-accept",
      autoAcceptCli: true,
    });

    expect(result.messages.some((m) => m.role === "tool")).toBe(true);
    expect(lastAssistantText(result)).toContain("2 dependencies");
  });
});
