import { describe, expect, it } from "vitest";
import { shellQuote } from "./shell.js";

describe("shellQuote", () => {
  it("wraps plain strings in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("preserves spaces inside the quotes", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("leaves shell metacharacters inert inside quotes", () => {
    expect(shellQuote("$(rm -rf /); echo `x` & |")).toBe(
      "'$(rm -rf /); echo `x` & |'",
    );
  });

  it("quotes the empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});
