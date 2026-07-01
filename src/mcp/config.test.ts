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

  describe("env var expansion", () => {
    function withEnv(extra: Record<string, string> = {}) {
      return { ...extra };
    }

    it("expands ${env:VAR} in command, args, env, and url at load time", async () => {
      mkdirSync(join(home, ".orin"), { recursive: true });
      writeFileSync(
        join(home, ".orin", "mcp.json"),
        JSON.stringify({
          servers: {
            fs: {
              type: "stdio",
              command: "${env:ORIN_TEST_BIN}",
              args: ["--root=${env:ORIN_TEST_ROOT}", "."],
              env: { API_KEY: "${env:ORIN_TEST_KEY}" },
            },
            http: {
              type: "http",
              url: "https://${env:ORIN_TEST_HOST}/mcp",
              headers: { Authorization: "Bearer ${env:ORIN_TEST_KEY}" },
            },
          },
        }),
      );
      const { loadMcpConfig } = await import("./config.js");
      const { config, warnings } = loadMcpConfig(
        undefined,
        withEnv({
          ORIN_TEST_BIN: "npx",
          ORIN_TEST_ROOT: "/tmp",
          ORIN_TEST_KEY: "secret-token",
          ORIN_TEST_HOST: "api.example.com",
        }),
      );
      expect(warnings).toEqual([]);
      expect(config.servers.fs).toMatchObject({
        type: "stdio",
        command: "npx",
        args: ["--root=/tmp", "."],
        env: { API_KEY: "secret-token" },
      });
      expect(config.servers.http).toMatchObject({
        type: "http",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer secret-token" },
      });
    });

    it("expands ${VAR} (no prefix) the same way Claude Code does", async () => {
      mkdirSync(join(home, ".orin"), { recursive: true });
      writeFileSync(
        join(home, ".orin", "mcp.json"),
        JSON.stringify({
          servers: {
            http: {
              type: "http",
              url: "https://example.com/mcp",
              headers: { Authorization: "Bearer ${ORIN_TEST_CC_TOKEN}" },
            },
          },
        }),
      );
      const { loadMcpConfig } = await import("./config.js");
      const { config } = loadMcpConfig(undefined, withEnv({ ORIN_TEST_CC_TOKEN: "cc-secret" }));
      expect((config.servers.http as { headers: Record<string, string> }).headers.Authorization).toBe(
        "Bearer cc-secret",
      );
    });

    it("uses ${env:VAR:-default} when the env var is unset", async () => {
      mkdirSync(join(home, ".orin"), { recursive: true });
      writeFileSync(
        join(home, ".orin", "mcp.json"),
        JSON.stringify({
          servers: {
            http: {
              type: "http",
              url: "${env:ORIN_TEST_MISSING_URL:-https://fallback.example.com/mcp}",
            },
          },
        }),
      );
      const { loadMcpConfig } = await import("./config.js");
      const { config, warnings } = loadMcpConfig(undefined, withEnv());
      expect(warnings).toEqual([]);
      const httpServer = config.servers.http;
      if (httpServer?.type !== "http") throw new Error("expected http server");
      expect(httpServer.url).toBe("https://fallback.example.com/mcp");
    });

    it("skips a server and warns when a required env var is missing", async () => {
      mkdirSync(join(home, ".orin"), { recursive: true });
      writeFileSync(
        join(home, ".orin", "mcp.json"),
        JSON.stringify({
          servers: {
            github: {
              type: "http",
              url: "https://api.githubcopilot.com/mcp/",
              headers: { Authorization: "Bearer ${env:ORIN_TEST_ABSENT_TOKEN}" },
            },
            fs: { type: "stdio", command: "npx" },
          },
        }),
      );
      const { loadMcpConfig } = await import("./config.js");
      const { config, warnings } = loadMcpConfig(undefined, withEnv());
      expect(Object.keys(config.servers)).toEqual(["fs"]);
      expect(
        warnings.some(
          (w) => w.includes('MCP server "github"') && w.includes("${ORIN_TEST_ABSENT_TOKEN}"),
        ),
      ).toBe(true);
    });

    it("skips a server when the expanded URL is not a valid URL", async () => {
      mkdirSync(join(home, ".orin"), { recursive: true });
      writeFileSync(
        join(home, ".orin", "mcp.json"),
        JSON.stringify({
          servers: {
            bad: { type: "http", url: "${env:ORIN_TEST_HOST}" },
          },
        }),
      );
      const { loadMcpConfig } = await import("./config.js");
      const { config, warnings } = loadMcpConfig(
        undefined,
        withEnv({ ORIN_TEST_HOST: "not a url at all" }),
      );
      expect(config.servers.bad).toBeUndefined();
      expect(warnings.some((w) => w.includes('MCP server "bad"') && w.includes("invalid url"))).toBe(
        true,
      );
    });

    it("does not write expanded values back to mcp.json", async () => {
      mkdirSync(join(home, ".orin"), { recursive: true });
      const path = join(home, ".orin", "mcp.json");
      writeFileSync(
        path,
        JSON.stringify({
          servers: {
            http: {
              type: "http",
              url: "https://api.example.com/mcp",
              headers: { Authorization: "Bearer ${env:ORIN_TEST_PERSIST_TOKEN}" },
            },
          },
        }),
      );
      const { loadMcpConfig } = await import("./config.js");
      loadMcpConfig(undefined, withEnv({ ORIN_TEST_PERSIST_TOKEN: "do-not-write-me" }));
      const onDisk = readFileSync(path, "utf8");
      expect(onDisk).toContain("${env:ORIN_TEST_PERSIST_TOKEN}");
      expect(onDisk).not.toContain("do-not-write-me");
    });
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

  it("parses autoApprove list on stdio server", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: {
          fs: { type: "stdio", command: "echo", autoApprove: ["read_file", "list_directory"] },
        },
      }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { config } = loadMcpConfig();
    expect(config.servers.fs?.autoApprove).toEqual(["read_file", "list_directory"]);
  });

  it("parses autoApprove on http server", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: {
          gh: { type: "http", url: "https://mcp.example.com", autoApprove: ["search"] },
        },
      }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { config } = loadMcpConfig();
    expect(config.servers.gh?.autoApprove).toEqual(["search"]);
  });

  it("omits autoApprove when field is absent", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({ servers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { config } = loadMcpConfig();
    expect(config.servers.fs?.autoApprove).toBeUndefined();
  });

  it("filters non-string entries out of autoApprove", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: {
          fs: { type: "stdio", command: "echo", autoApprove: ["read_file", 42, null, "write"] },
        },
      }),
    );
    const { loadMcpConfig } = await import("./config.js");
    const { config } = loadMcpConfig();
    expect(config.servers.fs?.autoApprove).toEqual(["read_file", "write"]);
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
