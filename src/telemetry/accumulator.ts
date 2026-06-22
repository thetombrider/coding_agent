import type { CostBreakdown } from "./cost.js";
import type {
  ModelUsage,
  SessionCostSnapshot,
  SessionCostSummary,
  TurnSource,
} from "./events.js";

/**
 * In-process running totals for one session: cost, token counts, per-model and
 * per-source mix. Fed one `CostBreakdown` per LLM call via `recordTurn`.
 */
export class SessionCostAccumulator {
  readonly sessionId: string;

  private turns = 0;
  private costUsd = 0;
  /** True once any priced call has contributed — keeps `costUsd` `null` until then. */
  private hasCost = false;
  private pricingMissing = false;
  private readonly tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  /** Input-side tokens of the most recent main-loop turn — the live context fill. */
  private lastContextTokens = 0;
  private readonly modelMix = new Map<string, ModelUsage>();
  private readonly sourceMix = new Map<TurnSource, number>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Fold one LLM call into the totals. Accepts a full {@link CostBreakdown} (the
   * live path) or the slimmer shape persisted in a `turn` metric event, so
   * `rebuildSessionCost` can replay a session log straight back into an accumulator.
   */
  recordTurn(
    breakdown: Pick<CostBreakdown, "model" | "usage" | "costUsd" | "pricingMissing">,
    source: TurnSource,
  ): void {
    const { model, usage, costUsd, pricingMissing } = breakdown;
    this.turns += 1;

    if (pricingMissing) this.pricingMissing = true;
    if (costUsd !== null) {
      this.costUsd += costUsd;
      this.hasCost = true;
    }

    this.tokens.input += usage.input;
    this.tokens.output += usage.output;
    this.tokens.cacheRead += usage.cacheRead ?? 0;
    this.tokens.cacheWrite += usage.cacheWrite ?? 0;
    this.tokens.totalTokens += usage.totalTokens;

    // Context fill is a gauge, not a sum: only the main agent loop occupies the
    // user-visible context window, and each turn replaces the previous reading
    // (so it falls after compaction prunes history). Subagent / side-path calls
    // run against their own context and must not move it.
    if (source === "main_loop") {
      this.lastContextTokens =
        usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    }

    const entry = this.modelMix.get(model) ?? {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costUsd: null,
    };
    entry.turns += 1;
    entry.input += usage.input;
    entry.output += usage.output;
    entry.cacheRead += usage.cacheRead ?? 0;
    entry.cacheWrite += usage.cacheWrite ?? 0;
    entry.totalTokens += usage.totalTokens;
    if (costUsd !== null) entry.costUsd = (entry.costUsd ?? 0) + costUsd;
    this.modelMix.set(model, entry);

    this.sourceMix.set(source, (this.sourceMix.get(source) ?? 0) + 1);
  }

  snapshot(): SessionCostSnapshot {
    return {
      sessionId: this.sessionId,
      costUsd: this.hasCost ? this.costUsd : null,
      pricingMissing: this.pricingMissing,
      turns: this.turns,
      tokens: { ...this.tokens },
      contextTokens: this.lastContextTokens,
      modelMix: Object.fromEntries(
        [...this.modelMix].map(([model, usage]) => [model, { ...usage }]),
      ),
      sourceMix: Object.fromEntries(this.sourceMix) as SessionCostSnapshot["sourceMix"],
    };
  }

  finalize(durationMs: number, reason: string): SessionCostSummary {
    return { ...this.snapshot(), durationMs, reason };
  }
}
