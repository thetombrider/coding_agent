import { describe, expect, it } from "vitest";
import { mcpListRowLabel, mcpListRows } from "./mcp-palette.js";

describe("mcp palette", () => {
  it("lists servers plus add/reload actions", () => {
    const rows = mcpListRows([
      {
        name: "fs",
        config: { type: "stdio", command: "npx", args: ["server"] },
        connected: true,
        toolCount: 3,
      },
    ]);
    expect(rows).toHaveLength(3);
    expect(mcpListRowLabel(rows[0]!)).toContain("fs");
    expect(mcpListRowLabel(rows[1]!)).toBe("+ Add server");
    expect(mcpListRowLabel(rows[2]!)).toBe("↻ Reload connections");
  });
});
