import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchTool, isBlockedHost, isLoopbackHost } from "./fetch.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";

const localWorkspace = createLocalWorkspace();
const ctx: AgentContext = { cwd: "/tmp", messages: [], workspace: localWorkspace };
const signal = new AbortController().signal;

function mockResponse(
  body: string,
  init?: { status?: number; statusText?: string; contentType?: string; url?: string },
): Response {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init?.statusText ?? "OK",
    url: init?.url ?? "",
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-type" ? (init?.contentType ?? "text/html") : null,
    },
    text: async () => body,
  } as unknown as Response;
}

describe("isLoopbackHost", () => {
  it("identifies loopback hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("app.localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("does not treat private ranges as loopback", () => {
    expect(isLoopbackHost("10.1.2.3")).toBe(false);
    expect(isLoopbackHost("192.168.0.1")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});

describe("isBlockedHost", () => {
  it("blocks loopback and private ranges by default", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("0.0.0.0")).toBe(true);
    expect(isBlockedHost("10.1.2.3")).toBe(true);
    expect(isBlockedHost("192.168.0.1")).toBe(true);
    expect(isBlockedHost("172.16.5.5")).toBe(true);
    expect(isBlockedHost("172.31.255.255")).toBe(true);
    expect(isBlockedHost("169.254.169.254")).toBe(true);
    expect(isBlockedHost("::1")).toBe(true);
  });

  it("allows loopback only when allowLocalhost is set", () => {
    expect(isBlockedHost("localhost", { allowLocalhost: true })).toBe(false);
    expect(isBlockedHost("127.0.0.1", { allowLocalhost: true })).toBe(false);
    expect(isBlockedHost("::1", { allowLocalhost: true })).toBe(false);
    expect(isBlockedHost("192.168.0.1", { allowLocalhost: true })).toBe(true);
    expect(isBlockedHost("10.1.2.3", { allowLocalhost: true })).toBe(true);
    expect(isBlockedHost("169.254.169.254", { allowLocalhost: true })).toBe(true);
    expect(isBlockedHost("0.0.0.0", { allowLocalhost: true })).toBe(true);
  });

  it("allows public hosts", () => {
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("8.8.8.8")).toBe(false);
    expect(isBlockedHost("172.32.0.1")).toBe(false);
    expect(isBlockedHost("172.15.0.1")).toBe(false);
  });
});

describe("fetchTool", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-fetch-test-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("is read-only (does not require approval)", () => {
    expect(fetchTool.needsApproval?.({ url: "https://example.com" }, ctx)).toBe(false);
  });

  it("converts HTML to markdown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockResponse('<h1>Title</h1><p>Hello <a href="https://x.com">link</a> <strong>bold</strong></p>'),
      ),
    );
    const r = await fetchTool.execute({ url: "https://example.com" }, ctx, signal);
    expect(r.isError).toBeUndefined();
    expect(r.output).toContain("# Title");
    expect(r.output).toContain("[link](https://x.com)");
    expect(r.output).toContain("**bold**");
  });

  it("returns plain text when format=text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse("<p>just <em>words</em></p>")));
    const r = await fetchTool.execute({ url: "https://example.com", format: "text" }, ctx, signal);
    expect(r.output).toContain("just words");
    expect(r.output).not.toContain("*");
  });

  it("returns raw body when format=html", async () => {
    const html = "<h1>Raw</h1>";
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse(html)));
    const r = await fetchTool.execute({ url: "https://example.com", format: "html" }, ctx, signal);
    expect(r.output).toBe(html);
  });

  it("returns non-HTML bodies unchanged", async () => {
    const json = '{"a":1}';
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse(json, { contentType: "application/json" })));
    const r = await fetchTool.execute({ url: "https://api.example.com/x" }, ctx, signal);
    expect(r.output).toBe(json);
  });

  it("truncates output at 100KB", async () => {
    const big = `<p>${"a".repeat(200 * 1024)}</p>`;
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse(big)));
    const r = await fetchTool.execute({ url: "https://example.com" }, ctx, signal);
    expect(r.output.length).toBeLessThanOrEqual(100 * 1024 + 64);
    expect(r.output).toMatch(/truncated/);
  });

  it("blocks localhost (SSRF) without fetching", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const r = await fetchTool.execute({ url: "http://localhost:8080/admin" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/private|loopback/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("blocks private IP ranges (SSRF)", async () => {
    const r = await fetchTool.execute({ url: "http://192.168.1.1/" }, ctx, signal);
    expect(r.isError).toBe(true);
  });

  it("allows loopback when allowLocalhost is configured on local workspace", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ tools: { fetch: { allowLocalhost: true } } });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse('{"ok":true}', { contentType: "application/json" })),
    );

    const r = await fetchTool.execute({ url: "http://127.0.0.1:8000/health" }, ctx, signal);
    expect(r.isError).toBeUndefined();
    expect(r.output).toBe('{"ok":true}');
  });

  it("still blocks loopback when allowLocalhost is false", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ tools: { fetch: { allowLocalhost: false } } });

    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const r = await fetchTool.execute({ url: "http://127.0.0.1:8000/health" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores allowLocalhost on e2b workspace", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ tools: { fetch: { allowLocalhost: true } } });

    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const e2bCtx: AgentContext = {
      ...ctx,
      workspace: { ...ctx.workspace, kind: "e2b" },
    };
    const r = await fetchTool.execute({ url: "http://127.0.0.1:8000/health" }, e2bCtx, signal);
    expect(r.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("still blocks RFC1918 when allowLocalhost is configured", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ tools: { fetch: { allowLocalhost: true } } });

    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const r = await fetchTool.execute({ url: "http://192.168.1.1/" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) schemes", async () => {
    const r = await fetchTool.execute({ url: "file:///etc/passwd" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/scheme/i);
  });

  it("blocks redirects that land on a private host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse("secret", { url: "http://169.254.169.254/latest/meta-data" })),
    );
    const r = await fetchTool.execute({ url: "https://example.com" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/redirect/i);
    expect(r.output).not.toContain("secret");
  });

  it("blocks redirects to private hosts even when allowLocalhost is configured", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ tools: { fetch: { allowLocalhost: true } } });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse("secret", { url: "http://192.168.1.1/" })),
    );
    const r = await fetchTool.execute({ url: "http://127.0.0.1:8000/" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/redirect/i);
    expect(r.output).not.toContain("secret");
  });

  it("returns isError on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse("nope", { status: 404, statusText: "Not Found" })),
    );
    const r = await fetchTool.execute({ url: "https://example.com/missing" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("404");
  });

  it("returns isError when the network call throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await fetchTool.execute({ url: "https://example.com" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/ECONNREFUSED/);
  });
});
