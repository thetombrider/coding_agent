import { describe, expect, it } from "vitest";
import type { CostBreakdown } from "../cost.js";
import {
  llmRequestAttributes,
  llmResponseAttributes,
  llmSpanName,
  toolEndAttributes,
  toolStartAttributes,
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
});
