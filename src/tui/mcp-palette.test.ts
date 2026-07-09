import { describe, expect, it } from "vitest";
import { mcpListRowLabel, mcpListRows, mcpPaletteHint, mcpServerDetailLines } from "./mcp-palette.js";

describe("mcp palette", () => {
  it("lists servers plus add/reload actions", () => {
    const rows = mcpListRows([
      {
        name: "fs",
        config: { type: "stdio", command: "npx", args: ["server"] },
        status: "connected",
        toolCount: 3,
        scope: "global" as const,
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
        scope: "global" as const,
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
      scope: "global" as const,
    });
    expect(lines.some((l) => l.startsWith("status: needs auth"))).toBe(true);
    expect(lines.some((l) => l === "auth: oauth")).toBe(true);
    expect(lines.some((l) => l.startsWith("hint:"))).toBe(true);
  });

  it("shows scope in list row label", () => {
    const globalLabel = mcpListRowLabel({
      kind: "server",
      server: {
        name: "fs",
        config: { type: "stdio", command: "echo" },
        status: "connected",
        toolCount: 2,
        scope: "global" as const,
      },
    });
    expect(globalLabel).toContain("global");

    const projectLabel = mcpListRowLabel({
      kind: "server",
      server: {
        name: "local",
        config: { type: "stdio", command: "echo" },
        status: "connected",
        toolCount: 1,
        scope: "project" as const,
      },
    });
    expect(projectLabel).toContain("project");
  });

  it("shows scope in detail lines", () => {
    const lines = mcpServerDetailLines({
      name: "local",
      config: { type: "stdio", command: "echo" },
      status: "connected",
      toolCount: 0,
      scope: "project" as const,
    });
    expect(lines.some((l) => l === "scope: project")).toBe(true);
  });

  it("shows autoApprove list in detail lines when present", () => {
    const lines = mcpServerDetailLines({
      name: "fs",
      config: { type: "stdio", command: "echo", autoApprove: ["read_file", "list_directory"] },
      status: "connected",
      toolCount: 2,
      scope: "global" as const,
    });
    expect(lines.some((l) => l === "autoApprove: read_file, list_directory")).toBe(true);
  });

  it("omits autoApprove line when list is empty or absent", () => {
    const lines = mcpServerDetailLines({
      name: "fs",
      config: { type: "stdio", command: "echo" },
      status: "connected",
      toolCount: 0,
      scope: "global" as const,
    });
    expect(lines.every((l) => !l.startsWith("autoApprove:"))).toBe(true);
  });

  it("detail hint includes enable/disable toggle", () => {
    expect(mcpPaletteHint("detail")).toContain("d enable/disable");
  });
});
