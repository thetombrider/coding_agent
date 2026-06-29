import { describe, expect, it } from "vitest";
import { resolvePreset, augmentSystemWithParentTodos } from "../agent/presets.js";
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
    // propose_todo stays in the child preset so subagents can push plan updates
    // back to the parent (issue #149). todowrite itself stays out: only the
    // parent writes to the session plan.
    expect(names).toContain("propose_todo");
    expect(names.length).toBe(getChildTools().length);
  });
});

describe("augmentSystemWithParentTodos", () => {
  const base = "You are a subagent.";

  it("appends propose_todo instructions even when the parent has no list", () => {
    const out = augmentSystemWithParentTodos(base, undefined);
    expect(out).toContain("propose_todo");
    expect(out).not.toContain("PARENT PLAN");
  });

  it("prepends the parent's current todos as a read-only block when present", () => {
    const out = augmentSystemWithParentTodos(base, [
      { id: "1", content: "Do A", status: "in_progress" },
      { id: "2", content: "Do B", status: "pending" },
    ]);
    expect(out).toContain("PARENT PLAN");
    expect(out).toContain("Do A");
    expect(out).toContain("Do B");
    expect(out).toContain("propose_todo");
  });
});
