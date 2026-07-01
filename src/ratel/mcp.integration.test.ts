import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolCatalog } from "@ratel-ai/sdk";
import { testAgentContext } from "../test-helpers.js";
import { coreToolsForRatel } from "./tools.js";

const registerMcpServer = vi.fn();

vi.mock("./register-mcp.js", () => ({
  registerMcpServer: (...args: unknown[]) => registerMcpServer(...args),
}));

type MockCatalog = ToolCatalog;

function mockMcpServer(
  catalog: MockCatalog,
  serverName: string,
  tools: Array<{ name: string; description: string }>,
) {
  const toolIds: string[] = [];
  for (const tool of tools) {
    const id = `${serverName}__${tool.name}`;
    catalog.register({
      id,
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      execute: async () => ({
        content: [{ type: "text", text: `${id} ok` }],
      }),
    });
    toolIds.push(id);
  }
  const close = vi.fn(async () => {});
  return { toolIds, close };
}

describe("loadMcpIntoRatelCatalog (mock MCP)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "orin-ratel-mcp-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    registerMcpServer.mockReset();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("tolerates one failed server and registers tools from a successful one", async () => {
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

    registerMcpServer.mockImplementation(async (catalog: MockCatalog, { name }: { name: string }) => {
      if (name === "bad") throw new Error("connection refused");
      return mockMcpServer(catalog, "good", [
        { name: "list_directory", description: "List files in a directory via MCP" },
      ]);
    });

    const { loadMcpIntoRatelCatalog } = await import("./mcp.js");
    const catalog = new ToolCatalog();
    const result = await loadMcpIntoRatelCatalog(catalog);

    expect([...new Set(result.tools.map((t) => t.name))]).toEqual(["good__list_directory"]);
    expect(result.tools[0]!.needsApproval?.({}, testAgentContext("/tmp"))).toBe(true);
    expect(result.warnings.some((w) => w.includes('"bad"'))).toBe(true);
    expect(result.statusHint).toContain("good (1 tools)");
    expect(result.servers.find((s) => s.name === "bad")?.status).toBe("failed");
    expect(catalog.get("good__list_directory")?.description).toContain("directory");
  });

  it("disposes registered MCP handles", async () => {
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: { fs: { type: "stdio", command: "echo" } },
      }),
    );

    const close = vi.fn(async () => {});
    registerMcpServer.mockImplementation(async (catalog: MockCatalog) => {
      const handle = mockMcpServer(catalog, "fs", [
        { name: "read_file", description: "Read a file via MCP" },
      ]);
      return { ...handle, close };
    });

    const { loadMcpIntoRatelCatalog } = await import("./mcp.js");
    const result = await loadMcpIntoRatelCatalog(new ToolCatalog());
    await result.dispose();

    expect(close).toHaveBeenCalled();
  });

  it("wrapCatalogMcpTool invokes through the Ratel catalog", async () => {
    const catalog = new ToolCatalog();
    mockMcpServer(catalog, "fs", [{ name: "read_file", description: "Read a file via MCP" }]);

    const { wrapCatalogMcpTool } = await import("./mcp.js");
    const tool = wrapCatalogMcpTool(catalog, "fs__read_file");
    const result = await tool.execute({ path: "a.txt" }, testAgentContext("/tmp"), new AbortController().signal);

    expect(result.output).toBe("fs__read_file ok");
    expect(result.isError).toBeUndefined();
  });
});

describe("OrinRatelBundle + mock MCP", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "orin-ratel-bundle-mcp-"));
    cwd = mkdtempSync(join(tmpdir(), "orin-ratel-cwd-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    registerMcpServer.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "mcp.json"),
      JSON.stringify({
        servers: {
          mock: { type: "stdio", command: "echo" },
        },
      }),
    );

    registerMcpServer.mockImplementation(async (catalog: MockCatalog) =>
      mockMcpServer(catalog, "mock", [
        { name: "list_directory", description: "List files in a directory via MCP" },
        { name: "read_file", description: "Read file contents from disk via MCP" },
        { name: "search_code", description: "Search code in the repository via MCP" },
      ]),
    );
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("ingests MCP tools into the catalog and pre-filters per turn", async () => {
    const { OrinRatelBundle } = await import("./catalog.js");
    const session = await OrinRatelBundle.create(cwd, {
      sessionId: "ratel-mcp-int",
      settings: {
        enabled: true,
        topKTools: 2,
        topKSkills: 1,
        pinnedTools: ["read", "search_capabilities", "invoke_tool"],
        controlFraction: 0,
      },
    });

    const nativeCount = coreToolsForRatel().length;
    expect(session.bundle.catalogSize()).toBe(nativeCount + 3);

    const { tools, injectedCount, telemetry } = session.bundle.resolveToolsForTurn(
      "list files in the project directory",
    );

    expect(injectedCount).toBeLessThan(session.bundle.catalogSize());
    expect(tools.some((t) => t.name === "search_capabilities")).toBe(true);
    expect(tools.some((t) => t.name === "invoke_tool")).toBe(true);
    expect(tools.some((t) => t.name === "mock__list_directory")).toBe(true);
    expect(telemetry.catalogSize).toBe(nativeCount + 3);
    expect(telemetry.featureFlag).toBe("tool_pool=ratel");

    await session.mcpDispose();
  });

  it("routes invoke_tool to MCP tools registered via registerMcpServer", async () => {
    const { OrinRatelBundle } = await import("./catalog.js");
    const session = await OrinRatelBundle.create(cwd, {
      settings: {
        enabled: true,
        topKTools: 1,
        topKSkills: 1,
        pinnedTools: ["invoke_tool"],
        controlFraction: 0,
      },
    });

    const invoke = session.bundle.executionTools().find((t) => t.name === "invoke_tool");
    expect(invoke).toBeDefined();

    const result = await invoke!.execute(
      { toolId: "mock__read_file", args: { path: "README.md" } },
      testAgentContext(cwd),
      new AbortController().signal,
    );

    expect(result.output).toBe("mock__read_file ok");
    await session.mcpDispose();
  });
});
