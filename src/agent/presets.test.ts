import { describe, expect, it } from "vitest";
import { resolvePreset } from "../agent/presets.js";
import { getChildTools } from "../tools/registry.js";

describe("agent presets", () => {
  it("explore preset is read-only with shared default isolation", () => {
    const preset = resolvePreset("explore");
    expect(preset.mutating).toBe(false);
    expect(preset.defaultIsolation).toBe("shared");
    expect(preset.tools.map((t) => t.name)).toEqual(["read", "grep", "find", "ls", "search_symbols"]);
  });

  it("review preset is read-only with shared default isolation", () => {
    const preset = resolvePreset("review");
    expect(preset.mutating).toBe(false);
    expect(preset.defaultIsolation).toBe("shared");
    expect(preset.tools.map((t) => t.name)).toEqual(["read", "grep", "find", "ls", "search_symbols"]);
  });

  it("implement preset is mutating with shared default and excludes task/todowrite", () => {
    const preset = resolvePreset("implement");
    expect(preset.mutating).toBe(true);
    expect(preset.defaultIsolation).toBe("shared");
    const names = preset.tools.map((t) => t.name);
    expect(names).not.toContain("task");
    expect(names).not.toContain("todowrite");
    expect(names.length).toBe(getChildTools().length);
  });
});
