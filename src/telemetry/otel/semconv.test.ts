import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Message } from "../../types.js";
import type { CostBreakdown } from "../cost.js";
import {
  ratelGatewayToolAttributes,
  ratelResolutionAttributes,
  llmInputAttributes,
  llmOutputAttributes,
  llmRequestAttributes,
  llmResponseAttributes,
  llmSpanName,
  subagentInputAttributes,
  subagentOutputAttributes,
  subagentStartAttributes,
  toolEndAttributes,
  toolInputAttributes,
  toolOutputAttributes,
  toolStartAttributes,
  traceName,
} from "./semconv.js";

function breakdown(over: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    model: "m",
    usage: { input: 10, output: 5, totalTokens: 15 },
    costUsd: 0.001,
    pricingMissing: false,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheReadCostUsd: 0,
    cacheWriteCostUsd: 0,
    ...over,
  };
}

describe("semconv builders", () => {
  it("names the LLM span `chat {model}`", () => {
    expect(llmSpanName("anthropic/claude")).toBe("chat anthropic/claude");
  });

  it("builds request attributes and omits provider when absent", () => {
    expect(llmRequestAttributes({ requestModel: "m" })).toEqual({
      "openinference.span.kind": "LLM",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "m",
    });
    expect(llmRequestAttributes({ requestModel: "m", providerId: "openrouter" })["gen_ai.provider.name"]).toBe(
      "openrouter",
    );
  });

  it("builds response attributes with tokens, cost, and finish reasons", () => {
    const attrs = llmResponseAttributes({
      responseModel: "m",
      cost: breakdown({ usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18 }, costUsd: 0.002 }),
      finishReasons: ["stop"],
    });
    expect(attrs["gen_ai.response.model"]).toBe("m");
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(10);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(5);
    expect(attrs["gen_ai.usage.cache_read_tokens"]).toBe(2);
    expect(attrs["gen_ai.usage.cache_write_tokens"]).toBe(1);
    expect(attrs["gen_ai.usage.cost_usd"]).toBe(0.002);
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(attrs["pricing.missing"]).toBe(false);
  });

  it("omits cost when pricing is missing", () => {
    const attrs = llmResponseAttributes({
      responseModel: "m",
      cost: breakdown({ costUsd: null, pricingMissing: true }),
    });
    expect(attrs["pricing.missing"]).toBe(true);
    expect(attrs["gen_ai.usage.cost_usd"]).toBeUndefined();
    expect(attrs["gen_ai.response.finish_reasons"]).toBeUndefined();
  });

  it("builds tool attributes and counts output bytes", () => {
    expect(toolStartAttributes({ name: "read", callId: "t1" })).toEqual({
      "openinference.span.kind": "TOOL",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "read",
      "gen_ai.tool.call.id": "t1",
    });
    // "é" is two UTF-8 bytes — assert byte length, not char length.
    expect(toolEndAttributes({ ok: true, output: "é" })).toEqual({
      "orin.tool.ok": true,
      "orin.tool.output_bytes": 2,
    });
  });

  it("tags the subagent span as an AGENT", () => {
    expect(subagentStartAttributes({ agent: "explore" })["openinference.span.kind"]).toBe("AGENT");
  });
});

