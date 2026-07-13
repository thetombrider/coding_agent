import { createHash } from "node:crypto";
import { z } from "zod";
import { MCP_TOOL_SEP } from "../mcp/names.js";

export interface ProviderSchemaMeta {
  source: "mcp";
  serverId: string;
  toolName: string;
  schemaDigest: string;
}

const passthroughSchema = z.record(z.string(), z.unknown());

/** Stable digest of a provider JSON Schema for approval audit / replay checks. */
export function digestProviderInputSchema(inputSchema: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(inputSchema)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

function parseMcpToolId(localName: string): { serverId: string; toolName: string } {
  const idx = localName.indexOf(MCP_TOOL_SEP);
  if (idx === -1) return { serverId: "", toolName: localName };
  return {
    serverId: localName.slice(0, idx),
    toolName: localName.slice(idx + MCP_TOOL_SEP.length),
  };
}

export function buildMcpProviderSchema(
  localName: string,
  inputSchema: Record<string, unknown> | undefined,
): {
  providerInputSchema?: Record<string, unknown>;
  providerSchemaMeta?: ProviderSchemaMeta;
} {
  if (!inputSchema) return {};
  const { serverId, toolName } = parseMcpToolId(localName);
  return {
    providerInputSchema: inputSchema,
    providerSchemaMeta: {
      source: "mcp",
      serverId,
      toolName,
      schemaDigest: digestProviderInputSchema(inputSchema),
    },
  };
}

/** Best-effort JSON Schema → Zod for local validation and LLM tool definitions. */
export function schemaFromProviderInput(inputSchema: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(inputSchema);
  } catch {
    return passthroughSchema;
  }
}

function formatArgValue(val: unknown): string {
  if (typeof val === "string") return val;
  return JSON.stringify(val);
}

/** Human-readable MCP arg summary using the provider JSON Schema when available. */
export function formatMcpArgsSummary(
  args: unknown,
  inputSchema?: Record<string, unknown>,
): string {
  if (!inputSchema) {
    return args && typeof args === "object" ? JSON.stringify(args) : String(args ?? "");
  }

  const props = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(
    Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [],
  );

  if (!args || typeof args !== "object") {
    return JSON.stringify(args);
  }

  const record = args as Record<string, unknown>;
  const parts: string[] = [];

  for (const [key, propSchema] of Object.entries(props)) {
    if (key in record) {
      const desc =
        typeof propSchema.description === "string" && propSchema.description.length <= 48
          ? ` (${propSchema.description})`
          : "";
      parts.push(`${key}=${formatArgValue(record[key])}${desc}`);
    } else if (required.has(key)) {
      parts.push(`(missing ${key})`);
    }
  }

  for (const [key, val] of Object.entries(record)) {
    if (!(key in props)) parts.push(`${key}=${formatArgValue(val)}`);
  }

  return parts.length > 0 ? parts.join("  ") : JSON.stringify(args);
}
