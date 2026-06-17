import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { discoverAgentsFiles, discoverSystemFile } from "./discovery.js";

describe("discoverAgentsFiles", () => {
  it("collects AGENTS.md from cwd to repo root, then global", async () => {
    const root = await mkdtemp(join(tmpdir(), "agents-discover-"));
    const sub = join(root, "pkg", "src");
    await mkdir(sub, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root rules");
    await writeFile(join(sub, "AGENTS.md"), "nested rules");

    const files = discoverAgentsFiles(sub);
    expect(files.map((f) => f.content)).toEqual(["root rules", "nested rules"]);
    expect(files[1].path).toBe(join(sub, "AGENTS.md"));
  });
});

describe("discoverSystemFile", () => {
  it("returns the closest SYSTEM.md walking up from cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "system-discover-"));
    const sub = join(root, "a", "b");
    await mkdir(sub, { recursive: true });
    await writeFile(join(root, "SYSTEM.md"), "root system");
    await writeFile(join(sub, "SYSTEM.md"), "nested system");

    const file = discoverSystemFile(sub);
    expect(file?.content).toBe("nested system");
  });
});
