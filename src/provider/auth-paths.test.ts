import { describe, expect, it } from "vitest";
import {
  defaultProviderAuthIndex,
  shouldOpenProviderAuthMenu,
} from "./auth-paths.js";
import type { ProviderSummary } from "./registry.js";

const dualAuth = (overrides: Partial<ProviderSummary>): ProviderSummary => ({
  id: "anthropic",
  displayName: "Anthropic",
  authStrategy: "api-key-or-oauth",
  active: false,
  configured: false,
  ...overrides,
});

describe("auth-paths", () => {
  it("opens the auth menu when unconfigured or already active", () => {
    expect(shouldOpenProviderAuthMenu(dualAuth({ configured: false }))).toBe(true);
    expect(shouldOpenProviderAuthMenu(dualAuth({ configured: true, active: true }))).toBe(true);
    expect(shouldOpenProviderAuthMenu(dualAuth({ configured: true, active: false }))).toBe(false);
  });

  it("defaults auth menu highlight to configured paths", () => {
    expect(
      defaultProviderAuthIndex([
        { id: "api-key", label: "API key", configured: false },
        { id: "oauth", label: "OAuth", configured: true },
      ]),
    ).toBe(1);
  });
});
