import type { LanguageModel } from "ai";
import { loadConfig, saveConfig } from "../config/config.js";
import { providerAuthPaths } from "./auth-paths.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { openRouterProvider } from "./providers/openrouter.js";
import { regoloProvider } from "./providers/regolo.js";
import type { AuthStrategy, ModelMetadataProvider, Provider, ProviderConfigField } from "./types.js";
export const DEFAULT_PROVIDER_ID = "openrouter";

/** Display info for the `/providers` command and TUI palette. */
export interface ProviderSummary {
  id: string;
  displayName: string;
  authStrategy: AuthStrategy;
  /** Currently selected (`provider.active`). */
  active: boolean;
  /** Credentials available (env var or config file). */
  configured: boolean;
  /** Per-path setup status for dual-auth providers. */
  authPaths?: ReturnType<typeof providerAuthPaths>;
}

const registry = new Map<string, Provider>();

/** Register (or replace) a provider implementation. Called once per backend. */
export function registerProvider(provider: Provider): void {
  registry.set(provider.id, provider);
}

export function getProvider(id: string): Provider | undefined {
  return registry.get(id);
}

/** Config fields the TUI can collect for a registered provider. */
export function providerConfigFields(id: string): readonly ProviderConfigField[] {
  return getProvider(id)?.configFields ?? [];
}

export function listProviders(): Provider[] {
  return [...registry.values()];
}

/** The configured active provider id (`provider.active` in config). */
export function activeProviderId(): string {
  return loadConfig().provider.active;
}

/** Resolve the active provider, falling back to the default when unknown. */
export function resolveActiveProvider(): Provider {
  const active = registry.get(activeProviderId());
  if (active) return active;
  const fallback = registry.get(DEFAULT_PROVIDER_ID);
  if (fallback) return fallback;
  throw new Error(`No provider registered (active="${activeProviderId()}")`);
}

/**
 * Prefer the configured `provider.active` entry; otherwise the first configured
 * backend; otherwise the requested/default provider (possibly unconfigured).
 */
export function resolveConfiguredActiveProvider(): Provider {
  const requested = resolveActiveProvider();
  if (requested.isConfigured()) return requested;

  for (const provider of listProviders()) {
    if (provider.isConfigured()) return provider;
  }
  return requested;
}

/**
 * Ensure `provider.active` points at a configured backend. Persists a fix when
 * the saved active provider lost credentials (e.g. anthropic with no auth).
 */
export function repairActiveProviderIfNeeded(): Provider {
  const requestedId = activeProviderId();
  const resolved = resolveConfiguredActiveProvider();
  if (resolved.id !== requestedId && resolved.isConfigured()) {
    saveConfig({ provider: { active: resolved.id } });
  }
  return resolved;
}

/**
 * AI SDK model handle for the active provider. Core call paths (`stream.ts`,
 * `delegate-read.ts`, `compaction.ts`) resolve models through here instead of
 * calling `getOpenRouter()` directly, so switching `provider.active` at runtime
 * takes effect on the next turn with no rewiring.
 */
export function resolveLanguageModel(modelId: string): LanguageModel {
  return resolveActiveProvider().languageModel(modelId);
}

/** Refresh credentials (e.g. OAuth tokens) for the active provider before an LLM call. */
export async function prepareActiveProviderCredentials(): Promise<void> {
  await resolveActiveProvider().prepareCredentials?.();
}

/** Metadata providers for every registered backend (the registry owns this list). */
export function metadataProviders(): ModelMetadataProvider[] {
  return listProviders().map((provider) => provider.metadata);
}

/**
 * Curated model ids for the `/model` picker. Uses `models.picker.<providerId>`
 * from config when set, otherwise each provider's bundled `pickerModels`.
 */
export function resolvePickerModels(providerId?: string): readonly string[] {
  const provider = getProvider(providerId ?? activeProviderId()) ?? resolveActiveProvider();
  const override = loadConfig().models.picker[provider.id];
  if (override && override.length > 0) return override;
  return provider.pickerModels;
}

/** Snapshot of every provider's status for `/providers` listing and switching. */
export function providerSummaries(): ProviderSummary[] {
  const active = resolveActiveProvider().id;
  return listProviders().map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    authStrategy: provider.authStrategy,
    active: provider.id === active,
    configured: provider.isConfigured(),
    authPaths: providerAuthPaths(provider.id),
  }));
}

// Built-in providers. Additional backends (Anthropic, OpenAI, LiteLLM,
// Vercel/Cloudflare gateways, OAuth) register here in follow-up PRs.
registerProvider(openRouterProvider);
registerProvider(regoloProvider);
registerProvider(anthropicProvider);
