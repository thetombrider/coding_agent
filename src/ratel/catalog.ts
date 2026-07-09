import {
  GET_SKILL_CONTENT_ID,
  INVOKE_TOOL_ID,
  SEARCH_CAPABILITIES_ID,
  SkillCatalog,
  ToolCatalog,
  getSkillContentTool,
  invokeToolTool,
  searchCapabilitiesTool,
  type ExecutableTool,
  type UpstreamServerInfo,
} from "@ratel-ai/sdk";
import { z } from "zod";
import type { AnyTool } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import type { AgentContext } from "../types.js";
import type { RatelResolutionSnapshot } from "../agent/events.js";
import { MCP_TOOL_SEP } from "../mcp/names.js";
import { renderMcpContent } from "../mcp/adapter.js";
import type { McpLoadResult } from "../mcp/loader.js";
import { resolveRatelSettings, type RatelSettings } from "./config.js";
import { loadMcpIntoRatelCatalog, type RatelMcpLoadResult } from "./mcp.js";
import { zodToInputSchema } from "./schema.js";
import { registerDiscoveredSkills } from "./skills.js";
import { coreToolsForRatel } from "./tools.js";
import { ratelTraceSink } from "./trace.js";

const searchCapabilitiesSchema = z.object({
  query: z.string(),
  topKTools: z.number().int().min(1).optional(),
  topKSkills: z.number().int().min(1).optional(),
});

