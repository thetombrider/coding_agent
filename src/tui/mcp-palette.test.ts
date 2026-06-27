import { describe, expect, it } from "vitest";
import { mcpListRowLabel, mcpListRows, mcpServerDetailLines } from "./mcp-palette.js";

describe("mcp palette", () => {
  it("lists servers plus add/reload actions", () => {
    const rows = mcpListRows([
      {
        name: "fs",
        config: { type: "stdio", command: "npx", args: ["server"] },
        status: "connected",
        toolCount: 3,
      },
    ]);
    expect(rows).toHaveLength(3);
    expect(mcpListRowLabel(rows[0]!)).toContain("fs");
    expect(mcpListRowLabel(rows[0]!)).toContain("3 tools");
    expect(mcpListRowLabel(rows[1]!)).toBe("+ Add server");
    expect(mcpListRowLabel(rows[2]!)).toBe("↻ Reload connections");
  });

  it("shows needs auth in list row", () => {
    const label = mcpListRowLabel({
      kind: "server",
      server: {
        name: "github",
        config: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        status: "needs_auth",
        toolCount: 0,
        error: "missing required Authorization header",
      },
    });
    expect(label).toContain("needs auth");
  });

  it("shows auth hint in detail for needs_auth servers", () => {
    const lines = mcpServerDetailLines({
      name: "context7",
      config: { type: "http", url: "https://mcp.context7.com/mcp/oauth", oauth: true },
      status: "needs_auth",
      toolCount: 0,
      error: "Authentication required",
      hint: "Press a in /mcp detail to Authenticate",
    });
    expect(lines.some((l) => l.startsWith("status: needs auth"))).toBe(true);
    expect(lines.some((l) => l === "auth: oauth")).toBe(true);
    expect(lines.some((l) => l.startsWith("hint:"))).toBe(true);
  });
});
