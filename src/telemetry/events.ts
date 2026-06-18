import type { Usage } from "../provider/types.js";

/**
 * Where an LLM call originated. The main agent loop is `main_loop`; the other
 * sources are populated by follow-up issues (compaction 2/8, the cheap-model
 * side path 3/8, and nested subagent loops 4/8).
 */
export type TurnSource = "main_loop" | "compaction" | "delegate_read" | "subagent";

/** Per-call cost + token breakdown produced by `calcCost`, tagged with its source. */
export interface TurnCost {
  model: string;
  usage: Usage;
  /** USD cost for this call, or `null` when no pricing is known for the model. */
  costUsd: number | null;
  /** True when pricing was missing — token counts are still accurate. */
  pricingMissing: boolean;
  source: TurnSource;
}

/** Aggregated usage for a single model across a session. */
export interface ModelUsage {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** Summed cost across this model's calls (only the priced ones contribute). */
  costUsd: number | null;
}

/** Running totals for a session — the body of a `session` metric event. */
export interface SessionCostSummary {
  sessionId: string;
  /** Summed cost across all priced calls; `null` only when nothing was priced. */
  costUsd: number | null;
  /** True when at least one call had no known pricing. */
  pricingMissing: boolean;
  turns: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
  modelMix: Record<string, ModelUsage>;
  sourceMix: Partial<Record<TurnSource, number>>;
  durationMs: number;
  reason: string;
}

/** A live snapshot of the accumulator — the summary without the finalize-only fields. */
export type SessionCostSnapshot = Omit<SessionCostSummary, "durationMs" | "reason">;

/**
 * A measurement emitted to the metric sinks. Every event carries `sessionId`
 * and an ISO `ts` so a JSONL line is self-describing.
 */
export type MetricEvent =
  | ({ type: "turn"; sessionId: string; ts: string } & TurnCost)
  | {
      type: "tool";
      sessionId: string;
      ts: string;
      id: string;
      name: string;
      durationMs: number;
      isError?: boolean;
      subagentId?: string;
    }
  | { type: "session"; sessionId: string; ts: string; summary: SessionCostSummary };
