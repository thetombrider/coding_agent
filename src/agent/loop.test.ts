import { describe, expect, it } from "vitest";
import { runLoop, lastAssistantText } from "../agent/loop.js";
import { noopSink } from "../agent/events.js";
import { createStatefulFauxProvider } from "../provider/faux.js";
import { getCoreTools } from "../tools/registry.js";
import type { AgentContext, SessionEvent } from "../types.js";

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

  it("calls onEvent with assistant_chunk and tool_result for each message pushed", async () => {
    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "tc1", name: "read", arguments: { path: "package.json" } }] },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    };

    const events: SessionEvent[] = [];
    await runLoop(ctx, noopSink, {
      provider,
      tools: getCoreTools().filter((t) => t.name === "read"),
      model: "faux:test",
      approvalMode: "auto-accept",
      autoAcceptCli: true,
      onEvent: (ev) => events.push(ev),
    });

    const types = events.map((e) => e.type);
    // First assistant response includes a tool call
    expect(types).toContain("assistant_chunk");
    // Tool result from the read call
    expect(types).toContain("tool_result");
    // Second assistant response (the final "done" text)
    expect(types.filter((t) => t === "assistant_chunk")).toHaveLength(2);
    expect(types.filter((t) => t === "tool_result")).toHaveLength(1);
  });

  it("onEvent is optional — loop runs normally without it", async () => {
    const provider = createStatefulFauxProvider([{ text: ["hello"] }]);
    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    await expect(runLoop(ctx, noopSink, { provider, tools: [], model: "faux:test" })).resolves.toBeDefined();
  });
});
