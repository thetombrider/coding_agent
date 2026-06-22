import { describe, expect, it } from "vitest";
import { isCriticalSystemError } from "./system-error.js";

describe("isCriticalSystemError", () => {
  it("flags disk-full and other unrecoverable resource errors", () => {
    for (const code of ["ENOSPC", "EDQUOT", "EROFS", "EMFILE", "ENFILE", "ENOMEM", "EIO"]) {
      const err = Object.assign(new Error(`failed: ${code}`), { code });
      expect(isCriticalSystemError(err)).toBe(true);
    }
  });

  it("does not flag recoverable, path-specific errors", () => {
    for (const code of ["EACCES", "EPERM", "ENOENT", "EEXIST", "EISDIR"]) {
      const err = Object.assign(new Error(`failed: ${code}`), { code });
      expect(isCriticalSystemError(err)).toBe(false);
    }
  });

  it("walks the cause chain", () => {
    const root = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const wrapped = new Error("write failed", { cause: root });
    expect(isCriticalSystemError(wrapped)).toBe(true);
  });

  it("returns false for plain errors and non-errors", () => {
    expect(isCriticalSystemError(new Error("boom"))).toBe(false);
    expect(isCriticalSystemError("just a string")).toBe(false);
    expect(isCriticalSystemError(undefined)).toBe(false);
  });
});
