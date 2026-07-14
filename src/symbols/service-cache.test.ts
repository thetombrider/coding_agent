import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSymbolService } from "./service.js";
import { createLocalWorkspace } from "../workspace/local.js";
import { cachePath, loadCache } from "./cache.js";
import * as extract from "./extract.js";

describe("SymbolService cache persistence", () => {
  let home: string;
  let prevHome: string | undefined;
  let cwd: string;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), "orin-symbols-cache-home-"));
    process.env.HOME = home;
    cwd = await mkdtemp(join(tmpdir(), "orin-symbols-cache-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src/math.ts"),
      "export function add(a: number, b: number) { return a + b; }\n",
    );
    await writeFile(
      join(cwd, "src/app.ts"),
      "import { add } from './math.js';\nexport function run() { return add(1, 2); }\n",
    );
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes cache after warm and reuses it on the next session", async () => {
    const workspace = createLocalWorkspace();
    const first = createSymbolService();
    await first.warmIndex(workspace, cwd);
    expect(loadCache(cwd)?.files["src/math.ts"]?.symbols.some((s) => s.name === "add")).toBe(true);

    const extractSpy = vi.spyOn(extract, "extractFromSource");
    const second = createSymbolService();
    await second.warmIndex(workspace, cwd);
    expect(extractSpy).not.toHaveBeenCalled();
    const { symbols } = second.query("add", "definitions");
    expect(symbols.some((s) => s.name === "add")).toBe(true);
  });

  it("incrementally re-indexes only changed files", async () => {
    const workspace = createLocalWorkspace();
    const first = createSymbolService();
    await first.warmIndex(workspace, cwd);

    await writeFile(
      join(cwd, "src/math.ts"),
      "export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\n",
    );

    const extractSpy = vi.spyOn(extract, "extractFromSource");
    const second = createSymbolService();
    await second.warmIndex(workspace, cwd);
    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(extractSpy.mock.calls[0]?.[0]).toBe("src/math.ts");
    const { symbols } = second.query("sub", "definitions");
    expect(symbols.some((s) => s.name === "sub")).toBe(true);
    expect(loadCache(cwd)?.files["src/app.ts"]).toBeDefined();
  });

  it("incrementally re-indexes changed Python files", async () => {
    await writeFile(join(cwd, "src/util.py"), "def foo():\n    return 1\n");

    const workspace = createLocalWorkspace();
    const first = createSymbolService();
    await first.warmIndex(workspace, cwd);

    await writeFile(join(cwd, "src/util.py"), "def foo():\n    return 1\n\ndef bar():\n    return 2\n");

    const extractSpy = vi.spyOn(extract, "extractFromSource");
    const second = createSymbolService();
    await second.warmIndex(workspace, cwd);
    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(extractSpy.mock.calls[0]?.[0]).toBe("src/util.py");
    const { symbols } = second.query("bar", "definitions");
    expect(symbols.some((s) => s.name === "bar")).toBe(true);
  });

  it("falls back to full warm when cache is corrupt", async () => {
    const workspace = createLocalWorkspace();
    await mkdir(join(home, ".orin", "index"), { recursive: true });
    await writeFile(cachePath(cwd), "{bad json", "utf8");

    const service = createSymbolService();
    await service.warmIndex(workspace, cwd);
    const { symbols } = service.query("add", "definitions");
    expect(symbols.some((s) => s.name === "add")).toBe(true);
    expect(loadCache(cwd)?.files["src/math.ts"]).toBeDefined();
  });
});
