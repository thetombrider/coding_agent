import { describe, expect, it } from "vitest";
import {
  buildMcpProviderSchema,
  digestProviderInputSchema,
  formatMcpArgsSummary,
  schemaFromProviderInput,
} from "./provider-schema.js";

describe("provider-schema", () => {
  const inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      recursive: { type: "boolean" },
    },
    required: ["path"],
  } as const;

  it("builds MCP provider metadata with a stable digest", () => {
    const first = buildMcpProviderSchema("fs__read_file", { ...inputSchema });
    const second = buildMcpProviderSchema("fs__read_file", { ...inputSchema });

    expect(first.providerInputSchema).toEqual(inputSchema);
    expect(first.providerSchemaMeta).toEqual({
      source: "mcp",
      serverId: "fs",
      toolName: "read_file",
      schemaDigest: second.providerSchemaMeta?.schemaDigest,
    });
    expect(first.providerSchemaMeta?.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("digest is stable regardless of property order", () => {
    const a = digestProviderInputSchema({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    const b = digestProviderInputSchema({
      required: ["path"],
      properties: { path: { type: "string" } },
      type: "object",
    });
    expect(a).toBe(b);
  });

  it("converts simple JSON Schema to validating Zod", () => {
    const schema = schemaFromProviderInput({ ...inputSchema });
    expect(schema.safeParse({ path: "a.txt" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("formats MCP args with schema-aware labels", () => {
    const summary = formatMcpArgsSummary(
      { path: "README.md", extra: 1 },
      { ...inputSchema },
    );
    expect(summary).toContain('path=README.md (File path)');
    expect(summary).toContain('extra=1');
  });

  it("marks missing required fields in summaries", () => {
    const summary = formatMcpArgsSummary({}, { ...inputSchema });
    expect(summary).toContain("(missing path)");
  });
});
