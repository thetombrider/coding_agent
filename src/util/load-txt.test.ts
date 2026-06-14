import { describe, expect, it } from "vitest";
import { loadToolDescription, loadTxt } from "./load-txt.js";

describe("loadTxt", () => {
  it("loads tool descriptions from src/tools/*.txt", () => {
    const desc = loadToolDescription("read");
    expect(desc).toContain("Read the contents of a file");
  });

  it("loads arbitrary paths relative to src/", () => {
    const desc = loadTxt("tools/read.txt");
    expect(desc).toBe(loadToolDescription("read"));
  });
});
