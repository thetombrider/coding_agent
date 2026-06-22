import { describe, expect, it, vi } from "vitest";
import { testAgentContext } from "../test-helpers.js";
import { askUserTool } from "./askuser.js";

const signal = () => new AbortController().signal;

describe("askUserTool", () => {
  it("returns the user's answer when an interactive prompt is wired", async () => {
    const ctx = testAgentContext("/tmp");
    const askUser = vi.fn().mockResolvedValue("Use PostgreSQL");
    ctx.askUser = askUser;

    const result = await askUserTool.execute(
      { question: "Which database?", options: ["Use PostgreSQL", "Use SQLite"] },
      ctx,
      signal(),
    );

    expect(askUser).toHaveBeenCalledWith("Which database?", ["Use PostgreSQL", "Use SQLite"]);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("Use PostgreSQL");
  });

  it("reports an error when no interactive user is available", async () => {
    const ctx = testAgentContext("/tmp");
    // ctx.askUser is undefined (headless / subagent context).

    const result = await askUserTool.execute(
      { question: "A or B?", options: ["A", "B"] },
      ctx,
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("No interactive user");
  });

  it("reports an error when the user dismisses without answering", async () => {
    const ctx = testAgentContext("/tmp");
    ctx.askUser = vi.fn().mockResolvedValue(null);

    const result = await askUserTool.execute(
      { question: "A or B?", options: ["A", "B"] },
      ctx,
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("dismissed");
  });

  it("treats a blank answer as no answer", async () => {
    const ctx = testAgentContext("/tmp");
    ctx.askUser = vi.fn().mockResolvedValue("   ");

    const result = await askUserTool.execute(
      { question: "A or B?", options: ["A", "B"] },
      ctx,
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("dismissed");
  });

  it("requires at least two options", () => {
    expect(askUserTool.schema.safeParse({ question: "x", options: ["only"] }).success).toBe(false);
    expect(askUserTool.schema.safeParse({ question: "x", options: ["a", "b"] }).success).toBe(true);
  });

  it("rejects more than four options with an instructive message", () => {
    const result = askUserTool.schema.safeParse({
      question: "x",
      options: ["a", "b", "c", "d", "e"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The model reads this back as the tool error — it must say what to do,
      // not just "too_big", so the retry reliably trims to four.
      expect(result.error.issues[0]?.message).toContain("at most 4");
    }
    // Exactly four is still allowed.
    expect(
      askUserTool.schema.safeParse({ question: "x", options: ["a", "b", "c", "d"] }).success,
    ).toBe(true);
  });
});
