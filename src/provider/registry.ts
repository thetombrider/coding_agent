import type { LanguageModel } from "ai";
import { loadConfig } from "../config/config.js";
import { openRouterProvider } from "./providers/openrouter.js";
import type { AuthStrategy, ModelMetadataProvider, Provider } from "./types.js";

/** Provider id used as the fallback when config selects an unknown provider. */
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
}

const registry = new Map<string, Provider>();

/** Register (or replace) a provider implementation. Called once per backend. */
export function registerProvider(provider: Provider): void {
  registry.set(provider.id, provider);
}

export function getProvider(id: string): Provider | undefined {
  return registry.get(id);
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
 * AI SDK model handle for the active provider. Core call paths (`stream.ts`,
 * `delegate-read.ts`, `compaction.ts`) resolve models through here instead of
 * calling `getOpenRouter()` directly, so switching `provider.active` at runtime
 * takes effect on the next turn with no rewiring.
 */
export function resolveLanguageModel(modelId: string): LanguageModel {
  return resolveActiveProvider().languageModel(modelId);
}

/** Metadata providers for every registered backend (the registry owns this list). */
export function metadataProviders(): ModelMetadataProvider[] {
  return listProviders().map((provider) => provider.metadata);
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
  }));
}

// Built-in providers. Additional backends (Anthropic, OpenAI, LiteLLM, Regolo,
// Vercel/Cloudflare gateways, OAuth) register here in follow-up PRs.
registerProvider(openRouterProvider);
