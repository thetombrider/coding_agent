import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loadMcpConfig", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-mcp-config-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("returns empty config when mcp.json is missing", async () => {
    const { loadMcpConfig } = await import("./config.js");
    const { config, warnings } = loadMcpConfig();
    expect(config.servers).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("returns empty config and warns on invalid JSON", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(join(home, ".orin", "mcp.json"), "{ not json");
    const { loadMcpConfig } = await import("./config.js");
    const { config, warnings } = loadMcpConfig();
    expect(config.servers).toEqual({});
    expect(warnings.some((w) => w.includes("Failed to parse"))).toBe(true);
  });

  it("loads valid stdio and http servers", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: {
          fs: { type: "stdio", command: "npx", args: ["-y", "server"] },
          github: { type: "http", url: "https://mcp.example.com/github" },
        },
      }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { config, warnings } = loadMcpConfig();
    expect(warnings).toEqual([]);
    expect(config.servers.fs).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "server"],
    });
    expect(config.servers.github).toEqual({
      type: "http",
      url: "https://mcp.example.com/github",
    });
  });

  it("skips invalid server entries with warnings", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: {
          bad: { type: "stdio" },
          good: { type: "ws", url: "wss://example.com/mcp" },
        },
      }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { config, warnings } = loadMcpConfig();
    expect(Object.keys(config.servers)).toEqual(["good"]);
    expect(warnings.some((w) => w.includes('MCP server "bad"'))).toBe(true);
  });
});
