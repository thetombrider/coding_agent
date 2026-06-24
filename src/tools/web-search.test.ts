import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";
import { formatExaResults } from "./web-search.js";

const ctx: AgentContext = { cwd: "/tmp", messages: [], workspace: createLocalWorkspace() };
const signal = new AbortController().signal;

function mockJsonResponse(body: unknown, init?: { status?: number }): Response {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("formatExaResults", () => {
  it("formats title, url, and highlights", () => {
    const out = formatExaResults([
      {
        title: "Example Page",
        url: "https://example.com/page",
        publishedDate: "2024-01-01",
        highlights: ["First excerpt", "Second excerpt"],
      },
    ]);
    expect(out).toContain("## 1. Example Page");
    expect(out).toContain("https://example.com/page");
    expect(out).toContain("- First excerpt");
  });

  it("returns a no-results message for an empty list", () => {
    expect(formatExaResults([])).toBe("No results found.");
  });
});

describe("webSearchTool", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-web-search-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("returns an error when Exa is not configured", async () => {
    const { webSearchTool: tool } = await import("./web-search.js");
    const r = await tool.execute({ query: "hello" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/not configured/i);
  });

  describe("with Exa configured", () => {
    beforeEach(async () => {
      const { saveExaApiKey } = await import("../config/config.js");
      saveExaApiKey("test-exa-key");
    });

    it("is read-only (does not require approval)", async () => {
      const { webSearchTool: tool } = await import("./web-search.js");
      expect(tool.needsApproval?.({ query: "test" }, ctx)).toBe(false);
    });

    it("calls Exa and formats results", async () => {
      const { webSearchTool: tool } = await import("./web-search.js");
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "x-api-key": "test-exa-key" });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        query: "typescript zod",
        numResults: 5,
        type: "auto",
        contents: { highlights: true },
      });
      return mockJsonResponse({
        results: [
          {
            title: "Zod docs",
            url: "https://zod.dev",
            highlights: ["TypeScript-first schema validation"],
          },
        ],
      });
    });
      vi.stubGlobal("fetch", fetchMock);

      const r = await tool.execute({ query: "typescript zod" }, ctx, signal);
      expect(r.isError).toBeUndefined();
      expect(r.output).toContain("Zod docs");
      expect(r.output).toContain("TypeScript-first schema validation");
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("passes category and numResults when provided", async () => {
      const { webSearchTool: tool } = await import("./web-search.js");
      vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          query: "LLM papers",
          numResults: 3,
          category: "research paper",
        });
        return mockJsonResponse({ results: [] });
      }),
      );

      const r = await tool.execute(
        { query: "LLM papers", numResults: 3, category: "research paper" },
        ctx,
        signal,
      );
      expect(r.output).toBe("No results found.");
    });

    it("returns isError on non-2xx responses", async () => {
      const { webSearchTool: tool } = await import("./web-search.js");
      vi.stubGlobal("fetch", vi.fn(async () => mockJsonResponse({ error: "bad key" }, { status: 401 })));
      const r = await tool.execute({ query: "test" }, ctx, signal);
      expect(r.isError).toBe(true);
      expect(r.output).toContain("401");
    });

    it("returns isError when the network call throws", async () => {
      const { webSearchTool: tool } = await import("./web-search.js");
      vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      );
      const r = await tool.execute({ query: "test" }, ctx, signal);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/ECONNREFUSED/);
    });

    it("truncates output at 100KB", async () => {
      const { webSearchTool: tool } = await import("./web-search.js");
      const huge = "x".repeat(200 * 1024);
      vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockJsonResponse({
          results: [{ title: "Big", url: "https://example.com", highlights: [huge] }],
        }),
      ),
      );
      const r = await tool.execute({ query: "big" }, ctx, signal);
      expect(r.output.length).toBeLessThanOrEqual(100 * 1024 + 64);
      expect(r.output).toMatch(/truncated/);
    });
  });
});