describe("traceName", () => {
  it("falls back to `turn` when there is no user text", () => {
    expect(traceName()).toBe("turn");
    expect(traceName("   ")).toBe("turn");
  });

  it("collapses whitespace to a single line", () => {
    expect(traceName("fix the\n  bug   now")).toBe("fix the bug now");
  });

  it("truncates long messages with an ellipsis", () => {
    const name = traceName("x".repeat(200));
    expect(name.length).toBe(80);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("content capture builders", () => {
  it("captures the LLM request as lossless JSON with system message and tool schemas", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    const attrs = llmInputAttributes({
      system: "You are helpful.",
      messages,
      tools: [{ name: "read", description: "Read a file", schema: z.object({ path: z.string() }) }],
    });
    expect(attrs["input.mime_type"]).toBe("application/json");
    const parsed = JSON.parse(attrs["input.value"] as string);
    expect(parsed.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(parsed.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(parsed.tools[0].name).toBe("read");
    // Tool schema is real JSON Schema, derivable by 7b into llm.tools.*.tool.json_schema.
    expect(parsed.tools[0].json_schema.type).toBe("object");
    expect(parsed.tools[0].json_schema.properties.path).toBeDefined();
  });

  it("captures assistant tool_calls as structured JSON, not stringified prose", () => {
    const message: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "let me read it" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
      ],
    };
    const attrs = llmOutputAttributes(message, "tool_calls");
    expect(attrs["output.mime_type"]).toBe("application/json");
    const parsed = JSON.parse(attrs["output.value"] as string);
    expect(parsed.role).toBe("assistant");
    expect(parsed.content).toBe("let me read it");
    expect(parsed.finish_reason).toBe("tool_calls");
    // Arguments stay a parsed object — the compatibility contract with 7b.
    expect(parsed.tool_calls).toEqual([{ id: "c1", name: "read", arguments: { path: "a.ts" } }]);
  });

  it("captures tool result messages structurally", () => {
    const message: Message = {
      role: "tool",
      content: [{ type: "toolResult", toolCallId: "c1", toolName: "read", output: "data", isError: true }],
    };
    const parsed = JSON.parse(llmOutputAttributes(message)["output.value"] as string);
    expect(parsed.tool_results).toEqual([
      { tool_call_id: "c1", tool_name: "read", output: "data", is_error: true },
    ]);
    expect(parsed.finish_reason).toBeUndefined();
  });

  it("serialises tool args as JSON and omits when undefined", () => {
    expect(toolInputAttributes({ path: "a.ts" })).toEqual({
      "input.value": '{"path":"a.ts"}',
      "input.mime_type": "application/json",
    });
    expect(toolInputAttributes(undefined)).toEqual({});
  });

  it("detects JSON vs plain-text tool output mime, keeping the value verbatim", () => {
    expect(toolOutputAttributes('{"ok":true}')).toEqual({
      "output.value": '{"ok":true}',
      "output.mime_type": "application/json",
    });
    expect(toolOutputAttributes("just text")).toEqual({
      "output.value": "just text",
      "output.mime_type": "text/plain",
    });
    // Looks like JSON but isn't — stays text/plain, value unchanged.
    expect(toolOutputAttributes("{not json")).toEqual({
      "output.value": "{not json",
      "output.mime_type": "text/plain",
    });
  });

  it("captures subagent prompt and summary as plain text", () => {
    expect(subagentInputAttributes("scan the repo")).toEqual({
      "input.value": "scan the repo",
      "input.mime_type": "text/plain",
    });
    expect(subagentOutputAttributes("found 3 files")).toEqual({
      "output.value": "found 3 files",
      "output.mime_type": "text/plain",
    });
  });
});

describe("ratel semconv", () => {
  it("maps pre-filter snapshot to OTel attributes", () => {
    const attrs = ratelResolutionAttributes({
      catalogSize: 22,
      injectedCount: 10,
      query: "grep TODO in src",
      topK: 5,
      hitCount: 5,
      topHitScore: 1.42,
      replaceMode: true,
      gatewayOrigin: "direct",
      featureFlag: "tool_pool=ratel",
      skillCatalogSize: 2,
      injectedToolNames: ["read", "grep"],
    });
    expect(attrs["ratel.replace_mode"]).toBe(true);
    expect(attrs["feature_flag"]).toBe("tool_pool=ratel");
    expect(attrs["ratel.query"]).toBe("grep TODO in src");
  });

  it("tags gateway tool spans with agent origin", () => {
    expect(ratelGatewayToolAttributes()).toEqual({ "ratel.gateway_origin": "agent" });
  });
});
