import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchTool,
  formatFetchedBody,
  isPrivateHostname,
  truncateOutput,
  validateFetchUrl,
} from "./fetch.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";

describe("validateFetchUrl", () => {
  it("rejects non-http schemes", () => {
    const result = validateFetchUrl("file:///etc/passwd");
    expect(result).toEqual({
      error: 'Invalid URL protocol "file:". Only http: and https: are supported.',
    });
  });

  it("blocks localhost", () => {
    const result = validateFetchUrl("http://localhost/docs");
    expect(result).toEqual({
      error: "Cannot fetch from internal/private network address: localhost",
    });
  });

  it("blocks private IPs", () => {
    expect(validateFetchUrl("http://192.168.1.1/")).toEqual({
      error: "Cannot fetch from internal/private network address: 192.168.1.1",
    });
    expect(validateFetchUrl("http://10.0.0.5/")).toEqual({
      error: "Cannot fetch from internal/private network address: 10.0.0.5",
    });
    expect(validateFetchUrl("http://172.16.0.1/")).toEqual({
      error: "Cannot fetch from internal/private network address: 172.16.0.1",
    });
  });

  it("allows public https URLs", () => {
    const result = validateFetchUrl("https://example.com/page");
    expect(result).toBeInstanceOf(URL);
    expect((result as URL).hostname).toBe("example.com");
  });
});

describe("isPrivateHostname", () => {
  it("detects RFC-1918 ranges", () => {
    expect(isPrivateHostname("172.31.255.1")).toBe(true);
    expect(isPrivateHostname("172.15.0.1")).toBe(false);
    expect(isPrivateHostname("example.com")).toBe(false);
  });
});

describe("formatFetchedBody", () => {
  it("converts HTML to markdown", () => {
    const body = "<h1>Title</h1><p>Hello <a href=\"https://x.test\">link</a></p>";
    expect(formatFetchedBody(body, "text/html", "markdown")).toContain("# Title");
    expect(formatFetchedBody(body, "text/html", "markdown")).toContain("[link](https://x.test)");
  });

  it("returns raw HTML when requested", () => {
    const body = "<p>keep</p>";
    expect(formatFetchedBody(body, "text/html", "html")).toBe(body);
  });
});

describe("truncateOutput", () => {
  it("truncates at the byte limit", () => {
    const body = "x".repeat(200_000);
    const truncated = truncateOutput(body, 100 * 1024);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(100 * 1024);
    expect(truncated).toContain("[Content truncated");
  });
});

describe("fetchTool", () => {
  const ctx: AgentContext = {
    cwd: "/tmp",
    messages: [],
    workspace: createLocalWorkspace(),
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not require approval", () => {
    expect(fetchTool.needsApproval?.({ url: "https://example.com" }, ctx)).toBe(false);
  });

  it("returns markdown for HTML responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<h1>Docs</h1><p>Welcome</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const result = await fetchTool.execute(
      { url: "https://example.com/docs" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("# Docs");
    expect(result.output).toContain("Welcome");
  });

  it("returns isError for non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404, statusText: "Not Found" })),
    );

    const result = await fetchTool.execute(
      { url: "https://example.com/missing" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("HTTP 404");
  });

  it("blocks SSRF targets before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTool.execute(
      { url: "http://127.0.0.1/admin" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("internal/private network");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
