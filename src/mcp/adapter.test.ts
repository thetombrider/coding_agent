import { describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { testAgentContext } from "../test-helpers.js";
import { renderMcpContent, toLocalTool } from "./adapter.js";

describe("renderMcpContent", () => {
  it("renders text blocks and placeholders for other types", () => {
    const out = renderMcpContent([
      { type: "text", text: "hello" },
      { type: "image" },
    ]);
    expect(out).toBe("hello\n[image]");
  });

  it("truncates very large output", () => {
    const out = renderMcpContent([{ type: "text", text: "x".repeat(200_000) }]);
    expect(out.length).toBeLessThan(200_000);
    expect(out).toContain("[output truncated");
  });
});

describe("toLocalTool", () => {
  const remote = {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object" as const, properties: {} },
  };

  it("namespaces tools and requires approval", async () => {
    const client = {
      callTool: vi.fn(async () => ({
        content: [{ type: "text", text: "file contents" }],
      })),
    } as unknown as Client;

    const tool = toLocalTool(client, "fs", remote);
    expect(tool.name).toBe("fs__read_file");
    expect(tool.needsApproval?.({}, testAgentContext("/tmp"))).toBe(true);

    const result = await tool.execute({ path: "a.txt" }, testAgentContext("/tmp"), new AbortController().signal);
    expect(result.output).toBe("file contents");
    expect(client.callTool).toHaveBeenCalledWith(
      { name: "read_file", arguments: { path: "a.txt" } },
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("marks MCP errors as tool errors", async () => {
    const client = {
      callTool: vi.fn(async () => ({
        content: [{ type: "text", text: "permission denied" }],
        isError: true,
      })),
    } as unknown as Client;

    const tool = toLocalTool(client, "fs", remote);
    const result = await tool.execute({}, testAgentContext("/tmp"), new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("permission denied");
  });
});
