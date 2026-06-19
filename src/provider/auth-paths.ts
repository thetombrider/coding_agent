import { getAnthropicApiKey, hasAnthropicOAuthTokens } from "./providers/anthropic.js";
import { getProvider, type ProviderSummary } from "./registry.js";

export type ProviderAuthPathId = "api-key" | "oauth";

/** One authentication method for a dual-auth provider. */
export interface ProviderAuthPath {
  id: ProviderAuthPathId;
  label: string;
  configured: boolean;
}

/** Auth paths for providers that support more than one credential type. */
export function providerAuthPaths(providerId: string): ProviderAuthPath[] | undefined {
  const provider = getProvider(providerId);
  if (provider?.authStrategy !== "api-key-or-oauth") return undefined;

  if (providerId === "anthropic") {
    return [
      { id: "api-key", label: "API key (Console)", configured: Boolean(getAnthropicApiKey()) },
      { id: "oauth", label: "OAuth (subscription)", configured: hasAnthropicOAuthTokens() },
    ];
  }
  return undefined;
}

export function anyAuthPathConfigured(providerId: string): boolean {
  return providerAuthPaths(providerId)?.some((path) => path.configured) ?? false;
}

/**
 * Dual-auth providers show the auth sub-menu when nothing is configured yet,
 * or when already active so the user can add/manage the other credential path.
 */
export function shouldOpenProviderAuthMenu(provider: Pick<ProviderSummary, "authStrategy" | "configured" | "active">): boolean {
  if (provider.authStrategy !== "api-key-or-oauth") return false;
  return !provider.configured || provider.active;
}

/** Default highlighted row in the auth sub-menu (prefer configured OAuth/API key). */
export function defaultProviderAuthIndex(paths: readonly ProviderAuthPath[]): number {
  const oauthIdx = paths.findIndex((p) => p.id === "oauth" && p.configured);
  if (oauthIdx >= 0) return oauthIdx;
  const apiIdx = paths.findIndex((p) => p.id === "api-key" && p.configured);
  if (apiIdx >= 0) return apiIdx;
  return 0;
}
