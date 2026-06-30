import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
          fs: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          },
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
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    });
    expect(config.servers.github).toEqual({
      type: "http",
      url: "https://mcp.example.com/github",
    });
  });

  it("auto-repairs npx -y server placeholder to the filesystem MCP package", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    const path = join(home, ".orin", "mcp.json");
    writeFileSync(
      path,
      JSON.stringify({
        servers: {
          fs: { type: "stdio", command: "npx", args: ["-y", "server"] },
        },
      }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { config, warnings } = loadMcpConfig();
    expect(config.servers.fs?.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      ".",
    ]);
    expect(warnings.some((w) => w.includes("repaired stdio args"))).toBe(true);
    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      servers: { fs: { args: string[] } };
    };
    expect(saved.servers.fs.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      ".",
    ]);
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

  it("returns global scope for all servers when no projectCwd given", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({ servers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { scopes } = loadMcpConfig();
    expect(scopes.fs).toBe("global");
  });
});

describe("loadMcpConfig – project merge", () => {
  let home: string;
  let projectDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-mcp-merge-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "orin-mcp-merge-proj-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns global-only when project .mcp.json is missing", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({ servers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { config, scopes } = loadMcpConfig(projectDir);
    expect(Object.keys(config.servers)).toEqual(["fs"]);
    expect(scopes.fs).toBe("global");
  });

  it("merges project servers alongside global servers", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({ servers: { global: { type: "stdio", command: "global-cmd" } } }),
    );
    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({ servers: { local: { type: "stdio", command: "local-cmd" } } }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { config, scopes } = loadMcpConfig(projectDir);
    expect(Object.keys(config.servers).sort()).toEqual(["global", "local"]);
    expect(scopes.global).toBe("global");
    expect(scopes.local).toBe("project");
  });

  it("project server overrides global server with the same name", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({ servers: { fs: { type: "stdio", command: "global-fs" } } }),
    );
    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({ servers: { fs: { type: "stdio", command: "project-fs" } } }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { config, scopes } = loadMcpConfig(projectDir);
    expect(config.servers.fs).toMatchObject({ command: "project-fs" });
    expect(scopes.fs).toBe("project");
  });

  it("warns when project .mcp.json contains a raw Bearer token", async () => {
    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        servers: {
          api: {
            type: "http",
            url: "https://mcp.example.com",
            headers: { Authorization: "Bearer secret-token" },
          },
        },
      }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { warnings } = loadMcpConfig(projectDir);
    expect(warnings.some((w) => w.includes("raw Bearer token"))).toBe(true);
  });
});
