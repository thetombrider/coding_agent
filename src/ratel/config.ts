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
};

function clampInt(value: unknown, fallback: number, min = 1, max = 50): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
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
  };
}

export function isRatelEnabled(): boolean {
  return resolveRatelSettings().enabled;
}
