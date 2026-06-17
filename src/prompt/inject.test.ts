import { describe, expect, it } from "vitest";
import { INJECTION_MARKER, injectLeadingContext } from "./inject.js";
import type { Message } from "../types.js";

describe("injectLeadingContext", () => {
  const base: Message[] = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ];

  it("prepends a marked injection message", () => {
    const result = injectLeadingContext(base, "<environment>\ncwd: /tmp\n</environment>");
    expect(result).toHaveLength(2);
    expect(result[0].content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(INJECTION_MARKER),
    });
    expect(result[0].content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("<environment>"),
    });
  });

  it("merges additional blocks into the existing injection message", () => {
    const once = injectLeadingContext(base, "block-a");
    const twice = injectLeadingContext(once, "block-b");
    expect(twice).toHaveLength(2);
    const text = twice[0].content[0].type === "text" ? twice[0].content[0].text : "";
    expect(text).toContain("block-a");
    expect(text).toContain("block-b");
  });
});
