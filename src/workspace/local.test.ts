import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalWorkspace } from "./local.js";

describe("createLocalWorkspace", () => {
  it("runs a command and streams output", async () => {
    const ws = createLocalWorkspace();
    const chunks: string[] = [];
    const { exitCode } = await ws.exec("echo hello", process.cwd(), {
      onData: (c) => chunks.push(c.toString()),
    });
    expect(exitCode).toBe(0);
    expect(chunks.join("")).toContain("hello");
    await ws.dispose();
  });

  it("reads and writes files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orin-ws-"));
    const ws = createLocalWorkspace();
    const file = join(dir, "nested", "a.txt");
    try {
      await ws.writeFile(file, "content");
      expect(await ws.readFile(file)).toBe("content");
    } finally {
      await ws.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists directory entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orin-ws-"));
    const ws = createLocalWorkspace();
    try {
      await writeFile(join(dir, "one.txt"), "a");
      await writeFile(join(dir, "two.txt"), "b");
      const names = await ws.list(dir);
      expect(names.sort()).toEqual(["one.txt", "two.txt"]);
    } finally {
      await ws.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns non-zero exit code on failure", async () => {
    const ws = createLocalWorkspace();
    const { exitCode } = await ws.exec("exit 3", process.cwd(), { onData: () => {} });
    expect(exitCode).toBe(3);
    await ws.dispose();
  });
});

describe("getGitOriginUrl", () => {
  it("returns origin url for this repo", async () => {
    const { getGitOriginUrl } = await import("./seed.js");
    const url = getGitOriginUrl(process.cwd());
    expect(url).toBeTruthy();
  });
});
