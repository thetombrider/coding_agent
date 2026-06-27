import { randomUUID } from "node:crypto";
import { z } from "zod";
import { currentTurnCount } from "../agent/compaction.js";
import { resolvePreset, type PresetDefinition } from "../agent/presets.js";
import { maxIsolation, resolveIsolationMode, type IsolationMode } from "../agent/isolation.js";
import { lastAssistantText, runLoop } from "../agent/loop.js";
import { hasE2BApiKey, loadConfig } from "../config/config.js";
import { defaultCheapModel, resolvePresetModel } from "../config/models.js";
import { createHookRegistry } from "../hooks/registry.js";
import { installCoreHooks } from "../hooks/install.js";
import { loadToolDescription } from "../util/load-txt.js";
import { isAbortError } from "../util/abort.js";
import { createE2BWorkspace } from "../workspace/e2b.js";
import { REMOTE_SANDBOX_ROOT, seedRepoIntoWorkspace } from "../workspace/seed.js";
import { createWorktree, resolveParallelWorktreeBase, type CreateWorktreeResult, type HarvestResult, type WorktreeHandle } from "../workspace/worktree.js";
import type { Workspace } from "../workspace/types.js";
import type { AgentContext } from "../types.js";
import type { Tool } from "./types.js";

export const MAX_SUBAGENT_DEPTH = 1;
export const MAX_SUBAGENT_TURNS = 25;
export const MAX_SUBAGENT_TOOL_CALLS = 128;

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
      + "persists to that branch). sandbox: ephemeral E2B clone (requires sandbox.e2b.apiKey in config).",
    ),
});

export type TaskArgs = z.infer<typeof schema>;

const childTaskSchema = z.object({
  description: z.string().describe("Short label for UI/logs."),
  prompt: z.string().describe("The task this subagent should accomplish independently."),
  agent: z
    .enum(["explore", "review", "implement"])
    .optional()
    .describe("Subagent preset; default implement. Same semantics as the `task` tool."),
  isolation: z
    .enum(["worktree", "sandbox"])
    .optional()
    .describe(
      "Workspace isolation for this child. Defaults to worktree for mutating work "
      + "(shared is forbidden in parallel — siblings would collide on the host tree). "
      + "sandbox runs in an ephemeral E2B clone (requires sandbox.e2b.apiKey).",
    ),
});

const parallelSchema = z.object({
  tasks: z
    .array(childTaskSchema)
    .min(2)
    .describe(
      "Two or more independent units of work to run concurrently, each in its own "
      + "subagent. Only use this when the tasks don't depend on each other's output.",
    ),
});

export type ParallelTaskArgs = z.infer<typeof parallelSchema>;

export interface TaskDeps {
  createSandbox?: () => Promise<Workspace>;
  seedRepo?: typeof seedRepoIntoWorkspace;
  createWorktree?: typeof createWorktree;
}

/** Per-run knobs that don't come from the model's tool arguments. */
export interface RunSubagentOptions {
  /**
   * Parallel fan-out mode (`task_parallel`). Forces each mutating child into its
   * own fresh git worktree — never the shared host tree, never a reused session
   * worktree — so concurrent siblings can't collide. Children branch from
   * `parallelBaseRef` (parent working-tree tip, including uncommitted work).
   * Read-only presets are unaffected (they don't write).
   */
  parallel?: boolean;
  /** Shared base ref for all siblings in one fan-out; set by `runParallelTasks`. */
  parallelBaseRef?: string;
}

interface ResolvedIsolation {
  mode: IsolationMode;
}

function resolveIsolation(
  requested: IsolationMode | undefined,
  preset: PresetDefinition,
  parallel: boolean,
): ResolvedIsolation | { error: string } {
  // The config `subagent.isolation` floor is a guarantee; the model may escalate
  // per call but not weaken below it (read-only presets are unaffected).
  let floor = loadConfig().subagent.isolation;
  // Parallel mutating children must never share the host tree — raise the floor
  // to at least `worktree` so each sibling gets its own dir + branch.
  if (parallel && preset.mutating) floor = maxIsolation(floor, "worktree");
  const want = resolveIsolationMode(requested, preset.mutating, preset.defaultIsolation, floor);

  // shared and worktree run against the local tree — edits persist, matching how
  // other local agents handle subagent work. Only the cloud sandbox needs a
  // credential up front; worktree git failures (no repo) surface at creation time.
  if (want === "sandbox" && !hasE2BApiKey()) {
    return {
      error:
        "E2B is not configured. Sandbox isolation requires sandbox.e2b.apiKey in ~/.orin/config.json "
        + "(set it with /settings).",
    };
  }

  return { mode: want };
}

