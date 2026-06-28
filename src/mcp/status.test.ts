import { describe, expect, it } from "vitest";
import { classifyMcpFailure, mcpListStatusLabel, mcpSummaryPart, shortMcpError } from "./status.js";

describe("classifyMcpFailure", () => {
  const githubConfig = {
    type: "http" as const,
    url: "https://api.githubcopilot.com/mcp/",
  };

  const context7OAuthConfig = {
    type: "http" as const,
    url: "https://mcp.context7.com/mcp/oauth",
    oauth: {} as const,
  };

  it("classifies missing Authorization header as needs_auth with Bearer hint", () => {
    const result = classifyMcpFailure(
      new Error("missing required Authorization header"),
      githubConfig,
    );
    expect(result.status).toBe("needs_auth");
    expect(result.hint).toMatch(/Bearer token/i);
  });

  it("suggests oauth setup when error indicates OAuth but config lacks oauth field", () => {
    const result = classifyMcpFailure(
      new Error("Authentication required. Please authenticate to use this MCP server."),
      { type: "http", url: "https://mcp.context7.com/mcp/oauth" },
      "context7",
    );
    expect(result.status).toBe("needs_auth");
    expect(result.hint).toMatch(/Press a in \/mcp detail/i);
  });

  it("shows authenticate hint when oauth is configured", () => {
    const result = classifyMcpFailure(
      new Error("Unauthorized"),
      context7OAuthConfig,
      "context7",
    );
    expect(result.status).toBe("needs_auth");
    expect(result.hint).toMatch(/Press a in \/mcp detail/i);
  });

  it("classifies connection refused as failed with network hint", () => {
    const result = classifyMcpFailure(new Error("connection refused"), githubConfig);
    expect(result.status).toBe("failed");
    expect(result.hint).toMatch(/running/i);
  });

  it("classifies generic errors as failed", () => {
    const result = classifyMcpFailure(new Error("something went wrong"), githubConfig);
    expect(result.status).toBe("failed");
    expect(result.hint).toBeUndefined();
  });

  it("suggests checking token when auth is configured but still fails", () => {
    const result = classifyMcpFailure(new Error("401 Unauthorized"), {
      ...githubConfig,
      headers: { Authorization: "Bearer bad" },
    });
    expect(result.status).toBe("needs_auth");
    expect(result.hint).toMatch(/valid/i);
  });

  it("hints at stdio args when npx cannot find an executable", () => {
    const result = classifyMcpFailure(
      new Error("could not determine executable to run"),
      { type: "stdio", command: "npx", args: ["-y", "server"] },
    );
    expect(result.status).toBe("failed");
    expect(result.hint).toMatch(/server-filesystem/i);
  });

  it("hints at stdio command when the process exits immediately", () => {
    const result = classifyMcpFailure(
      new Error("MCP error -32000: Connection closed"),
      { type: "stdio", command: "npx", args: ["-y", "server"] },
    );
    expect(result.status).toBe("failed");
    expect(result.hint).toMatch(/exited/i);
  });
});

describe("shortMcpError", () => {
  it("truncates long single-line errors", () => {
    const long = "x".repeat(100);
    expect(shortMcpError(long)).toHaveLength(80);
    expect(shortMcpError(long).endsWith("…")).toBe(true);
  });

  it("keeps first line of multiline errors", () => {
    expect(shortMcpError("first line\nsecond line")).toBe("first line");
  });
});

describe("status labels", () => {
  it("formats list and summary labels", () => {
    expect(mcpListStatusLabel("connected", 8)).toBe("8 tools");
    expect(mcpListStatusLabel("needs_auth", 0)).toBe("needs auth");
    expect(mcpSummaryPart("github", "needs_auth", 0)).toBe("github needs auth");
    expect(mcpSummaryPart("fs", "connected", 3)).toBe("fs (3 tools)");
  });
});
