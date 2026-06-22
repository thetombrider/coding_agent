import { describe, expect, it } from "vitest";
import { resolvePath } from "./paths.js";

describe("resolvePath", () => {
  it("returns absolute paths unchanged", () => {
    expect(resolvePath("/home/user/proj", "/etc/hosts")).toBe("/etc/hosts");
  });

  it("resolves relative paths against cwd", () => {
    expect(resolvePath("/home/user/proj", "src/index.ts")).toBe(
      "/home/user/proj/src/index.ts",
    );
  });

  it("normalizes . and .. segments", () => {
    expect(resolvePath("/home/user/proj", "./src/../lib/x.ts")).toBe(
      "/home/user/proj/lib/x.ts",
    );
  });

  it("resolves '.' to the cwd", () => {
    expect(resolvePath("/home/user/proj", ".")).toBe("/home/user/proj");
  });
});
