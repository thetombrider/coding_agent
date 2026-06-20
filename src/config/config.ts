import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

/** OTLP trace exporter settings. Resolved against env vars by `resolveOtelConfig()`. */
export interface OtelConfig {
  /** When false, the OTel subtree is never loaded. Auto-enabled if an endpoint is present. */
  enabled: boolean;
  /** OTLP/HTTP traces endpoint, e.g. `https://cloud.langfuse.com/api/public/otel/v1/traces`. */
  endpoint: string;
  protocol: string;
  headers: Record<string, string>;
  serviceName: string;
  /** Semantic-convention flavour; only `genai` is implemented today. */
  semconv: string;
  /** Capture prompt/response content on spans (privacy-sensitive; tuned in 7/8). */
  captureContent: boolean;
  sampleRatio: number;
  /** Stable anonymous OTLP user id — auto-generated on first export when absent. */
  userId?: string;
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
    /** Per-role model overrides for subagent presets. Empty = use tier defaults. */
    roles: Record<string, string>;
    /** Per-provider extras for the `/model` picker; bundled provider lists stay authoritative. */
    picker: Record<string, string[]>;
    /** Last main model used per provider — restored when switching back. */
    lastUsed: Record<string, { main: string; cheap?: string }>;
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
    /** OTLP trace export (issue 5/8). Off unless an endpoint is configured. */
    otel: OtelConfig;
  };
  sandbox?: {
    active?: "local" | "e2b";
    e2b?: { apiKey?: string };
  };
  todo?: {
    /** Write `.orin/todo.md` on each todowrite call for human-editable, committable plans. */
    export?: boolean;
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const DEFAULT_CONFIG: Config = {
  provider: { active: "openrouter" },
  models: {
    main: "anthropic/claude-sonnet-4.6",
    cheap: "deepseek/deepseek-v4-flash",
    roles: {},
    picker: {},
    lastUsed: {},
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
      "anthropic/claude-sonnet-4.6": { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
      "anthropic/claude-opus-4.8": { inputPerM: 15.0, outputPerM: 75.0, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
      "claude-sonnet-4-6": { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
      "claude-sonnet-4-5": { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
      "claude-opus-4-8": { inputPerM: 15.0, outputPerM: 75.0, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
      "claude-opus-4-7": { inputPerM: 15.0, outputPerM: 75.0, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
      "claude-haiku-4-5": { inputPerM: 1.0, outputPerM: 5.0, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
      "deepseek/deepseek-v4-flash": { inputPerM: 0.14, outputPerM: 0.28, cacheReadPerM: 0.014 },
      "deepseek/deepseek-v4-pro": { inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.027 },
      "minimax/minimax-m3": { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.06 },
      "google/gemini-3.5-flash": { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.0375 },
      "google/gemini-3.1-flash-lite": { inputPerM: 0.075, outputPerM: 0.30, cacheReadPerM: 0.01875 },
      "moonshotai/kimi-k2.7-code": { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075 },
      "z-ai/glm-5.2": { inputPerM: 0.40, outputPerM: 1.60 },
      "z-ai/glm-5.1": { inputPerM: 0.40, outputPerM: 1.60 },
      "qwen/qwen3.7-plus": { inputPerM: 0.40, outputPerM: 2.40 },
      "xiaomi/mimo-v2.5-pro": { inputPerM: 0.10, outputPerM: 0.30 },
      "inception/mercury-2": { inputPerM: 0.25, outputPerM: 1.00 },
      "arcee-ai/trinity-large-thinking": { inputPerM: 0.15, outputPerM: 0.60 },
      "mistralai/mistral-large-2512": { inputPerM: 2.00, outputPerM: 6.00 },
      "Llama-3.3-70B-Instruct": { inputPerM: 0.59, outputPerM: 0.79 },
      "qwen3-coder-next": { inputPerM: 0.22, outputPerM: 1.00 },
      "qwen3.5-122b": { inputPerM: 0.22, outputPerM: 0.88 },
      "qwen3.6-27b": { inputPerM: 0.10, outputPerM: 0.40 },
      "gpt-oss-120b": { inputPerM: 0.15, outputPerM: 0.60 },
      "mistral-small-4-119b": { inputPerM: 0.10, outputPerM: 0.30 },
      "gemma4-31b": { inputPerM: 0.07, outputPerM: 0.25 },
    },
  },
  approval: { mode: "normal", autoApprovedCommands: [] },
  system: { prompt: "You are Orin, a coding agent. Use tools to inspect and modify the codebase. Answer concisely." },
  telemetry: {
    enabled: true,
    metricsFile: "~/.orin/metrics.jsonl",
    otel: {
      enabled: false,
      endpoint: "",
      protocol: "http/protobuf",
      headers: {},
      serviceName: "orin",
      semconv: "genai",
      captureContent: false,
      sampleRatio: 1.0,
    },
  },
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

function normalizePickerConfig(raw: unknown): Record<string, string[]> {
  if (Array.isArray(raw)) {
    return { openrouter: raw.filter((id): id is string => typeof id === "string") };
  }
  if (raw && typeof raw === "object") {
    const next: Record<string, string[]> = {};
    for (const [providerId, models] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(models)) {
        next[providerId] = models.filter((id): id is string => typeof id === "string");
      }
    }
    return next;
  }
  return {};
}

/** Picker lists shipped in older releases; cleared so bundled provider defaults apply. */
const LEGACY_OPENROUTER_PICKER_LISTS: ReadonlyArray<readonly string[]> = [
  [
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
  [
    "anthropic/claude-opus-4.8",
    "anthropic/claude-sonnet-4.6",
    "google/gemini-3.5-flash",
    "google/gemini-3.1-flash-lite",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "minimax/minimax-m3",
    "z-ai/glm-5.1",
    "inception/mercury-2",
    "arcee-ai/trinity-large-thinking",
    "mistralai/mistral-large-2512",
  ],
];

function pickerMatchesLegacyList(models: string[], legacy: readonly string[]): boolean {
  if (models.length !== legacy.length) return false;
  const set = new Set(models);
  return legacy.every((id) => set.has(id));
}

function dropLegacyPickerOverrides(picker: Record<string, string[]>): Record<string, string[]> {
  const openrouter = picker.openrouter;
  if (!openrouter?.length) return picker;
  const isLegacy = LEGACY_OPENROUTER_PICKER_LISTS.some((legacy) =>
    pickerMatchesLegacyList(openrouter, legacy),
  );
  if (!isLegacy) return picker;
  const { openrouter: _removed, ...rest } = picker;
  return rest;
}

/** Load config: file merged with defaults, then env var overrides applied on top. */
export function loadConfig(): Config {
  const raw = readRawConfig();
  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    raw,
  ) as unknown as Config;

  merged.models.picker = dropLegacyPickerOverrides(
    normalizePickerConfig(
      (raw.models as { picker?: unknown } | undefined)?.picker ?? merged.models.picker,
    ),
  );

  if (process.env.ORIN_MODEL?.trim()) merged.models.main = process.env.ORIN_MODEL.trim();
  if (process.env.ORIN_CHEAP_MODEL?.trim()) merged.models.cheap = process.env.ORIN_CHEAP_MODEL.trim();
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    merged.provider.openrouter = { ...merged.provider.openrouter, apiKey: process.env.OPENROUTER_API_KEY.trim() };
  }
  if (process.env.REGOLO_API_KEY?.trim()) {
    merged.provider.regolo = { ...merged.provider.regolo, apiKey: process.env.REGOLO_API_KEY.trim() };
  }
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    merged.provider.anthropic = { ...merged.provider.anthropic, apiKey: process.env.ANTHROPIC_API_KEY.trim() };
  }
  if (process.env.E2B_API_KEY?.trim()) {
    merged.sandbox = { ...merged.sandbox, e2b: { ...merged.sandbox?.e2b, apiKey: process.env.E2B_API_KEY.trim() } };
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

/** True when a Regolo API key is available from the env var or config file. */
export function hasRegoloApiKey(): boolean {
  return Boolean(process.env.REGOLO_API_KEY?.trim() || loadConfig().provider.regolo?.apiKey);
}

/** True when an Anthropic API key is available from the env var or config file. */
export function hasAnthropicApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || loadConfig().provider.anthropic?.apiKey);
}

/** True when an E2B API key is available from the env var or config file. */
export function hasE2BApiKey(): boolean {
  const fromEnv = process.env.E2B_API_KEY?.trim();
  const fromConfig = loadConfig().sandbox?.e2b?.apiKey?.trim();
  return Boolean(fromEnv || fromConfig);
}

/** Persist an E2B API key under `sandbox.e2b.apiKey` in config.json. */
export function saveE2BApiKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) return;
  saveConfig({ sandbox: { e2b: { apiKey: trimmed } } });
}

/** Persist provider-specific settings under `provider.<id>.<key>` in config.json. */
export function saveProviderConfig(providerId: string, values: Record<string, string>): void {
  const section: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const trimmed = value.trim();
    if (trimmed) section[key] = trimmed;
  }
  saveConfig({ provider: { [providerId]: section } } as DeepPartial<Config>);
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
