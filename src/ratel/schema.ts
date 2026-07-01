import { z } from "zod";

/** Map an Orin Zod tool schema to JSON Schema for Ratel's ToolCatalog. */
export function zodToInputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