/** Create an isolated subagent worktree from the host repo. */
function spawnSubagentWorktree(
  host: NonNullable<AgentContext["loopHost"]>,
  ctx: AgentContext,
  subagentId: string,
  opts: Pick<RunSubagentOptions, "parallel" | "parallelBaseRef">,
  makeWorktree: TaskDeps["createWorktree"] & typeof createWorktree,
): CreateWorktreeResult {
  const worktreeOpts = opts.parallel && opts.parallelBaseRef
    ? { baseRef: opts.parallelBaseRef }
    : {};
  return makeWorktree(host.hostCwd ?? ctx.cwd, subagentId, worktreeOpts);
}

/** Whether a parallel task will run in a dedicated git worktree (not sandbox/shared). */
function parallelTaskUsesWorktree(args: TaskArgs): boolean {
  const preset = resolvePreset(args.agent);
  const isolation = resolveIsolation(args.isolation, preset, true);
  return !("error" in isolation) && isolation.mode === "worktree";
}

export async function runSubagentTask(
  args: TaskArgs,
  ctx: AgentContext,
  signal: AbortSignal,
  deps: TaskDeps = {},
  opts: RunSubagentOptions = {},
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
  const isolationResult = resolveIsolation(args.isolation, preset, opts.parallel ?? false);
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
  let harvest: ReturnType<WorktreeHandle["harvest"]> | undefined;

  host.hooks.emit({
    type: "subagent_start",
    id: subagentId,
    description: args.description,
    // The subagent's prompt — captured as the subagent span's input.value only
    // when captureContent is on (telemetry 7a).
    prompt: args.prompt,
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
    } else if (
      isolationResult.mode === "worktree"
      // In parallel fan-out every child needs its own fresh worktree, so never
      // reuse the session worktree (siblings would collide) — always create one.
      && (opts.parallel || host.sessionIsolation !== "worktree")
    ) {
      const result = spawnSubagentWorktree(host, ctx, subagentId, opts, makeWorktree);
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
        event.type === "llm_start" ||
        event.type === "reasoning_delta"
      ) {
        host.hooks.emit({ ...event, subagentId });
      }
    });

    let loopError: Error | undefined;
    try {
      await runLoop(childCtx, childHooks, {
        provider: host.provider,
        tools: preset.tools,
        model: subagentModel,
        cheapModel: hostCheap,
        system: preset.system,
        signal,
        sessionId: host.sessionId,
        maxTurns: MAX_SUBAGENT_TURNS,
        maxToolCalls: MAX_SUBAGENT_TOOL_CALLS,
        onEvent: host.onEvent,
      });
    } catch (err) {
      // Cancellation is the user stopping the run — let it propagate unchanged.
      if (isAbortError(err) || signal.aborted) throw err;
      // Any other failure (most often the provider rejecting an over-window
      // request when an exploration read too much) must not reach the parent as
      // a raw tool error. The child's messages still hold what it discovered, so
      // fall through and return a best-effort summary flagged as partial (#183).
      loopError = err instanceof Error ? err : new Error(String(err));
    }

    const summary = lastAssistantText(childCtx) || summarizeToolActivity(childCtx);
    const turns = currentTurnCount(childCtx.messages);

    // Commit the worktree's work onto its branch before it is removed, and tell
    // the parent where to find it. The branch survives; the worktree dir does not
    // (unless the commit failed — see the finally block).
    let worktreeNote = "";
    if (worktree) {
      harvest = worktree.harvest();
      worktreeNote = worktreeNoteFor(harvest, worktree.cwd);
    }

    host.hooks.emit({
      type: "subagent_end",
      id: subagentId,
      agent: preset.agent,
      turns,
      summary,
    });

    const status = loopError ? "stopped early" : "finished";
    const header = `Subagent (${preset.agent}) ${status} — ${turns} turn${turns === 1 ? "" : "s"}`;
    const errorNote = loopError
      ? `\n\n⚠️ Exploration was cut short (${loopError.message}). The findings above are `
        + "partial; narrow the scope or investigate the remaining pieces directly if you need more."
      : "";
    return { output: `${header}\n\n${summary}${errorNote}${worktreeNote}` };
  } finally {
    if (worktree) {
      // Harvest even when runLoop threw/aborted, so the child's edits are
      // committed to the branch instead of being discarded by remove().
      if (!harvest) {
        try {
          harvest = worktree.harvest();
        } catch {
          // ignore — fall through and keep the worktree for manual recovery
        }
      }
      // Only delete the worktree once its work is safely on the branch. If the
      // commit failed, leave the dir in place so the user can recover.
      if (harvest && !("error" in harvest)) {
        try {
          worktree.remove();
        } catch {
          // best-effort cleanup; a stale worktree can be pruned with `git worktree prune`
        }
      }
    } else if (ownsWorkspace) {
      await childWorkspace.dispose().catch(() => {});
    }
  }
}

/**
 * When the subagent produced no assistant text at all (e.g. it only called tools),
 * build a fallback summary from the tools that were invoked and their outcomes.
 */
