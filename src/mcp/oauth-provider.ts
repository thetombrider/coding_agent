import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpHttpConfig } from "./config.js";
import { openBrowser } from "./oauth-browser.js";
import { resolveMcpOAuthOptions } from "./oauth-config.js";
import {
  deleteMcpOAuthStore,
  readMcpOAuthStore,
  updateMcpOAuthStore,
} from "./oauth-store.js";

export interface OrinMcpOAuthProviderOptions {
  serverName: string;
  config: McpHttpConfig;
  redirectUrl: string | URL;
  /** When false, redirectToAuthorization only stores the URL (for tests). Default: open browser. */
  openBrowser?: boolean;
  onAuthorizationUrl?: (url: URL) => void;
}

export class OrinMcpOAuthProvider implements OAuthClientProvider {
  private readonly oauthOptions;
  private readonly shouldOpenBrowser;
  private readonly onAuthorizationUrl?: (url: URL) => void;

  constructor(private readonly opts: OrinMcpOAuthProviderOptions) {
    this.oauthOptions = resolveMcpOAuthOptions(opts.config) ?? {};
    this.shouldOpenBrowser = opts.openBrowser !== false;
    this.onAuthorizationUrl = opts.onAuthorizationUrl;
  }

  get redirectUrl(): string | URL {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      redirect_uris: [String(this.opts.redirectUrl)],
      client_name: "Orin MCP Client",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    if (this.oauthOptions.clientSecret) {
      metadata.token_endpoint_auth_method = "client_secret_basic";
    } else {
      metadata.token_endpoint_auth_method = "none";
    }
    if (this.oauthOptions.scopes?.length) {
      metadata.scope = this.oauthOptions.scopes.join(" ");
    }
    return metadata;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const stored = readMcpOAuthStore(this.opts.serverName)?.clientInformation;
    if (stored) return stored;
    if (this.oauthOptions.clientId) {
      return {
        client_id: this.oauthOptions.clientId,
        client_secret: this.oauthOptions.clientSecret,
      };
    }
    return undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    updateMcpOAuthStore(this.opts.serverName, { clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return readMcpOAuthStore(this.opts.serverName)?.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    updateMcpOAuthStore(this.opts.serverName, { tokens, codeVerifier: undefined });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onAuthorizationUrl?.(authorizationUrl);
    if (this.shouldOpenBrowser) openBrowser(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    updateMcpOAuthStore(this.opts.serverName, { codeVerifier });
  }

  codeVerifier(): string {
    const verifier = readMcpOAuthStore(this.opts.serverName)?.codeVerifier;
    if (!verifier) throw new Error("OAuth PKCE verifier missing — restart authentication");
    return verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    updateMcpOAuthStore(this.opts.serverName, { discoveryState: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return readMcpOAuthStore(this.opts.serverName)?.discoveryState;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    if (scope === "all") {
      deleteMcpOAuthStore(this.opts.serverName);
      return;
    }
    const store = readMcpOAuthStore(this.opts.serverName);
    if (!store) return;
    const next = { ...store };
    if (scope === "client") delete next.clientInformation;
    if (scope === "tokens") delete next.tokens;
    if (scope === "verifier") delete next.codeVerifier;
    if (scope === "discovery") delete next.discoveryState;
    updateMcpOAuthStore(this.opts.serverName, next);
  }
}

export function createOrinMcpOAuthProvider(
  opts: OrinMcpOAuthProviderOptions,
): OrinMcpOAuthProvider {
  return new OrinMcpOAuthProvider(opts);
}
