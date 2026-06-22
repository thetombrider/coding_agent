import { describe, expect, it } from "vitest";
import { SessionCostAccumulator } from "./accumulator.js";
import type { Usage } from "../provider/types.js";

const usage = (over: Partial<Usage> = {}): Usage => ({
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  ...over,
});

const turn = (u: Usage, costUsd: number | null = null) => ({
  model: "anthropic/claude-opus-4.8",
  usage: u,
  costUsd,
  pricingMissing: costUsd === null,
});

describe("SessionCostAccumulator", () => {
  it("starts empty with a null cost", () => {
    const acc = new SessionCostAccumulator("s1");
    const snap = acc.snapshot();
    expect(snap.sessionId).toBe("s1");
    expect(snap.turns).toBe(0);
    expect(snap.costUsd).toBeNull();
    expect(snap.pricingMissing).toBe(false);
    expect(snap.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
  });

  it("sums tokens and cost across turns", () => {
    const acc = new SessionCostAccumulator("s1");
    acc.recordTurn({ model: "m", usage: usage(), costUsd: 0.01, pricingMissing: false }, "main_loop");
    acc.recordTurn({ model: "m", usage: usage(), costUsd: 0.02, pricingMissing: false }, "main_loop");

    const snap = acc.snapshot();
    expect(snap.turns).toBe(2);
    expect(snap.costUsd).toBeCloseTo(0.03);
    expect(snap.tokens.input).toBe(200);
    expect(snap.tokens.output).toBe(100);
    expect(snap.tokens.totalTokens).toBe(300);
  });

  it("keeps cost null when all calls are unpriced but tracks tokens", () => {
    const acc = new SessionCostAccumulator("s1");
    acc.recordTurn({ model: "m", usage: usage(), costUsd: null, pricingMissing: true }, "main_loop");

    const snap = acc.snapshot();
    expect(snap.costUsd).toBeNull();
    expect(snap.pricingMissing).toBe(true);
    expect(snap.tokens.input).toBe(100);
  });

  it("reports a cost as soon as one priced call lands among unpriced ones", () => {
    const acc = new SessionCostAccumulator("s1");
    acc.recordTurn({ model: "free", usage: usage(), costUsd: null, pricingMissing: true }, "main_loop");
    acc.recordTurn({ model: "paid", usage: usage(), costUsd: 0.05, pricingMissing: false }, "main_loop");

    const snap = acc.snapshot();
    expect(snap.costUsd).toBeCloseTo(0.05);
    expect(snap.pricingMissing).toBe(true);
  });

  it("accumulates cache token counts", () => {
    const acc = new SessionCostAccumulator("s1");
    acc.recordTurn(
      { model: "m", usage: usage({ cacheRead: 10, cacheWrite: 5 }), costUsd: 0, pricingMissing: false },
      "main_loop",
    );
    const snap = acc.snapshot();
    expect(snap.tokens.cacheRead).toBe(10);
    expect(snap.tokens.cacheWrite).toBe(5);
  });

  it("builds a per-model usage mix", () => {
    const acc = new SessionCostAccumulator("s1");
    acc.recordTurn({ model: "a", usage: usage(), costUsd: 0.01, pricingMissing: false }, "main_loop");
    acc.recordTurn({ model: "a", usage: usage(), costUsd: 0.01, pricingMissing: false }, "main_loop");
    acc.recordTurn({ model: "b", usage: usage(), costUsd: null, pricingMissing: true }, "subagent");

    const { modelMix } = acc.snapshot();
    expect(modelMix.a?.turns).toBe(2);
    expect(modelMix.a?.costUsd).toBeCloseTo(0.02);
    expect(modelMix.b?.turns).toBe(1);
    expect(modelMix.b?.costUsd).toBeNull();
  });

  it("counts turns per source", () => {
    const acc = new SessionCostAccumulator("s1");
    acc.recordTurn({ model: "m", usage: usage(), costUsd: 0, pricingMissing: false }, "main_loop");
    acc.recordTurn({ model: "m", usage: usage(), costUsd: 0, pricingMissing: false }, "main_loop");
    acc.recordTurn({ model: "m", usage: usage(), costUsd: 0, pricingMissing: false }, "compaction");

    expect(acc.snapshot().sourceMix).toEqual({ main_loop: 2, compaction: 1 });
  });

  it("finalize adds durationMs and reason to the snapshot", () => {
    const acc = new SessionCostAccumulator("s1");
    acc.recordTurn({ model: "m", usage: usage(), costUsd: 0.01, pricingMissing: false }, "main_loop");

    const summary = acc.finalize(1234, "exit");
    expect(summary.durationMs).toBe(1234);
    expect(summary.reason).toBe("exit");
    expect(summary.turns).toBe(1);
    expect(summary.costUsd).toBeCloseTo(0.01);
  });

  it("snapshot returns independent copies (no shared mutable state)", () => {
    const acc = new SessionCostAccumulator("s1");
    acc.recordTurn({ model: "m", usage: usage(), costUsd: 0.01, pricingMissing: false }, "main_loop");
    const first = acc.snapshot();
    acc.recordTurn({ model: "m", usage: usage(), costUsd: 0.01, pricingMissing: false }, "main_loop");

    expect(first.turns).toBe(1);
    expect(first.tokens.input).toBe(100);
  });
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
