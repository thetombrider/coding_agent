import { describe, expect, it } from "vitest";
import { getChildTools, getCoreTools } from "./registry.js";

describe("tool registry", () => {
  it("includes todowrite in core tools", () => {
    expect(getCoreTools().some((t) => t.name === "todowrite")).toBe(true);
  });

  it("excludes todowrite from child tool presets", () => {
    expect(getChildTools().some((t) => t.name === "todowrite")).toBe(false);
    expect(getChildTools().length).toBe(getCoreTools().length - 1);
  });
});
