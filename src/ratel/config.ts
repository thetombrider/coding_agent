import { loadConfig } from "../config/config.js";

/** Resolved Ratel settings (issue #295). */
export interface RatelSettings {
  enabled: boolean;
  /** BM25 top-K for tools injected directly each turn (ADR 0003 replace mode). */
  topKTools: number;
  /** BM25 top-K for skills in search_capabilities. */
  topKSkills: number;
  /** Always injected regardless of BM25 rank. */
  pinnedTools: readonly string[];
  /**
   * Fraction of sessions routed to the A/B control arm (full tool list, no pre-filter).
   * 0 = fully in treatment (all sessions use Ratel). 0.1 = 10% control. Range [0, 1].
   * Control arm sessions emit `feature_flag = "tool_pool=full"` on every LLM span.
   */
  controlFraction: number;
}

const DEFAULT_PINNED = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "search_capabilities",
  "invoke_tool",
] as const;

const DEFAULTS: RatelSettings = {
  enabled: true,
  topKTools: 5,
  topKSkills: 3,
  pinnedTools: DEFAULT_PINNED,
  controlFraction: 0,
};

function clampInt(value: unknown, fallback: number, min = 1, max = 50): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampFraction(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** Load Ratel settings from ~/.orin/config.json with sane defaults. */
export function resolveRatelSettings(): RatelSettings {
  const raw = loadConfig().ratel;
  if (!raw) return DEFAULTS;

  const pinned =
    Array.isArray(raw.pinnedTools) && raw.pinnedTools.every((t) => typeof t === "string")
      ? raw.pinnedTools
      : DEFAULTS.pinnedTools;

  return {
    enabled: raw.enabled === true,
    topKTools: clampInt(raw.topKTools, DEFAULTS.topKTools),
    topKSkills: clampInt(raw.topKSkills, DEFAULTS.topKSkills),
    pinnedTools: pinned,
    controlFraction: clampFraction(raw.controlFraction, DEFAULTS.controlFraction),
  };
}

export function isRatelEnabled(): boolean {
  return resolveRatelSettings().enabled;
}
