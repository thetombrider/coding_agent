import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type { AnyTool } from "../tools/registry.js";
import { MCP_TOOL_SEP } from "./names.js";
import type { RemoteTool } from "./client.js";

/** Output cap — search/MCP results must not blow up the model context. */
const MAX_OUTPUT = 100 * 1024;

const passthroughSchema = z.record(z.string(), z.unknown());

type McpContentBlock = {
  type: string;
  text?: string;
};

function asContentBlocks(content: unknown): McpContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is McpContentBlock =>
      typeof block === "object" && block !== null && typeof (block as McpContentBlock).type === "string",
  );
}

export function renderMcpContent(content: unknown): string {
  const rendered = asContentBlocks(content)
    .map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
    .join("\n");

  if (rendered.length <= MAX_OUTPUT) return rendered;
  return (
    rendered.slice(0, MAX_OUTPUT)
    + `\n\n[output truncated at ${MAX_OUTPUT} bytes — MCP tool produced more.]`
  );
}

export function toLocalTool(
  client: Client,
  serverName: string,
  remote: RemoteTool,
  autoApproveIds?: Set<string>,
): AnyTool {
  const localName = `${serverName}${MCP_TOOL_SEP}${remote.name}`;
  const isAutoApproved = autoApproveIds?.has(localName) ?? false;

  return {
    name: localName,
    description: remote.description ?? "",
    schema: passthroughSchema,
    needsApproval: isAutoApproved ? () => false : () => true,
    async execute(args, _ctx, signal) {
      const result = await client.callTool(
        { name: remote.name, arguments: args as Record<string, unknown> },
        undefined,
        { signal },
      );

      if ("toolResult" in result) {
        const output =
          typeof result.toolResult === "string"
            ? result.toolResult
            : JSON.stringify(result.toolResult, null, 2);
        return { output: renderMcpContent([{ type: "text", text: output }]) };
      }

      const output = renderMcpContent(result.content);
      if (result.isError) return { output, isError: true };
      return { output };
    },
  };
}
