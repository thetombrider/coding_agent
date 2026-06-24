import { describe, expect, it } from "vitest";
import { getChildTools, getCoreTools } from "./registry.js";

describe("tool registry", () => {
  it("includes todowrite in core tools", () => {
    expect(getCoreTools().some((t) => t.name === "todowrite")).toBe(true);
  });

  it("includes askuser in core tools", () => {
    expect(getCoreTools().some((t) => t.name === "askuser")).toBe(true);
  });

  it("includes task in core tools", () => {
    expect(getCoreTools().some((t) => t.name === "task")).toBe(true);
  });

  it("excludes todowrite, task, file_op, and askuser from child tool presets", () => {
    expect(getChildTools().some((t) => t.name === "todowrite")).toBe(false);
    expect(getChildTools().some((t) => t.name === "task")).toBe(false);
    expect(getChildTools().some((t) => t.name === "file_op")).toBe(false);
    expect(getChildTools().some((t) => t.name === "askuser")).toBe(false);
    expect(getChildTools().length).toBe(getCoreTools().length - 4);
  });

  it("includes the read-only fetch tool in child tool presets", () => {
    expect(getChildTools().some((t) => t.name === "fetch")).toBe(true);
  });

  it("includes the read-only web_search tool in child tool presets", () => {
    expect(getCoreTools().some((t) => t.name === "web_search")).toBe(true);
    expect(getChildTools().some((t) => t.name === "web_search")).toBe(true);
  });
});
