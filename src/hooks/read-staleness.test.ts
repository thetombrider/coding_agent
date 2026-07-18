import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../config/config.js";
import { createHookRegistry } from "../hooks/registry.js";
import { attachReadTracker, installReadStalenessHooks } from "../hooks/read-staleness.js";
import { executeHookedTool } from "../agent/tool-execution.js";
import { readTool } from "../tools/read.js";
import { editTool } from "../tools/edit.js";
import { writeTool } from "../tools/write.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";

describe("installReadStalenessHooks", () => {
  let cwd: string;
  let ctx: AgentContext;
  let hooks: ReturnType<typeof createHookRegistry>;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-read-staleness-"));
    ctx = { cwd, messages: [], workspace: createLocalWorkspace() };
    attachReadTracker(ctx);
    hooks = createHookRegistry();
    installReadStalenessHooks(hooks);
    saveConfig({ tools: { edit: { requireFreshRead: false } } });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    saveConfig({ tools: { edit: { requireFreshRead: undefined } } });
  });

  async function runTool(
    name: "read" | "edit" | "write",
    args: Record<string, unknown>,
  ) {
    const tool = name === "read" ? readTool : name === "edit" ? editTool : writeTool;
    return executeHookedTool({
      call: { id: `tc-${name}`, name, args },
      tool,
      ctx,
      hooks,
      signal: new AbortController().signal,
    });
  }

  it("warns when editing a file changed externally since last read", async () => {
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, "const x = 1;\n");

    await runTool("read", { path: "sample.ts" });

    await new Promise((r) => setTimeout(r, 50));
    await writeFile(filePath, "const x = 1;\n// external change\n");

    const result = await runTool("edit", {
      path: "sample.ts",
      edits: [{ oldText: "// external change", newText: "// edited" }],
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("changed on disk since last read");
    const content = await readFile(filePath, "utf8");
    expect(content).toContain("// edited");
  });

  it("does not warn when editing immediately after read", async () => {
    await writeTool.execute(
      { path: "fresh.ts", content: "hello\n" },
      ctx,
      new AbortController().signal,
    );

    await runTool("read", { path: "fresh.ts" });
    const result = await runTool("edit", {
      path: "fresh.ts",
      edits: [{ oldText: "hello", newText: "world" }],
    });

    expect(result.output).not.toContain("[staleness:");
  });

  it("blocks edit in strict mode until re-read", async () => {
    saveConfig({ tools: { edit: { requireFreshRead: true } } });

    const filePath = join(cwd, "strict.ts");
    await writeFile(filePath, "const a = 1;\n");
    await runTool("read", { path: "strict.ts" });

    await new Promise((r) => setTimeout(r, 50));
    await writeFile(filePath, "const a = 1;\n// external\n");

    const blocked = await runTool("edit", {
      path: "strict.ts",
      edits: [{ oldText: "// external", newText: "// blocked" }],
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain("changed on disk since last read");

    await runTool("read", { path: "strict.ts" });
    const allowed = await runTool("edit", {
      path: "strict.ts",
      edits: [{ oldText: "// external", newText: "// ok" }],
    });
    expect(allowed.isError).toBeFalsy();
    expect(allowed.output).not.toContain("[Blocked:");
  });
});
