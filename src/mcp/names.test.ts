import { describe, expect, it } from "vitest";
import { formatMcpToolLabel, isMcpTool } from "./names.js";

describe("MCP tool names", () => {
  it("detects namespaced MCP tools", () => {
    expect(isMcpTool("fs__read_file")).toBe(true);
    expect(isMcpTool("read")).toBe(false);
  });

  it("formats display labels", () => {
    expect(formatMcpToolLabel("fs__read_file")).toBe("fs · read_file");
    expect(formatMcpToolLabel("read")).toBe("read");
  });
});
