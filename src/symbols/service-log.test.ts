import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSymbolService } from "./service.js";
import { createLocalWorkspace } from "../workspace/local.js";

describe("SymbolService logging", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-symbols-log-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src/a.ts"), "export function foo() {}\n");
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("does not write warm stats to stderr by default", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const service = createSymbolService();
    await service.warmIndex(createLocalWorkspace(), cwd);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("writes warm stats to stderr when logWarmStats is enabled", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const service = createSymbolService({ logWarmStats: true });
    await service.warmIndex(createLocalWorkspace(), cwd);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[symbols] Indexed"));
    errSpy.mockRestore();
  });
});
