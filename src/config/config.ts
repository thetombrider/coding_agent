import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IsolationMode } from "../agent/isolation.js";
import type { SessionIsolationMode } from "../agent/session-isolation.js";

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

/** OTLP trace exporter settings. Resolved by `resolveOtelConfig()`. */
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
    opencode?: { apiKey?: string };
  };
  models: {
    main: string;
    cheap: string;
    /**
     * Per-provider, per-role model overrides for subagent presets, keyed
     * `providerId → role → model`. Provider-scoping keeps a role pinned to a
     * model the provider actually supports, so switching providers restores
     * that provider's own choices instead of risking an unsupported id.
     * Empty (per provider or overall) = use tier defaults.
     */
    roles: Record<string, Record<string, string>>;
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
  subagent: {
    /**
     * Default isolation floor for mutating `task` subagents. A guarantee, not
     * just a default: the lead model may escalate to a more-isolated mode per
     * call but never weaken below this. Read-only presets are unaffected.
     */
    isolation: IsolationMode;
  };
  session: {
    /** Whole-session parent-loop isolation. Default `shared`. */
    isolation: SessionIsolationMode;
  };
  system: {
    prompt: string;
  };
  telemetry: {
    enabled: boolean;
    /** Echo each metric event to stdout (debugging). */
    stdout: boolean;
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
  tools?: {
    exa?: { apiKey?: string };
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
  subagent: { isolation: "shared" },
  session: { isolation: "shared" },
  system: { prompt: "You are Orin, a coding agent. Use tools to inspect and modify the codebase. Answer concisely.\n\nCode reading strategy: grep to locate symbols (get the line number), then read with offset+limit to see only that section. Use grep context=N for surrounding lines instead of reading the whole file. Never re-read a file already in context. Use delegate_read when you need to understand multiple files at once." },
  telemetry: {
    enabled: true,
    stdout: false,
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

/**
 * Normalize `models.roles` into the provider-scoped shape `providerId → role →
 * model`. Tolerates the legacy flat shape (`role → model`, written before role
 * overrides were provider-aware) by attributing those entries to the active
 * provider — the provider they were implicitly set under. Mixed shapes are
 * handled per top-level key: string values are legacy role entries, object
 * values are already provider-scoped. Role ids (`explore`/`review`/`implement`)
 * never collide with provider ids, so the value type disambiguates safely.
 */
function normalizeRolesConfig(raw: unknown, activeProvider: string): Record<string, Record<string, string>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, Record<string, string>> = {};
  const put = (providerId: string, role: string, model: string) => {
    const trimmed = model.trim();
    if (!trimmed) return;
    (result[providerId] ??= {})[role] = trimmed;
  };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      put(activeProvider, key, value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [role, model] of Object.entries(value as Record<string, unknown>)) {
        if (typeof model === "string") put(key, role, model);
      }
    }
  }
  return result;
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

let cachedConfig: Config | undefined;

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

function buildConfig(): Config {
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

  merged.models.roles = normalizeRolesConfig(
    (raw.models as { roles?: unknown } | undefined)?.roles ?? merged.models.roles,
    merged.provider.active,
  );

  return merged;
}

/** Load config: defaults merged with `~/.orin/config.json`. Cached for performance. */
export function loadConfig(): Config {
  if (cachedConfig === undefined) {
    cachedConfig = buildConfig();
  }
  return cachedConfig;
}

/** Invalidate the config cache. Used after config file changes or explicit reload. */
export function reloadConfig(): Config {
  cachedConfig = undefined;
  return loadConfig();
}

/** Internal: Clear the config cache for testing. */
export function __testClearCache(): void {
  cachedConfig = undefined;
}

/** True when an OpenRouter API key is set in config. */
export function hasOpenRouterApiKey(): boolean {
  return Boolean(loadConfig().provider.openrouter?.apiKey?.trim());
}

/** True when a Regolo API key is set in config. */
export function hasRegoloApiKey(): boolean {
  return Boolean(loadConfig().provider.regolo?.apiKey?.trim());
}

/** True when an Anthropic API key is set in config. */
export function hasAnthropicApiKey(): boolean {
  return Boolean(loadConfig().provider.anthropic?.apiKey?.trim());
}

/** True when an Opencode API key is set in config. */
export function hasOpencodeApiKey(): boolean {
  return Boolean(loadConfig().provider.opencode?.apiKey?.trim());
}

/** True when an E2B API key is set in config. */
export function hasE2BApiKey(): boolean {
  return Boolean(loadConfig().sandbox?.e2b?.apiKey?.trim());
}

/** Exa API key from config; undefined when not configured. */
export function getExaApiKey(): string | undefined {
  const key = loadConfig().tools?.exa?.apiKey?.trim();
  return key || undefined;
}

/** True when an Exa API key is set in config. */
export function hasExaApiKey(): boolean {
  return Boolean(getExaApiKey());
}

/** Persist an E2B API key under `sandbox.e2b.apiKey` in config.json. */
export function saveE2BApiKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) return;
  saveConfig({ sandbox: { e2b: { apiKey: trimmed } } });
  cachedConfig = undefined;
}

/** Persist an Exa API key under `tools.exa.apiKey` in config.json. */
export function saveExaApiKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) return;
  saveConfig({ tools: { exa: { apiKey: trimmed } } });
  cachedConfig = undefined;
}

/** Persist provider-specific settings under `provider.<id>.<key>` in config.json. */
export function saveProviderConfig(providerId: string, values: Record<string, string>): void {
  const section: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const trimmed = value.trim();
    if (trimmed) section[key] = trimmed;
  }
  saveConfig({ provider: { [providerId]: section } } as DeepPartial<Config>);
  cachedConfig = undefined;
}

/**
 * Set or clear the preferred model for a subagent role (`implement` / `review` /
 * `explore`) on a specific provider, under `models.roles[providerId]`. Passing an
 * empty value or `"default"` removes the override so the role falls back to its
 * tier default. Replaces the whole `roles` map (rather than deep-merging) so
 * clearing actually deletes the key, and normalizes any legacy flat shape first.
 */
export function saveRoleModel(providerId: string, role: string, model: string): void {
  const path = configPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    readRawConfig(),
  ) as unknown as Config;
  const roles = normalizeRolesConfig(current.models.roles, current.provider.active);
  const providerRoles = { ...(roles[providerId] ?? {}) };
  const trimmed = model.trim();
  if (!trimmed || trimmed === "default") delete providerRoles[role];
  else providerRoles[role] = trimmed;
  if (Object.keys(providerRoles).length > 0) roles[providerId] = providerRoles;
  else delete roles[providerId];
  current.models.roles = roles;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
  cachedConfig = undefined;
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
  cachedConfig = undefined;
}
