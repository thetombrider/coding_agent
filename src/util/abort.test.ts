import { describe, expect, it } from "vitest";
import { isAbortError } from "./abort.js";

describe("isAbortError", () => {
  it("detects DOMException AbortError", () => {
    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
  });

  it("detects Error named AbortError", () => {
    const err = new Error("cancelled");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });

  it("walks the cause chain", () => {
    const root = new DOMException("Aborted", "AbortError");
    const wrapped = new Error("stream failed", { cause: root });
    expect(isAbortError(wrapped)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isAbortError(new Error("network"))).toBe(false);
    expect(isAbortError("nope")).toBe(false);
  });
});
