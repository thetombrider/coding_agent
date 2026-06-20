import { randomUUID } from "node:crypto";
import { z } from "zod";
import { currentTurnCount } from "../agent/compaction.js";
import { resolvePreset, type IsolationMode } from "../agent/presets.js";
import { lastAssistantText, runLoop } from "../agent/loop.js";
import { hasE2BApiKey } from "../config/config.js";
import { defaultCheapModel } from "../config/models.js";
import { createHookRegistry } from "../hooks/registry.js";
import { installCoreHooks } from "../hooks/install.js";
import { loadToolDescription } from "../util/load-txt.js";
import { createE2BWorkspace } from "../workspace/e2b.js";
import { REMOTE_SANDBOX_ROOT, seedRepoIntoWorkspace } from "../workspace/seed.js";
import type { Workspace } from "../workspace/types.js";
import type { AgentContext } from "../types.js";
import type { Tool } from "./types.js";

export const MAX_SUBAGENT_DEPTH = 1;
export const MAX_SUBAGENT_TURNS = 25;

const schema = z.object({
  description: z.string().describe("Short label for UI/logs."),
  prompt: z.string().describe("The task the subagent should accomplish."),
  agent: z
    .enum(["explore", "review", "general"])
    .optional()
    .describe(
      "Subagent preset; default general. Use explore/review for open-ended read-only "
      + "investigation — not for known-path summaries (use delegate_read instead).",
    ),
  isolation: z
    .enum(["shared", "sandbox"])
    .optional()
    .describe("Workspace isolation — enforced against preset capabilities."),
});

export type TaskArgs = z.infer<typeof schema>;

export interface TaskDeps {
  createSandbox?: () => Promise<Workspace>;
  seedRepo?: typeof seedRepoIntoWorkspace;
}

interface ResolvedIsolation {
  mode: IsolationMode;
  warning?: string;
}

function resolveIsolation(
  requested: IsolationMode | undefined,
  mutating: boolean,
  defaultIsolation: IsolationMode,
): ResolvedIsolation | { error: string } {
  const want = requested ?? defaultIsolation;

  if (want === "shared" && mutating) {
    if (hasE2BApiKey()) {
      return {
        mode: "sandbox",
        warning:
          "Upgraded isolation to sandbox: mutating presets cannot use shared workspace.",
      };
    }
    return {
      error:
        "Destructive subagent work requires sandbox isolation. Set E2B_API_KEY "
        + "or use agent explore/review for read-only work.",
    };
  }

  if (want === "sandbox" && !hasE2BApiKey()) {
    return {
      error:
        "E2B_API_KEY is not set. Sandbox isolation requires an E2B API key "
        + "(environment variable or sandbox.e2b.apiKey in ~/.orin/config.json).",
    };
  }

  return { mode: want };
}

export async function runSubagentTask(
  args: TaskArgs,
  ctx: AgentContext,
  signal: AbortSignal,
  deps: TaskDeps = {},
): Promise<{ output: string; isError?: boolean }> {
  const host = ctx.loopHost;
  if (!host) {
    return { output: "Internal error: subagent loop host is not configured.", isError: true };
  }

  const depth = ctx.depth ?? 0;
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return { output: "Subagent recursion limit reached.", isError: true };
  }

  const preset = resolvePreset(args.agent);
  const isolationResult = resolveIsolation(
    args.isolation,
    preset.mutating,
    preset.defaultIsolation,
  );
  if ("error" in isolationResult) {
    return { output: isolationResult.error, isError: true };
  }

  const subagentId = randomUUID();
  const createSandbox = deps.createSandbox ?? createE2BWorkspace;
  const seedRepo = deps.seedRepo ?? seedRepoIntoWorkspace;

  let childWorkspace = ctx.workspace;
  let childCwd = ctx.cwd;
  let ownsWorkspace = false;

  host.hooks.emit({
    type: "subagent_start",
    id: subagentId,
    description: args.description,
    agent: preset.agent,
    isolation: isolationResult.mode,
  });

  try {
    if (isolationResult.mode === "sandbox") {
      childWorkspace = await createSandbox();
      ownsWorkspace = true;
      childCwd = REMOTE_SANDBOX_ROOT;
      const seedMessage = await seedRepo(childWorkspace, ctx.cwd, childCwd);
      if (seedMessage.startsWith("No git origin") || seedMessage.startsWith("git clone failed")) {
        return { output: seedMessage, isError: true };
      }
    }

    const childCtx: AgentContext = {
      cwd: childCwd,
      workspace: childWorkspace,
      depth: depth + 1,
      loopHost: host,
      messages: [{ role: "user", content: [{ type: "text", text: args.prompt }] }],
    };

    const childHooks = createHookRegistry();
    installCoreHooks(childHooks, {
      ...host.approval,
      tools: preset.tools,
    });

    // Forward child LLM + tool events to the parent registry, tagged with
    // subagentId, so one accumulator and one trace capture subagent cost. The
    // OTel exporter (6/8) nests these spans under the subagent span keyed by
    // subagentId; llm_start is forwarded so generation spans pair by id.
    childHooks.observe((event) => {
      if (
        event.type === "tool_start" ||
        event.type === "tool_end" ||
        event.type === "assistant_message" ||
        event.type === "llm_start"
      ) {
        host.hooks.emit({ ...event, subagentId });
      }
    });

    await runLoop(childCtx, childHooks, {
      provider: host.provider,
      tools: preset.tools,
      model: host.model,
      cheapModel: host.cheapModel ?? defaultCheapModel(),
      system: preset.system,
      signal,
      sessionId: host.sessionId,
      maxTurns: MAX_SUBAGENT_TURNS,
      onEvent: host.onEvent,
    });

    const summary = lastAssistantText(childCtx) || "(no summary returned)";
    const turns = currentTurnCount(childCtx.messages);

    host.hooks.emit({
      type: "subagent_end",
      id: subagentId,
      agent: preset.agent,
      turns,
      summary,
    });

    const prefix = isolationResult.warning ? `${isolationResult.warning}\n\n` : "";
    const header = `Subagent (${preset.agent}) finished — ${turns} turn${turns === 1 ? "" : "s"}`;
    return { output: `${prefix}${header}\n\n${summary}` };
  } finally {
    if (ownsWorkspace) {
      await childWorkspace.dispose().catch(() => {});
    }
  }
}

export const taskTool: Tool<TaskArgs> = {
  name: "task",
  description: loadToolDescription("task"),
  schema,
  async execute(args, ctx, signal) {
    return runSubagentTask(args, ctx, signal);
  },
};
