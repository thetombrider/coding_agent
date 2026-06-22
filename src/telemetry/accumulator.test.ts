import { describe, expect, it } from "vitest";
import { SessionCostAccumulator } from "./accumulator.js";
import type { Usage } from "../provider/types.js";

const turn = (usage: Usage, costUsd: number | null = null) => ({
  model: "anthropic/claude-opus-4.8",
  usage,
  costUsd,
  pricingMissing: costUsd === null,
});

describe("SessionCostAccumulator context tokens", () => {
  it("reports the latest main-loop prompt (input + cache) as context fill", () => {
    const acc = new SessionCostAccumulator("s1");
    acc.recordTurn(turn({ input: 1000, output: 50, cacheRead: 200, cacheWrite: 100, totalTokens: 1350 }), "main_loop");

    // input + cacheRead + cacheWrite, not the cumulative total.
    expect(acc.snapshot().contextTokens).toBe(1300);
  });

  it("replaces the reading each main-loop turn so it can fall after compaction", () => {
    const acc = new SessionCostAccumulator("s1");
    acc.recordTurn(turn({ input: 5000, output: 10, totalTokens: 5010 }), "main_loop");
    expect(acc.snapshot().contextTokens).toBe(5000);

    // A smaller prompt (e.g. post-compaction) lowers the gauge even though the
    // cumulative token total keeps climbing.
    acc.recordTurn(turn({ input: 1200, output: 10, totalTokens: 1210 }), "main_loop");
    expect(acc.snapshot().contextTokens).toBe(1200);
    expect(acc.snapshot().tokens.totalTokens).toBe(6220);
  });

  it("ignores subagent and side-path calls that run on their own context", () => {
    const acc = new SessionCostAccumulator("s1");
    acc.recordTurn(turn({ input: 4000, output: 10, totalTokens: 4010 }), "main_loop");
    acc.recordTurn(turn({ input: 9000, output: 10, totalTokens: 9010 }), "subagent");
    acc.recordTurn(turn({ input: 8000, output: 10, totalTokens: 8010 }), "compaction");

    expect(acc.snapshot().contextTokens).toBe(4000);
  });

  it("is zero before any main-loop turn lands", () => {
    expect(new SessionCostAccumulator("s1").snapshot().contextTokens).toBe(0);
  });
});
