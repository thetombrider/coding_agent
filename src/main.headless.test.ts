import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

function bunAvailable(): boolean {
  try {
    return spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

// End-to-end smoke test of the real entrypoint in headless + faux mode: argument
// parsing, the faux provider, a real tool round (read), and the final answer
// written to stdout — all deterministic and offline.
describe.runIf(bunAvailable())("orin --headless --faux", () => {
  let home: string;
  let work: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "orin-headless-home-"));
    work = mkdtempSync(join(tmpdir(), "orin-headless-work-"));
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it("runs the loop and prints the faux final answer", () => {
    const result = spawnSync("bun", [cliEntry, "--headless", "--faux", "hello"], {
      cwd: work,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, HOME: home },
    });

    expect(result.status).toBe(0);
    // The faux script always emits this final text regardless of tool results.
    expect(result.stdout).toContain("package.json lists 2 runtime dependencies");
    // The read tool actually executed against the temp cwd.
    expect(result.stdout).toContain("[tool read]");
  }, 70000);

  it("exits non-zero when --headless is given without a prompt", () => {
    const result = spawnSync("bun", [cliEntry, "--headless"], {
      cwd: work,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, HOME: home },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: orin --headless");
  }, 70000);
});
