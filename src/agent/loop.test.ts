import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runLoop, lastAssistantText } from "../agent/loop.js";
import { noopSink } from "../agent/events.js";
import { createStatefulFauxProvider } from "../provider/faux.js";
import { getCoreTools } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
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

  it("runs independent tool calls in parallel", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const slowTool = (name: string): Tool<{ n: number }> => ({
      name,
      description: "slow noop",
      schema: z.object({ n: z.number() }),
      async execute() {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 40));
        concurrent -= 1;
        return { output: "ok" };
      },
    });

    const provider = createStatefulFauxProvider([
      {
        toolCalls: [
          { id: "tc1", name: "slow_a", arguments: { n: 1 } },
          { id: "tc2", name: "slow_b", arguments: { n: 2 } },
          { id: "tc3", name: "slow_c", arguments: { n: 3 } },
        ],
      },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    };

    await runLoop(ctx, noopSink, {
      provider,
      tools: [slowTool("slow_a"), slowTool("slow_b"), slowTool("slow_c")],
      model: "faux:test",
      approvalMode: "auto-accept",
      autoAcceptCli: true,
    });

    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("serializes concurrent edits on the same file", async () => {
    const dir = join(tmpdir(), `minicoder-parallel-${Date.now()}`);
    const filePath = join(dir, "counter.txt");
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, "0\n", "utf8");

    const editCounter: Tool<{ path: string; delta: number }> = {
      name: "edit",
      description: "increment counter file",
      schema: z.object({ path: z.string(), delta: z.number() }),
      async execute({ path, delta }, ctx) {
        const fullPath = join(ctx.cwd, path);
        const current = Number((await readFile(fullPath, "utf8")).trim());
        await new Promise((r) => setTimeout(r, 30));
        await writeFile(fullPath, `${current + delta}\n`, "utf8");
        return { output: String(current + delta) };
      },
    };

    const provider = createStatefulFauxProvider([
      {
        toolCalls: [
          { id: "tc1", name: "edit", arguments: { path: "counter.txt", delta: 1 } },
          { id: "tc2", name: "edit", arguments: { path: "counter.txt", delta: 1 } },
          { id: "tc3", name: "edit", arguments: { path: "counter.txt", delta: 1 } },
        ],
      },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: dir,
      messages: [{ role: "user", content: [{ type: "text", text: "increment" }] }],
    };

    await runLoop(ctx, noopSink, {
      provider,
      tools: [editCounter],
      model: "faux:test",
      approvalMode: "auto-accept",
      autoAcceptCli: true,
    });

    const final = Number((await readFile(filePath, "utf8")).trim());
    expect(final).toBe(3);
    await rm(dir, { recursive: true, force: true });
  });
});