function summarizeToolActivity(ctx: AgentContext): string {
  const toolEntries: string[] = [];
  for (let i = 0; i < ctx.messages.length; i++) {
    const m = ctx.messages[i];
    if (m.role !== "assistant") continue;
    for (const block of m.content) {
      if (block.type === "toolCall") {
        const argSummary = JSON.stringify(block.arguments);
        toolEntries.push(`${block.name}(${argSummary.length > 80 ? argSummary.slice(0, 80) + "…" : argSummary})`);
      }
    }
  }
  if (toolEntries.length === 0) return "(no summary returned)";
  const unique = [...new Set(toolEntries.map((e) => e.split("(")[0]))];
  return `Subagent completed its run (${toolEntries.length} tool call${toolEntries.length === 1 ? "" : "s"} across ${unique.length} tool${unique.length === 1 ? "" : "s"}: ${unique.join(", ")}). Review the tool activity below for details.`;
}

/** Build the parent-facing note describing where a worktree subagent's work landed. */
function worktreeNoteFor(harvest: HarvestResult, dir: string): string {
  if ("error" in harvest) {
    return (
      `\n\n⚠️ Could not commit changes to branch \`${harvest.branch}\` (${harvest.error}). `
      + `The worktree was kept at ${dir} so the work can be recovered.`
    );
  }
  return harvest.committed
    ? `\n\nChanges committed to branch \`${harvest.branch}\`:\n${harvest.diffStat}`
    : `\n\nNo file changes were made (branch \`${harvest.branch}\`).`;
}

export const taskTool: Tool<TaskArgs> = {
  name: "task",
  description: loadToolDescription("task"),
  schema,
  async execute(args, ctx, signal) {
    return runSubagentTask(args, ctx, signal);
  },
};

/**
 * Run an array of subagent tasks concurrently with a bounded worker pool. Each
 * mutating child gets `{ parallel: true }`, which forces a fresh git worktree
 * (never the host tree or session worktree). All such children branch from one
 * snapshot of the parent's working tree (`ctx.cwd`), including uncommitted edits.
 * Read-only children share the parent's tree. The shared `signal` aborts every
 * child; each disposes its worktree/sandbox in `finally`. Results fold back in
 * task order.
 */
export async function runParallelTasks(
  args: ParallelTaskArgs,
  ctx: AgentContext,
  signal: AbortSignal,
  deps: TaskDeps = {},
): Promise<{ output: string; isError?: boolean }> {
  if (!ctx.loopHost) {
    return { output: "Internal error: subagent loop host is not configured.", isError: true };
  }
  if ((ctx.depth ?? 0) >= MAX_SUBAGENT_DEPTH) {
    return { output: "Subagent recursion limit reached.", isError: true };
  }

  const tasks = args.tasks;
  const cap = Math.min(loadConfig().subagent.maxParallel, tasks.length);

  let parallelBaseRef: string | undefined;
  if (tasks.some(parallelTaskUsesWorktree)) {
    const base = resolveParallelWorktreeBase(ctx.cwd);
    if ("error" in base) {
      return { output: base.error, isError: true };
    }
    parallelBaseRef = base.baseRef;
  }

  // Bounded fan-out: `cap` workers pull from a shared cursor so no more than
  // `cap` sandboxes/worktrees exist at once, capping E2B / git-worktree cost.
  const results = new Array<{ output: string; isError?: boolean }>(tasks.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      try {
        results[i] = await runSubagentTask(tasks[i], ctx, signal, deps, {
          parallel: true,
          parallelBaseRef,
        });
      } catch (err) {
        // Cancellation must still tear down the whole fan-out: rethrow so
        // Promise.all rejects while siblings wind down on the same signal and
        // dispose their workspaces in `finally`.
        if (isAbortError(err) || signal.aborted) throw err;
        // Any other throw is a setup/teardown failure for this one child (e.g.
        // sandbox boot or worktree harvest). Record it as that child's error so
        // the pool finishes and successful siblings' output is preserved.
        const message = err instanceof Error ? err.message : String(err);
        results[i] = {
          output: `Subagent failed before returning a summary: ${message}`,
          isError: true,
        };
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));

  const sections = tasks.map((task, i) => {
    const r = results[i];
    const flag = r.isError ? " ⚠️" : "";
    return `### ${i + 1}. ${task.description}${flag}\n\n${r.output}`;
  });

  const failed = results.filter((r) => r.isError).length;
  const header =
    `Parallel fan-out: ${tasks.length} subagents ran concurrently (≤${cap} at once); `
    + `mutating children each ran in an isolated workspace (worktree, or sandbox if requested).`
    + `${failed ? ` ${failed} reported an error.` : ""}`;

  return {
    output: `${header}\n\n${sections.join("\n\n---\n\n")}`,
    // Only a total failure is a tool error; partial results are still useful.
    isError: failed === tasks.length,
  };
}

export const taskParallelTool: Tool<ParallelTaskArgs> = {
  name: "task_parallel",
  description: loadToolDescription("task_parallel"),
  schema: parallelSchema,
  async execute(args, ctx, signal) {
    return runParallelTasks(args, ctx, signal);
  },
};
