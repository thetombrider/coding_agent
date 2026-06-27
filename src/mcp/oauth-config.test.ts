import { describe, expect, it } from "vitest";
import { isMcpOAuthConfigured, parseMcpOAuth } from "./oauth-config.js";

describe("parseMcpOAuth", () => {
  it("accepts true and object forms", () => {
    expect(parseMcpOAuth(true)).toBe(true);
    expect(parseMcpOAuth({ clientId: "id", scopes: ["mcp"] })).toEqual({
      clientId: "id",
      scopes: ["mcp"],
    });
    expect(parseMcpOAuth("bad")).toBeUndefined();
  });
});

describe("isMcpOAuthConfigured", () => {
  it("requires explicit oauth in config", () => {
    expect(
      isMcpOAuthConfigured({
        type: "http",
        url: "https://example.com/mcp",
        oauth: {},
      }),
    ).toBe(true);
  });

  it("does not infer oauth from URL path alone", () => {
    expect(
      isMcpOAuthConfigured({
        type: "http",
        url: "https://mcp.context7.com/mcp/oauth",
      }),
    ).toBe(false);
  });

  it("is false when bearer headers are set and oauth is absent", () => {
    expect(
      isMcpOAuthConfigured({
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer key" },
      }),
    ).toBe(false);
  });
});
