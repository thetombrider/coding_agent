import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("saveMcpConfig helpers", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-mcp-save-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("upserts and removes servers in ~/.orin/mcp.json", async () => {
    const { loadMcpConfig, removeMcpServer, upsertMcpServer } = await import("./config.js");
    upsertMcpServer("fs", {
      type: "stdio",
      command: "npx",
      args: ["-y", "foo"],
    });
    expect(existsSync(join(home, ".orin", "mcp.json"))).toBe(true);

    const loaded = loadMcpConfig();
    expect(loaded.config.servers.fs).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["-y", "foo"],
    });

    removeMcpServer("fs");
    const raw = JSON.parse(readFileSync(join(home, ".orin", "mcp.json"), "utf8"));
    expect(raw.servers).toEqual({});
  });
});
