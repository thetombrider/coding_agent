import { randomUUID } from "node:crypto";
import { z } from "zod";
import { currentTurnCount } from "../agent/compaction.js";
import { resolvePreset, type IsolationMode } from "../agent/presets.js";
import { lastAssistantText, runLoop } from "../agent/loop.js";
import { hasE2BApiKey } from "../config/config.js";
import { defaultCheapModel, resolvePresetModel } from "../config/models.js";
import { createHookRegistry } from "../hooks/registry.js";
import { installCoreHooks } from "../hooks/install.js";
import { loadToolDescription } from "../util/load-txt.js";
import { createE2BWorkspace } from "../workspace/e2b.js";
import { REMOTE_SANDBOX_ROOT, seedRepoIntoWorkspace } from "../workspace/seed.js";
import { createWorktree, type WorktreeHandle } from "../workspace/worktree.js";
import type { Workspace } from "../workspace/types.js";
import type { AgentContext } from "../types.js";
import type { Tool } from "./types.js";

export const MAX_SUBAGENT_DEPTH = 1;
export const MAX_SUBAGENT_TURNS = 25;

const schema = z.object({
  description: z.string().describe("Short label for UI/logs."),
  prompt: z.string().describe("The task the subagent should accomplish."),
  agent: z
    .enum(["explore", "review", "implement"])
    .optional()
    .describe(
      "Subagent preset; default implement. Use explore/review for open-ended read-only "
      + "investigation — not for known-path summaries (use delegate_read instead).",
    ),
  isolation: z
    .enum(["shared", "worktree", "sandbox"])
    .optional()
    .describe(
      "Workspace isolation. shared (default): edits the local working tree and "
      + "persists. worktree: runs in a git worktree on a fresh branch (isolated, "
      + "persists to that branch). sandbox: ephemeral E2B clone (requires E2B_API_KEY).",
    ),
});

export type TaskArgs = z.infer<typeof schema>;

export interface TaskDeps {
  createSandbox?: () => Promise<Workspace>;
  seedRepo?: typeof seedRepoIntoWorkspace;
  createWorktree?: typeof createWorktree;
}

interface ResolvedIsolation {
  mode: IsolationMode;
}

function resolveIsolation(
  requested: IsolationMode | undefined,
  defaultIsolation: IsolationMode,
): ResolvedIsolation | { error: string } {
  const want = requested ?? defaultIsolation;

  // shared (incl. mutating presets) and worktree run against the local tree —
  // edits persist, matching how other local agents handle subagent work. Only
  // the cloud sandbox needs a credential up front; worktree git failures (no
  // repo) surface at creation time.
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
  const isolationResult = resolveIsolation(args.isolation, preset.defaultIsolation);
  if ("error" in isolationResult) {
    return { output: isolationResult.error, isError: true };
  }

  // Single resolution point for the subagent's model (read by both the span
  // attribute and the spawn below). Per-subagent routing (#134): explore runs
  // on the cheap tier, implement on a code-tuned model, review on main; an
  // explicit models.roles override wins when the active provider supports it.
  // Resolved before the subagent_start span opens so #86 can tag the chosen model.
  const hostCheap = host.cheapModel ?? defaultCheapModel();
  const subagentModel = resolvePresetModel(preset.agent, host.model, hostCheap);

  const subagentId = randomUUID();
  const createSandbox = deps.createSandbox ?? createE2BWorkspace;
  const seedRepo = deps.seedRepo ?? seedRepoIntoWorkspace;
  const makeWorktree = deps.createWorktree ?? createWorktree;

  let childWorkspace = ctx.workspace;
  let childCwd = ctx.cwd;
  let ownsWorkspace = false;
  let worktree: WorktreeHandle | undefined;

  host.hooks.emit({
    type: "subagent_start",
    id: subagentId,
    description: args.description,
    agent: preset.agent,
    isolation: isolationResult.mode,
    model: subagentModel,
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
    } else if (isolationResult.mode === "worktree") {
      const result = makeWorktree(ctx.cwd, subagentId);
      if ("error" in result) {
        return { output: result.error, isError: true };
      }
      worktree = result.handle;
      childWorkspace = worktree.workspace;
      childCwd = worktree.cwd;
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
      model: subagentModel,
      cheapModel: hostCheap,
      system: preset.system,
      signal,
      sessionId: host.sessionId,
      maxTurns: MAX_SUBAGENT_TURNS,
      onEvent: host.onEvent,
    });

    const summary = lastAssistantText(childCtx) || "(no summary returned)";
    const turns = currentTurnCount(childCtx.messages);

    // Commit the worktree's work onto its branch before it is removed, and tell
    // the parent where to find it. The branch survives; the worktree dir does not.
    let worktreeNote = "";
    if (worktree) {
      const { branch, committed, diffStat } = worktree.harvest();
      worktreeNote = committed
        ? `\n\nChanges committed to branch \`${branch}\`:\n${diffStat}`
        : `\n\nNo file changes were made (branch \`${branch}\`).`;
    }

    host.hooks.emit({
      type: "subagent_end",
      id: subagentId,
      agent: preset.agent,
      turns,
      summary,
    });

    const header = `Subagent (${preset.agent}) finished — ${turns} turn${turns === 1 ? "" : "s"}`;
    return { output: `${header}\n\n${summary}${worktreeNote}` };
  } finally {
    if (worktree) {
      try {
        worktree.remove();
      } catch {
        // best-effort cleanup; a stale worktree can be pruned with `git worktree prune`
      }
    } else if (ownsWorkspace) {
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
