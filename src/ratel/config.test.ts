import { describe, expect, it, vi } from "vitest";

describe("resolveRatelSettings", () => {
  it("pins search_symbols by default alongside the other core read tools", async () => {
    vi.resetModules();
    vi.doMock("../config/config.js", () => ({ loadConfig: () => ({}) }));
    const { resolveRatelSettings } = await import("./config.js");

    expect(resolveRatelSettings().pinnedTools).toContain("search_symbols");
  });

  it("strips MCP tools out of a user-supplied pinnedTools override (issue #324)", async () => {
    vi.resetModules();
    vi.doMock("../config/config.js", () => ({
      loadConfig: () => ({
        ratel: {
          pinnedTools: ["read", "fs__list_directory", "context7__query-docs", "search_symbols"],
        },
      }),
    }));
    const { resolveRatelSettings } = await import("./config.js");

    expect(resolveRatelSettings().pinnedTools).toEqual(["read", "search_symbols"]);
  });
});
