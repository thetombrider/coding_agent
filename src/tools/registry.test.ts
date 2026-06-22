import { describe, expect, it, vi } from "vitest";
import { getChildTools, getCoreTools } from "./registry.js";

describe("tool registry", () => {
  it("includes todowrite in core tools", () => {
    expect(getCoreTools().some((t) => t.name === "todowrite")).toBe(true);
  });

  it("includes task in core tools without an E2B key (shared/worktree run locally)", () => {
    vi.stubEnv("E2B_API_KEY", "");
    expect(getCoreTools().some((t) => t.name === "task")).toBe(true);
  });

  it("includes task in core tools when E2B is configured", () => {
    vi.stubEnv("E2B_API_KEY", "test-key");
    expect(getCoreTools().some((t) => t.name === "task")).toBe(true);
  });

  it("excludes todowrite, task, and file_op from child tool presets", () => {
    expect(getChildTools().some((t) => t.name === "todowrite")).toBe(false);
    expect(getChildTools().some((t) => t.name === "task")).toBe(false);
    expect(getChildTools().some((t) => t.name === "file_op")).toBe(false);
    expect(getChildTools().length).toBe(getCoreTools().length - 3);
  });

  it("includes the read-only fetch tool in child tool presets", () => {
    expect(getChildTools().some((t) => t.name === "fetch")).toBe(true);
  });
});