const invokeToolSchema = z
  .object({
    toolId: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const getSkillContentSchema = z.object({
  skillId: z.string(),
});

export interface OrinRatelBuildOptions {
  tools: AnyTool[];
  cwd: string;
  mcp?: Pick<McpLoadResult, "servers">;
  settings?: RatelSettings;
  /** Pre-built catalog (e.g. after registerMcpServer). Skips tool registration loop. */
  toolCatalog?: ToolCatalog;
  upstreamServers?: UpstreamServerInfo[];
}

export interface OrinRatelSession {
  bundle: OrinRatelBundle;
  /** Full flat tool list for approval gate + loop registry. */
  tools: AnyTool[];
  mcpServers: RatelMcpLoadResult["servers"];
  mcpDispose: () => Promise<void>;
  mcpWarnings: string[];
  mcpStatusHint?: string;
}

export interface TurnToolResolution {
  tools: AnyTool[];
  catalogSize: number;
  injectedCount: number;
  query: string;
  telemetry: RatelResolutionSnapshot;
}

/**
 * Ratel-backed tool + skill catalogs for one agent session. Follows the official
 * ai-sdk example: gateway tools + BM25 top-K pre-filter per turn (ADR 0003).
 */
export class OrinRatelBundle {
  readonly toolCatalog: ToolCatalog;
  skillCatalog: SkillCatalog;
  readonly settings: RatelSettings;
  private readonly orinTools: Map<string, AnyTool>;
  private readonly upstreamServers: UpstreamServerInfo[];
  private gatewaySearch!: ExecutableTool;
  private readonly gatewayInvoke: ExecutableTool;
  private gatewaySkill!: ExecutableTool;

  private constructor(
    toolCatalog: ToolCatalog,
    skillCatalog: SkillCatalog,
    settings: RatelSettings,
    upstreamServers: UpstreamServerInfo[],
    orinTools: Map<string, AnyTool>,
  ) {
    this.toolCatalog = toolCatalog;
    this.skillCatalog = skillCatalog;
    this.settings = settings;
    this.orinTools = orinTools;
    this.upstreamServers = upstreamServers;
    this.rebuildGatewayTools();
    this.gatewayInvoke = invokeToolTool(toolCatalog);
  }

  private rebuildGatewayTools(): void {
    this.gatewaySearch = searchCapabilitiesTool(
      this.toolCatalog,
      this.skillCatalog.size() > 0 ? this.skillCatalog : undefined,
      { upstreamServers: this.upstreamServers },
    );
    this.gatewaySkill = getSkillContentTool(this.skillCatalog);
  }

  /**
   * Bootstrap a Ratel session: native tools + registerMcpServer upstreams + skills.
   * Mode 3 hybrid per integration-patterns.md — single catalog, no dual MCP clients.
   */
  static async create(
    cwd: string,
    opts?: { tools?: AnyTool[]; settings?: RatelSettings; sessionId?: string },
  ): Promise<OrinRatelSession> {
    const settings = opts?.settings ?? resolveRatelSettings();
    const trace = opts?.sessionId ? ratelTraceSink(opts.sessionId) : undefined;
    const toolCatalog = new ToolCatalog(trace ? { trace } : undefined);
    const skillCatalog = new SkillCatalog(trace ? { trace } : undefined);
    const orinTools = new Map<string, AnyTool>();

    const nativeTools = opts?.tools ?? coreToolsForRatel();
    for (const tool of nativeTools) {
      registerOrinTool(toolCatalog, tool, orinTools);
    }

    const mcp = await loadMcpIntoRatelCatalog(toolCatalog, cwd);
    for (const tool of mcp.tools) {
      orinTools.set(tool.name, tool);
    }

    registerDiscoveredSkills((skill) => skillCatalog.register(skill), cwd);

    const upstreamServers: UpstreamServerInfo[] = mcp.servers
      .filter((s) => (s.status === "connected" || s.status === "needs_auth") && s.toolCount > 0)
      .map((s) => ({
        name: s.name,
        toolCount: s.toolCount,
        ...(s.status === "needs_auth" ? { needsAuth: true } : {}),
      }));

    const bundle = new OrinRatelBundle(
      toolCatalog,
      skillCatalog,
      settings,
      upstreamServers,
      orinTools,
    );

    return {
      bundle,
      tools: bundle.executionTools(),
      mcpServers: mcp.servers,
      mcpDispose: mcp.dispose,
      mcpWarnings: mcp.warnings,
      mcpStatusHint: mcp.statusHint,
    };
  }

  /** Sync build for tests and subagent child loops (no MCP upstream registration). */
  static build(opts: OrinRatelBuildOptions): OrinRatelBundle {
    const settings = opts.settings ?? resolveRatelSettings();
    const toolCatalog = opts.toolCatalog ?? new ToolCatalog();
    const skillCatalog = new SkillCatalog();
    const orinTools = new Map<string, AnyTool>();

    for (const tool of opts.tools) {
      if (opts.toolCatalog) {
        orinTools.set(tool.name, tool);
      } else {
        registerOrinTool(toolCatalog, tool, orinTools);
      }
    }

    registerDiscoveredSkills((skill) => skillCatalog.register(skill), opts.cwd);

    const upstreamServers: UpstreamServerInfo[] = opts.upstreamServers ?? (opts.mcp?.servers ?? [])
      .filter((s) => (s.status === "connected" || s.status === "needs_auth") && s.toolCount > 0)
      .map((s) => ({
        name: s.name,
        toolCount: s.toolCount,
        ...(s.status === "needs_auth" ? { needsAuth: true } : {}),
      }));

    return new OrinRatelBundle(toolCatalog, skillCatalog, settings, upstreamServers, orinTools);
  }

  /** Rebuild skill BM25 index after skill_write or cwd change. */
  refreshSkills(cwd: string): void {
    this.skillCatalog = new SkillCatalog();
    registerDiscoveredSkills((skill) => this.skillCatalog.register(skill), cwd);
    this.rebuildGatewayTools();
  }

  /** Filtered catalog for subagent child loops (mirrors getChildTools exclusions). */
  static buildForChild(childTools: AnyTool[], cwd: string, settings?: RatelSettings): OrinRatelBundle {
    return OrinRatelBundle.build({ tools: childTools, cwd, settings: settings ?? resolveRatelSettings() });
  }

  /** Full Orin tool registry — used for approval and hook-aware execution. */
  allOrinTools(): AnyTool[] {
    return [...this.orinTools.values()];
  }

  getOrinTool(toolId: string): AnyTool | undefined {
    return this.orinTools.get(toolId);
  }

  catalogSize(): number {
    return this.orinTools.size;
  }

  /** Full registry for the agent loop — native/MCP tools plus gateway wrappers. */
  executionTools(): AnyTool[] {
    const byName = new Map<string, AnyTool>();
    for (const tool of this.allOrinTools()) byName.set(tool.name, tool);
    for (const tool of this.resolveToolsForTurn("").tools) {
      if (!byName.has(tool.name)) byName.set(tool.name, tool);
    }
    return [...byName.values()];
  }

  /**
   * Assemble the tool list for one LLM call: gateway + pinned + BM25 top-K.
   * Matches Ratel's recommended pre-filter + dynamic gateway composition.
   */
  resolveToolsForTurn(query: string): TurnToolResolution {
    const pinned = new Set(this.settings.pinnedTools);
    if (this.skillCatalog.size() > 0) {
      pinned.add(GET_SKILL_CONTENT_ID);
    }

    const selected = new Map<string, AnyTool>();

    const add = (tool: AnyTool | undefined) => {
      if (!tool) return;
      selected.set(tool.name, tool);
    };

    add(this.wrapGateway(this.gatewaySearch, searchCapabilitiesSchema));
    add(this.wrapGateway(this.gatewayInvoke, invokeToolSchema, true));
    if (this.skillCatalog.size() > 0) {
      add(this.wrapGateway(this.gatewaySkill, getSkillContentSchema));
    }

    for (const name of pinned) {
      add(this.orinTools.get(name));
    }

    const topK = this.toolCatalog.search(query, this.settings.topKTools, "direct");
    for (const hit of topK) {
      add(this.orinTools.get(hit.toolId));
    }

    // Sort alphabetically so the tools: block is identical whenever the same
    // tools are selected — maximising Anthropic prompt-cache hit rate (Gap 3).
    const sortedTools = [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
    const injectedToolNames = sortedTools.map((t) => t.name);

    const telemetry: RatelResolutionSnapshot = {
      catalogSize: this.orinTools.size,
      injectedCount: selected.size,
      query,
      topK: this.settings.topKTools,
      hitCount: topK.length,
      topHitScore: topK[0]?.score,
      replaceMode: true,
      gatewayOrigin: "direct",
      featureFlag: "tool_pool=ratel",
      skillCatalogSize: this.skillCatalog.size(),
      injectedToolNames,
    };

    return {
      tools: sortedTools,
      catalogSize: this.orinTools.size,
      injectedCount: selected.size,
      query,
      telemetry,
    };
  }

  /** Drain Ratel core trace envelopes (memory sink) for metrics export. */
  drainTraceEvents(): unknown[] {
    return [
      ...this.toolCatalog.drainTraceEvents(),
      ...this.skillCatalog.drainTraceEvents(),
    ];
  }

  private wrapGateway(
    exec: ExecutableTool,
    schema: z.ZodType,
    honorUnderlyingApproval = false,
  ): AnyTool {
    const self = this;
    return {
      name: exec.id,
      description: exec.description,
      schema,
      ...(honorUnderlyingApproval
        ? {
            needsApproval(args: z.infer<typeof invokeToolSchema>, ctx: AgentContext) {
              const toolId = args.toolId;
              const underlying = self.orinTools.get(toolId);
              if (!underlying?.needsApproval) return false;
              return underlying.needsApproval(unwrapInvokeArgs(args), ctx);
            },
            approvalDisplayArgs(args: unknown): { name: string; args: unknown } {
              const parsed = invokeToolSchema.safeParse(args);
              if (!parsed.success) return { name: INVOKE_TOOL_ID, args };
              return { name: parsed.data.toolId, args: unwrapInvokeArgs(parsed.data) };
            },
          }
        : {}),
      async execute(args, ctx, signal): Promise<ToolResult> {
        if (exec.id === INVOKE_TOOL_ID) {
          return self.executeInvokeTool(args as z.infer<typeof invokeToolSchema>, ctx, signal);
        }
        if (exec.id === GET_SKILL_CONTENT_ID) {
          return self.executeGetSkillContent(args as z.infer<typeof getSkillContentSchema>);
        }
        const raw = await exec.execute(args);
        return gatewayResultToOrin(raw);
      },
    };
  }

  private async executeInvokeTool(
    args: z.infer<typeof invokeToolSchema>,
    ctx: AgentContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const toolId = args.toolId;
    const innerArgs = unwrapInvokeArgs(args);
    const orinTool = this.orinTools.get(toolId);

    if (orinTool) {
      const parsed = orinTool.schema.safeParse(innerArgs);
      if (!parsed.success) {
        return { output: parsed.error.message, isError: true };
      }
      const result = await orinTool.execute(parsed.data, ctx, signal);
      return result;
    }

    const raw = await this.gatewayInvoke.execute(args);
    return gatewayResultToOrin(raw, formatMcpInvokeOutput);
  }

  private async executeGetSkillContent(
    args: z.infer<typeof getSkillContentSchema>,
  ): Promise<ToolResult> {
    const result = await this.gatewaySkill.execute(args);
    const out = gatewayResultToOrin(result);
    if (out.isError) return out;
    const body =
      typeof result === "object" && result !== null && "body" in result
        ? String((result as { body: string }).body)
        : out.output;
    return { output: `[Skill: ${args.skillId}]\n\n${body}` };
  }
}

function registerOrinTool(
  catalog: ToolCatalog,
  tool: AnyTool,
  orinTools: Map<string, AnyTool>,
): void {
  orinTools.set(tool.name, tool);
  catalog.register({
    id: tool.name,
    name: tool.name,
    description: tool.description,
    inputSchema: zodToInputSchema(tool.schema),
    outputSchema: { type: "object" },
    execute: async () => {
      throw new Error(`Tool ${tool.name} must run through the Orin agent loop`);
    },
  });
}

function unwrapInvokeArgs(args: z.infer<typeof invokeToolSchema>): Record<string, unknown> {
  const nested = args.args;
  if (nested !== undefined && nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return Object.fromEntries(
    Object.entries(args).filter(([k]) => k !== "toolId" && k !== "args"),
  );
}

function gatewayResultToOrin(
  result: unknown,
  formatOutput: (value: unknown) => string = (v) =>
    typeof v === "string" ? v : JSON.stringify(v, null, 2),
): ToolResult {
  if (typeof result === "object" && result !== null) {
    const obj = result as Record<string, unknown>;
    if (obj.isError === true) {
      const msg = typeof obj.error === "string" ? obj.error : formatOutput(result);
      return { output: msg, isError: true };
    }
  }
  return { output: formatOutput(result) };
}

function formatMcpInvokeOutput(value: unknown): string {
  if (typeof value === "object" && value !== null && "content" in value) {
    return renderMcpContent((value as { content: unknown }).content);
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export { SEARCH_CAPABILITIES_ID, INVOKE_TOOL_ID, GET_SKILL_CONTENT_ID, MCP_TOOL_SEP };
