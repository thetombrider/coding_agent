import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteMcpOAuthStore,
  hasMcpOAuthSession,
  mcpOAuthStorePath,
  updateMcpOAuthStore,
} from "./oauth-store.js";

describe("mcp oauth store", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "orin-oauth-store-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("persists tokens outside mcp.json", () => {
    updateMcpOAuthStore("context7", {
      tokens: { access_token: "tok", token_type: "Bearer" },
    });
    const path = mcpOAuthStorePath("context7");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      tokens: { access_token: "tok" },
    });
    expect(hasMcpOAuthSession("context7")).toBe(true);
    deleteMcpOAuthStore("context7");
    expect(existsSync(path)).toBe(false);
  });
});
