import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const connectServer = vi.fn();

vi.mock("./client.js", () => ({
  connectServer: (...args: unknown[]) => connectServer(...args),
}));

describe("loadMcpServers", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "orin-mcp-loader-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    connectServer.mockReset();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("tolerates one failed server and loads tools from a successful one", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: {
          good: { type: "stdio", command: "echo" },
          bad: { type: "http", url: "http://localhost:1" },
        },
      }),
    );

    connectServer.mockImplementation(async (name: string) => {
      if (name === "bad") throw new Error("connection refused");
      return {
        client: { close: vi.fn(async () => {}) },
        name: "good",
        tools: [{ name: "list_directory", inputSchema: { type: "object" } }],
      };
    });

    const { loadMcpServers } = await import("./loader.js");
    const result = await loadMcpServers();

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe("good__list_directory");
    expect(result.warnings.some((w) => w.includes('"bad"'))).toBe(true);
    expect(result.statusHint).toContain("good (1 tools)");
    expect(result.statusHint).toContain("bad failed");
    expect(result.servers.find((s) => s.name === "bad")?.status).toBe("failed");
  });

  it("classifies auth failures as needs_auth", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: {
          github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        },
      }),
    );

    connectServer.mockRejectedValue(new Error("missing required Authorization header"));

    const { loadMcpServers } = await import("./loader.js");
    const result = await loadMcpServers();

    expect(result.servers[0]?.status).toBe("needs_auth");
    expect(result.statusHint).toContain("github needs auth");
    expect(result.servers[0]?.hint).toMatch(/Bearer token/i);
  });

  it("skips disabled servers without connecting", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: {
          off: { type: "stdio", command: "echo", disabled: true },
        },
      }),
    );

    const { loadMcpServers } = await import("./loader.js");
    const result = await loadMcpServers();

    expect(connectServer).not.toHaveBeenCalled();
    expect(result.servers[0]?.status).toBe("disabled");
    expect(result.statusHint).toContain("off disabled");
  });

  it("disposes connected clients", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: { fs: { type: "stdio", command: "echo" } },
      }),
    );

    const close = vi.fn(async () => {});
    connectServer.mockResolvedValue({
      client: { close },
      name: "fs",
      tools: [],
    });

    const { loadMcpServers } = await import("./loader.js");
    const result = await loadMcpServers();
    await result.dispose();

    expect(close).toHaveBeenCalled();
  });

  it("annotates global servers with scope=global", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: { fs: { type: "stdio", command: "echo" } },
      }),
    );

    connectServer.mockResolvedValue({
      client: { close: vi.fn(async () => {}) },
      name: "fs",
      tools: [],
    });

    const { loadMcpServers } = await import("./loader.js");
    const result = await loadMcpServers();
    expect(result.servers[0]?.scope).toBe("global");
  });

  it("annotates project servers with scope=project when projectCwd is provided", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "orin-loader-proj-"));
    try {
      writeFileSync(
        join(projectDir, ".mcp.json"),
        JSON.stringify({
          servers: { local: { type: "stdio", command: "echo" } },
        }),
      );

      connectServer.mockResolvedValue({
        client: { close: vi.fn(async () => {}) },
        name: "local",
        tools: [],
      });

      const { loadMcpServers } = await import("./loader.js");
      const result = await loadMcpServers(projectDir);
      expect(result.servers.find((s) => s.name === "local")?.scope).toBe("project");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
