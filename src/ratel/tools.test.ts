import { describe, expect, it } from "vitest";
import { getCoreTools } from "../tools/registry.js";
import { coreToolsForRatel, filterToolsForRatelCatalog } from "./tools.js";

describe("coreToolsForRatel", () => {
  it("excludes skill_list and skill_use replaced by gateway tools", () => {
    const core = getCoreTools();
    const filtered = coreToolsForRatel();
    expect(core.some((t) => t.name === "skill_list")).toBe(true);
    expect(core.some((t) => t.name === "skill_use")).toBe(true);
    expect(filtered.some((t) => t.name === "skill_list")).toBe(false);
    expect(filtered.some((t) => t.name === "skill_use")).toBe(false);
    expect(filtered.some((t) => t.name === "skill_write")).toBe(true);
  });
});

describe("filterToolsForRatelCatalog", () => {
  it("strips gateway-replaced tools from an arbitrary tool list", () => {
    const core = getCoreTools();
    const filtered = filterToolsForRatelCatalog(core);
    expect(filtered.some((t) => t.name === "skill_list")).toBe(false);
    expect(filtered.some((t) => t.name === "skill_use")).toBe(false);
    expect(filtered.length).toBe(core.length - 2);
  });
});
