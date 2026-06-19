import { describe, expect, it, vi } from "vitest";
import { getChildTools, getCoreTools } from "./registry.js";

describe("tool registry", () => {
  it("includes todowrite in core tools", () => {
    expect(getCoreTools().some((t) => t.name === "todowrite")).toBe(true);
  });

  it("excludes task from core tools when E2B is not configured", () => {
    vi.stubEnv("E2B_API_KEY", "");
    expect(getCoreTools().some((t) => t.name === "task")).toBe(false);
  });

  it("includes task in core tools when E2B is configured", () => {
    vi.stubEnv("E2B_API_KEY", "test-key");
    expect(getCoreTools().some((t) => t.name === "task")).toBe(true);
  });

  it("excludes todowrite and task from child tool presets", () => {
    expect(getChildTools().some((t) => t.name === "todowrite")).toBe(false);
    expect(getChildTools().some((t) => t.name === "task")).toBe(false);
    expect(getChildTools().length).toBe(getCoreTools().length - 2);
  });
});
