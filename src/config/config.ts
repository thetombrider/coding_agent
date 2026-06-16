import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

export interface Config {
  provider: {
    active: string;
    openrouter?: { apiKey?: string };
    anthropic?: { apiKey?: string };
    openai?: { apiKey?: string };
    litellm?: { baseUrl?: string };
    vercel?: { apiKey?: string };
    cloudflare?: { apiKey?: string; accountId?: string };
    regolo?: { apiKey?: string };
  };
  models: {
    main: string;
    cheap: string;
    picker: string[];
    contextWindows: Record<string, number>;
    pricing: Record<string, ModelPricing>;
  };
  approval: {
    mode: "normal" | "auto-accept" | "plan";
    autoApprovedCommands: string[];
  };
  system: {
    prompt: string;
  };
  telemetry: {
    enabled: boolean;
    metricsFile: string;
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const DEFAULT_CONFIG: Config = {
  provider: { active: "openrouter" },
  models: {
    main: "anthropic/claude-sonnet-4",
    cheap: "deepseek/deepseek-v4-flash",
    picker: [
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-4.6",
      "google/gemini-3.5-flash",
      "google/gemini-3.1-flash-lite",
      "deepseek/deepseek-v4-pro",
      "minimax/minimax-m3",
      "z-ai/glm-5.1",
      "inception/mercury-2",
      "arcee-ai/trinity-large-thinking",
      "mistralai/mistral-large-2512",
    ],
    contextWindows: {
      "anthropic/claude-opus-4.8": 200000,
      "anthropic/claude-sonnet-4.6": 200000,
      "anthropic/claude-sonnet-4": 200000,
      "google/gemini-3.5-flash": 1000000,
      "google/gemini-3.1-flash-lite": 1000000,
      "deepseek/deepseek-v4-pro": 64000,
      "deepseek/deepseek-v4-flash": 64000,
      "moonshotai/kimi-k2.7-code": 131072,
    },
    pricing: {
      "anthropic/claude-sonnet-4": { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
      "anthropic/claude-opus-4.8": { inputPerM: 15.0, outputPerM: 75.0, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
      "deepseek/deepseek-v4-flash": { inputPerM: 0.14, outputPerM: 0.28, cacheReadPerM: 0.014 },
      "deepseek/deepseek-v4-pro": { inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.027 },
      "minimax/minimax-m3": { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.06 },
      "google/gemini-3.5-flash": { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.0375 },
      "moonshotai/kimi-k2.7-code": { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075 },
    },
  },
  approval: { mode: "normal", autoApprovedCommands: [] },
  system: { prompt: "You are Orin, a coding agent. Use tools to inspect and modify the codebase. Answer concisely." },
  telemetry: { enabled: true, metricsFile: "~/.orin/metrics.jsonl" },
};

function configPath(): string {
  return join(homedir(), ".orin", "config.json");
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    if (pv === undefined) continue;
    const bv = base[key];
    if (
      typeof pv === "object" && pv !== null && !Array.isArray(pv) &&
      typeof bv === "object" && bv !== null && !Array.isArray(bv)
    ) {
      result[key] = deepMerge(bv as Record<string, unknown>, pv as Record<string, unknown>);
    } else {
      result[key] = pv;
    }
  }
  return result;
}

function readRawConfig(): Record<string, unknown> {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Write the default config file when missing or empty so users have something to edit. */
export function ensureConfigFile(): boolean {
  const path = configPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!existsSync(path)) {
    saveConfig({});
    return true;
  }

  const raw = readFileSync(path, "utf8").trim();
  if (!raw) {
    saveConfig({});
    return true;
  }

  return false;
}

/** Load config: file merged with defaults, then env var overrides applied on top. */
export function loadConfig(): Config {
  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    readRawConfig(),
  ) as unknown as Config;

  if (process.env.ORIN_MODEL?.trim()) merged.models.main = process.env.ORIN_MODEL.trim();
  if (process.env.ORIN_CHEAP_MODEL?.trim()) merged.models.cheap = process.env.ORIN_CHEAP_MODEL.trim();
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    merged.provider.openrouter = { ...merged.provider.openrouter, apiKey: process.env.OPENROUTER_API_KEY.trim() };
  }
  const rawMode = process.env.ORIN_APPROVAL_MODE?.trim().toLowerCase();
  if (rawMode === "auto-accept" || rawMode === "auto") merged.approval.mode = "auto-accept";
  else if (rawMode === "plan") merged.approval.mode = "plan";
  else if (rawMode === "normal") merged.approval.mode = "normal";

  return merged;
}

/** True when an OpenRouter API key is available from the env var or config file. */
export function hasOpenRouterApiKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim() || loadConfig().provider.openrouter?.apiKey);
}

/** Deep-merge a partial patch into the persisted config file. Creates the file if absent. */
export function saveConfig(patch: DeepPartial<Config>): void {
  const path = configPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    readRawConfig(),
  );
  const next = deepMerge(current, patch as unknown as Record<string, unknown>);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
