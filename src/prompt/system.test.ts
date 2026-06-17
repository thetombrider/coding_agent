import { describe, expect, it } from "vitest";
import { parseSystemMd, resolveSystemPrompt } from "./system.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseSystemMd", () => {
  it("defaults to append without frontmatter", () => {
    expect(parseSystemMd("extra rules")).toEqual({ mode: "append", body: "extra rules" });
  });

  it("honors replace mode in frontmatter", () => {
    const content = "---\nmode: replace\n---\nCustom persona";
    expect(parseSystemMd(content)).toEqual({ mode: "replace", body: "Custom persona" });
  });
});

describe("resolveSystemPrompt", () => {
  it("appends SYSTEM.md to the base prompt by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "system-resolve-"));
    await writeFile(join(cwd, "SYSTEM.md"), "Project-specific guidance");

    expect(resolveSystemPrompt(cwd, "Base persona")).toBe(
      "Base persona\n\nProject-specific guidance",
    );
  });

  it("replaces the base prompt when SYSTEM.md requests replace mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "system-replace-"));
    await writeFile(join(cwd, "SYSTEM.md"), "---\nmode: replace\n---\nOnly this");

    expect(resolveSystemPrompt(cwd, "Base persona")).toBe("Only this");
  });

  it("prefers the closest SYSTEM.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "system-nested-"));
    const sub = join(root, "nested");
    await mkdir(sub);
    await writeFile(join(root, "SYSTEM.md"), "root");
    await writeFile(join(sub, "SYSTEM.md"), "nested");

    expect(resolveSystemPrompt(sub, "Base")).toBe("Base\n\nnested");
  });
});
