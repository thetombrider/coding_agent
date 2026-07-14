import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { createSymbolService } from "./service.js";
import { createLocalWorkspace } from "../workspace/local.js";

describe("SymbolService", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-symbols-"));
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
    await rm(cwd, { recursive: true, force: true });
  });

  it("warms index and finds definitions", async () => {
    const service = createSymbolService();
    const workspace = createLocalWorkspace();
    await service.warmIndex(workspace, cwd);
    const { symbols } = service.query("add", "definitions");
    expect(symbols.some((s) => s.name === "add" && s.file === "src/math.ts")).toBe(true);
  });

  it("finds callers", async () => {
    const service = createSymbolService();
    const workspace = createLocalWorkspace();
    await service.warmIndex(workspace, cwd);
    const { symbols } = service.query("add", "callers");
    expect(symbols.some((s) => s.name === "run")).toBe(true);
  });

  it("warms Python index and finds definitions and callers", async () => {
    await writeFile(
      join(cwd, "src/math.py"),
      "def add(a, b):\n    return a + b\n",
    );
    await writeFile(
      join(cwd, "src/app.py"),
      "from math import add\n\ndef run():\n    return add(1, 2)\n",
    );

    const service = createSymbolService();
    const workspace = createLocalWorkspace();
    await service.warmIndex(workspace, cwd);

    const { symbols: defs } = service.query("add", "definitions");
    expect(defs.some((s) => s.name === "add" && s.file === "src/math.py")).toBe(true);

    const { symbols: callers } = service.query("add", "callers");
    expect(callers.some((s) => s.name === "run")).toBe(true);
  });
});
