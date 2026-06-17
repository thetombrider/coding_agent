import { formatEnvironmentBlock } from "./environment.js";
import { describe, expect, it } from "vitest";

describe("formatEnvironmentBlock", () => {
  it("includes cwd, date, model, and platform", () => {
    const block = formatEnvironmentBlock({
      cwd: "/workspace",
      date: "2026-06-17",
      model: "anthropic/claude-sonnet-4.6",
      platform: "linux",
    });
    expect(block).toBe(
      [
        "<environment>",
        "cwd: /workspace",
        "date: 2026-06-17",
        "model: anthropic/claude-sonnet-4.6",
        "platform: linux",
        "</environment>",
      ].join("\n"),
    );
  });
});
