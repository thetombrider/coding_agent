import { describe, expect, it } from "vitest";
import { coerceIsolation, maxIsolation, resolveIsolationMode } from "./isolation.js";

describe("coerceIsolation", () => {
  it("accepts known modes case-insensitively", () => {
    expect(coerceIsolation("shared")).toBe("shared");
    expect(coerceIsolation(" Worktree ")).toBe("worktree");
    expect(coerceIsolation("SANDBOX")).toBe("sandbox");
  });

  it("rejects unknown values", () => {
    expect(coerceIsolation("vm")).toBeUndefined();
    expect(coerceIsolation("")).toBeUndefined();
  });
});

describe("maxIsolation", () => {
  it("returns the more-isolated mode", () => {
    expect(maxIsolation("shared", "worktree")).toBe("worktree");
    expect(maxIsolation("sandbox", "worktree")).toBe("sandbox");
    expect(maxIsolation("shared", "shared")).toBe("shared");
  });
});

describe("resolveIsolationMode (floor + escalate-only)", () => {
  it("uses the floor for mutating presets when nothing is requested", () => {
    expect(resolveIsolationMode(undefined, true, "shared", "shared")).toBe("shared");
    expect(resolveIsolationMode(undefined, true, "shared", "worktree")).toBe("worktree");
  });

  it("lets the model escalate above the floor", () => {
    expect(resolveIsolationMode("sandbox", true, "shared", "worktree")).toBe("sandbox");
    expect(resolveIsolationMode("worktree", true, "shared", "shared")).toBe("worktree");
  });

  it("clamps a weaker request up to the floor (never weakens)", () => {
    expect(resolveIsolationMode("shared", true, "shared", "worktree")).toBe("worktree");
    expect(resolveIsolationMode("worktree", true, "shared", "sandbox")).toBe("sandbox");
  });

  it("ignores the floor for read-only presets", () => {
    // Read-only work doesn't mutate, so the floor doesn't force a costly clone.
    expect(resolveIsolationMode(undefined, false, "shared", "sandbox")).toBe("shared");
    // ...but an explicit request is still honoured.
    expect(resolveIsolationMode("worktree", false, "shared", "sandbox")).toBe("worktree");
  });
});
