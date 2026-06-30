import { describe, expect, it } from "vitest";
import { ToolCatalog } from "@ratel-ai/sdk";
import { getCoreTools } from "../tools/registry.js";
import { coreToolsForRatel } from "./tools.js";
import { OrinRatelBundle } from "./catalog.js";

describe("@ratel-ai/sdk under Bun", () => {
  it("loads NAPI bindings and runs BM25 search", () => {
    const catalog = new ToolCatalog();
    catalog.register({
      id: "read",
      name: "read",
      description: "Read a file from disk",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      outputSchema: { type: "object" },
      execute: async () => ({ ok: true }),
    });

    const hits = catalog.search("read file package.json", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.toolId).toBe("read");
  });
});

describe("OrinRatelBundle", () => {
  it("pre-filters core tools and always includes gateway + pinned tools", () => {
    const bundle = OrinRatelBundle.build({
      tools: coreToolsForRatel(),
      cwd: "/tmp",
      settings: {
        enabled: true,
        topKTools: 3,
        topKSkills: 2,
        pinnedTools: ["read", "bash", "search_capabilities", "invoke_tool"],
        controlFraction: 0,
      },
    });

    const { tools, catalogSize, injectedCount } = bundle.resolveToolsForTurn(
      "grep for TODO comments in src",
    );

    expect(catalogSize).toBe(coreToolsForRatel().length);
    expect(injectedCount).toBeLessThan(catalogSize);
    expect(tools.some((t) => t.name === "search_capabilities")).toBe(true);
    expect(bundle.resolveToolsForTurn("grep TODO").telemetry.featureFlag).toBe("tool_pool=ratel");
    expect(tools.some((t) => t.name === "invoke_tool")).toBe(true);
    expect(tools.some((t) => t.name === "read")).toBe(true);
    expect(tools.some((t) => t.name === "bash")).toBe(true);
  });

  it("executionTools includes gateway wrappers for the loop registry", () => {
    const bundle = OrinRatelBundle.build({
      tools: getCoreTools().slice(0, 5),
      cwd: "/tmp",
      settings: {
        enabled: true,
        topKTools: 2,
        topKSkills: 1,
        pinnedTools: ["search_capabilities", "invoke_tool"],
        controlFraction: 0,
      },
    });

    const names = new Set(bundle.executionTools().map((t) => t.name));
    expect(names.has("search_capabilities")).toBe(true);
    expect(names.has("invoke_tool")).toBe(true);
  });
});
