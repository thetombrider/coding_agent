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

  it("caps output at maxBuffer and terminates a runaway command", async () => {
    const ws = createLocalWorkspace();
    let bytes = 0;
    // `yes` streams forever; the byte cap must stop forwarding and kill it so the
    // call still resolves instead of hanging or exhausting memory (#146).
    const { truncated } = await ws.exec("yes x", process.cwd(), {
      onData: (c) => {
        bytes += c.length;
      },
      maxBuffer: 1000,
    });
    expect(truncated).toBe(true);
    expect(bytes).toBeLessThanOrEqual(1000);
    await ws.dispose();
  });

  it("leaves truncated unset when output stays under the cap", async () => {
    const ws = createLocalWorkspace();
    const { truncated } = await ws.exec("echo hi", process.cwd(), {
      onData: () => {},
      maxBuffer: 1000,
    });
    expect(truncated).toBeFalsy();
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

describe("safeRemoteLabel", () => {
  it("strips credentials from remote URLs", async () => {
    const { safeRemoteLabel } = await import("./seed.js");
    expect(safeRemoteLabel("https://user:token@github.com/org/repo.git")).toBe("org/repo");
    expect(safeRemoteLabel("git@github.com:org/repo.git")).toBe("org/repo");
  });
});
