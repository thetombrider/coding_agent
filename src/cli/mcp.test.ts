import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { runMcpCli } from "./mcp.js";
import { loadMcpConfig } from "../mcp/config.js";
import { loadMcpServers } from "../mcp/loader.js";
import { connectServer, type ConnectedMcpServer, type RemoteTool } from "../mcp/client.js";
import { authenticateMcpServer } from "../mcp/oauth.js";

vi.mock("../mcp/config.js");
vi.mock("../mcp/loader.js");
vi.mock("../mcp/client.js");
vi.mock("../mcp/oauth.js");

describe("runMcpCli", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit:${code}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints usage and exits for unknown subcommands", async () => {
    await expect(runMcpCli(["foo"])).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  describe("list", () => {
    it("reports no configured servers", async () => {
      vi.mocked(loadMcpConfig).mockReturnValue({
        config: { servers: {} },
        scopes: {},
        warnings: [],
      });

      await runMcpCli(["list"]);

      expect(loadMcpConfig).toHaveBeenCalledWith(process.cwd());
      expect(logSpy).toHaveBeenCalledWith("No MCP servers configured.");
    });

    it("prints configured servers and their status", async () => {
      vi.mocked(loadMcpConfig).mockReturnValue({
        config: {
          servers: {
            fs: { type: "stdio", command: "echo" } as const,
            gh: { type: "http", url: "https://api.github.com" } as const,
            off: { type: "stdio", command: "cat", disabled: true } as const,
          },
        },
        scopes: { fs: "global", gh: "project", off: "global" },
        warnings: [],
      });

      await runMcpCli(["list"]);

      const header = logSpy.mock.calls[0]?.[0];
      expect(header).toMatch(/NAME\s+SCOPE\s+STATUS\s+CONFIG/);

      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((line) => line.includes("fs") && line.includes("configured") && line.includes("echo"))).toBe(true);
      expect(lines.some((line) => line.includes("gh") && line.includes("project") && line.includes("https://api.github.com"))).toBe(true);
      expect(lines.some((line) => line.includes("off") && line.includes("disabled"))).toBe(true);
    });

    it("prints config warnings to stderr", async () => {
      vi.mocked(loadMcpConfig).mockReturnValue({
        config: { servers: {} },
        scopes: {},
        warnings: ["Failed to parse ~/.orin/mcp.json"],
      });

      await runMcpCli(["list"]);

      expect(warnSpy).toHaveBeenCalledWith("Failed to parse ~/.orin/mcp.json");
    });

    it("probes servers when --live is passed", async () => {
      const dispose = vi.fn();
      vi.mocked(loadMcpServers).mockResolvedValue({
        tools: [],
        servers: [
          {
            name: "fs",
            config: { type: "stdio", command: "echo" },
            scope: "global",
            status: "connected",
            toolCount: 3,
          },
          {
            name: "gh",
            config: { type: "http", url: "https://api.github.com" },
            scope: "project",
            status: "needs_auth",
            toolCount: 0,
          },
        ],
        warnings: [],
        statusHint: "MCP: fs (3 tools) · gh needs auth",
        dispose,
      });

      await runMcpCli(["list", "--live"]);

      expect(loadMcpServers).toHaveBeenCalledWith(process.cwd());
      expect(dispose).toHaveBeenCalled();

      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((line) => line.includes("3 tools"))).toBe(true);
      expect(lines.some((line) => line.includes("needs auth"))).toBe(true);
    });
  });

  describe("debug", () => {
    it("exits with usage when server name is missing", async () => {
      await expect(runMcpCli(["debug"])).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith("Usage: orin mcp debug <server>");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when the server is not configured", async () => {
      vi.mocked(loadMcpConfig).mockReturnValue({
        config: { servers: {} },
        scopes: {},
        warnings: [],
      });

      await expect(runMcpCli(["debug", "missing"])).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith('MCP server "missing" not found.');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("connects, lists tools, and closes the client", async () => {
      vi.mocked(loadMcpConfig).mockReturnValue({
        config: {
          servers: {
            fs: { type: "stdio", command: "echo" } as const,
          },
        },
        scopes: {},
        warnings: [],
      });

      const close = vi.fn().mockResolvedValue(undefined);
      vi.mocked(connectServer).mockResolvedValue({
        client: { close } as unknown as ConnectedMcpServer["client"],
        name: "fs",
        tools: [
          { name: "read", description: "Read a file", inputSchema: { type: "object" } },
          { name: "list", inputSchema: { type: "object" } },
        ] as RemoteTool[],
      });

      await runMcpCli(["debug", "fs"]);

      expect(connectServer).toHaveBeenCalledWith("fs", { type: "stdio", command: "echo" });
      expect(close).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Connected to "fs" — 2 tools:');
      expect(logSpy).toHaveBeenCalledWith("  read: Read a file");
      expect(logSpy).toHaveBeenCalledWith("  list");
    });

    it("prints connection errors and exits non-zero", async () => {
      vi.mocked(loadMcpConfig).mockReturnValue({
        config: {
          servers: {
            fs: { type: "stdio", command: "echo" } as const,
          },
        },
        scopes: {},
        warnings: [],
      });

      vi.mocked(connectServer).mockRejectedValue(new Error("connection refused"));

      await expect(runMcpCli(["debug", "fs"])).rejects.toThrow();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Connection failed"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Hint:"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("auth", () => {
    it("authenticates and prints the tool count", async () => {
      vi.mocked(authenticateMcpServer).mockResolvedValue({ ok: true, toolCount: 5 });

      await runMcpCli(["auth", "github"]);

      expect(authenticateMcpServer).toHaveBeenCalledWith("github", {
        authorizationCode: undefined,
        openBrowser: true,
      });
      expect(logSpy).toHaveBeenCalledWith("Authenticated — 5 tools available.");
    });

    it("exits with usage when server name is missing", async () => {
      await expect(runMcpCli(["auth"])).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
