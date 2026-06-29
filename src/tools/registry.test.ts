import { describe, expect, it } from "vitest";
import { getChildTools, getCoreTools } from "./registry.js";

describe("tool registry", () => {
  it("includes todowrite in core tools", () => {
    expect(getCoreTools().some((t) => t.name === "todowrite")).toBe(true);
  });

  it("keeps propose_todo out of the parent catalog — it's a child-only plan proposer (#149)", () => {
    expect(getCoreTools().some((t) => t.name === "propose_todo")).toBe(false);
    expect(getChildTools().some((t) => t.name === "propose_todo")).toBe(true);
  });

  it("includes askuser in core tools", () => {
    expect(getCoreTools().some((t) => t.name === "askuser")).toBe(true);
  });

  it("includes task in core tools", () => {
    expect(getCoreTools().some((t) => t.name === "task")).toBe(true);
  });

  it("includes task_parallel in core tools", () => {
    expect(getCoreTools().some((t) => t.name === "task_parallel")).toBe(true);
  });

  it("includes bash_status and bash_kill in core tools", () => {
    expect(getCoreTools().some((t) => t.name === "bash_status")).toBe(true);
    expect(getCoreTools().some((t) => t.name === "bash_kill")).toBe(true);
  });

  it("excludes todowrite, task, task_parallel, file_op, askuser, and skill_write from child tool presets", () => {
    expect(getChildTools().some((t) => t.name === "todowrite")).toBe(false);
    expect(getChildTools().some((t) => t.name === "task")).toBe(false);
    expect(getChildTools().some((t) => t.name === "task_parallel")).toBe(false);
    expect(getChildTools().some((t) => t.name === "file_op")).toBe(false);
    expect(getChildTools().some((t) => t.name === "askuser")).toBe(false);
    expect(getChildTools().some((t) => t.name === "skill_write")).toBe(false);
    // Child preset is core (5 child-only not counted) minus the 6 excluded tools.
    // propose_todo is child-only, so it does not appear in getCoreTools().length.
    expect(getChildTools().length).toBe(getCoreTools().length - 6 + 1);
  });

  it("includes the read-only fetch tool in child tool presets", () => {
    expect(getChildTools().some((t) => t.name === "fetch")).toBe(true);
  });

  it("includes the read-only web_search tool in child tool presets", () => {
    expect(getCoreTools().some((t) => t.name === "web_search")).toBe(true);
    expect(getChildTools().some((t) => t.name === "web_search")).toBe(true);
  });
});
