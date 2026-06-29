import { createHookRegistry } from "./hooks/registry.js";
import { installCoreHooks } from "./hooks/install.js";
import type { ApprovalGateRef } from "./hooks/approval-gate.js";
import { lastAssistantText } from "./agent/loop.js";
import { parseApprovalMode } from "./approval/policy.js";
import { parseCliArgs } from "./cli-args.js";
import { loadConfig, ensureConfigFile } from "./config/config.js";
import { resolveSystemPrompt } from "./prompt/system.js";
import { resolveProviderSlot } from "./config/models.js";
import { createStatefulFauxProvider, fauxOneShot, runOneShot } from "./provider/faux.js";
import { resolveActiveProvider, repairActiveProviderIfNeeded, activeProviderId } from "./provider/registry.js";
import { streamAssistant } from "./provider/stream.js";
import { generateSessionId, getLastEventTimestamp, listSessions, replayLog, replaySessionMeta, resolveStartupSessionId, sessionPath } from "./session/log.js";
import { resolveSessionIsolation } from "./workspace/session-worktree.js";
import type { SessionIsolationMode } from "./agent/session-isolation.js";
import { rebuildTodosFromMessages } from "./todos/store.js";
import { bootstrapOrinTooling } from "./ratel/session.js";
import { installRatelTelemetry } from "./ratel/telemetry.js";
import { createDefaultSinks, installTelemetry } from "./telemetry/install.js";
import { runTuiSession } from "./tui/session.js";
import type { StreamAssistantFn } from "./provider/types.js";
import type { AgentContext } from "./types.js";
import { createSymbolService } from "./symbols/service.js";
import { attachSymbolService } from "./symbols/hook.js";
import { createLocalWorkspace } from "./workspace/local.js";
import { hasE2BApiKey } from "./config/config.js";

function sessionSystem(cwd: string): string {
  return resolveSystemPrompt(cwd, loadConfig().system.prompt);
}

function createSessionHooks(): ReturnType<typeof createHookRegistry> {
  return createHookRegistry();
}

async function main(): Promise<void> {
  ensureConfigFile();
  const argv = process.argv.slice(2);
  if (argv[0] === "mcp") {
    const { runMcpCli } = await import("./cli/mcp.js");
    await runMcpCli(argv.slice(1));
    return;
  }

  const { prompt, useFaux, headless, listSessions: listSessionsFlag, chat, resumeId, worktree, autoAcceptCli, approvalMode } =
    parseCliArgs(argv);

  if (listSessionsFlag) {
    printSessionList();
    return;
  }

  if (headless) {
    if (!prompt) {
      console.error("Usage: orin --headless <prompt>");
      process.exit(1);
    }
    await runHeadless({ prompt, useFaux, approvalMode, autoAcceptCli, worktree });
    return;
  }

  if (prompt && chat) {
    await runOneShotMode({ prompt, useFaux });
    return;
  }

  await runInteractive({ initialMessage: prompt || undefined, useFaux, approvalMode, autoAcceptCli, resumeId, worktree });
}

function resolveProvider(useFaux: boolean): { provider: StreamAssistantFn; model: string } {
  if (useFaux) {
    return {
      provider: createStatefulFauxProvider([
        {
          reasoning: ["I'll read package.json to see the dependencies."],
          toolCalls: [{ id: "tc1", name: "read", arguments: { path: "package.json" } }],
        },
        {
          reasoning: ["Two runtime deps — ai and zod."],
          text: ["package.json lists 2 runtime dependencies (ai, zod)."],
        },
        { text: ["How can I help with the codebase?"] },
      ]),
      model: "faux:test",
    };
  }

  const requestedId = activeProviderId();
  const active = repairActiveProviderIfNeeded();
  if (!active.isConfigured()) {
    console.error(
      `Provider "${active.id}" (${active.displayName}) is not configured. `
      + "Use --faux for an offline demo, set its API key env var, or add it to ~/.orin/config.json.",
    );
    process.exit(1);
  }
  if (active.id !== requestedId) {
    console.warn(
      `Active provider "${requestedId}" is not configured — using ${active.id} instead.`,
    );
  }

  return { provider: streamAssistant, model: resolveProviderSlot(active.id, "main") };
}

function resolveInteractiveProvider(useFaux: boolean): {
  provider: StreamAssistantFn;
  model: string;
  providerConfigured: boolean;
} {
  if (useFaux) {
    const { provider, model } = resolveProvider(true);
    return { provider, model, providerConfigured: true };
  }

  const active = repairActiveProviderIfNeeded();
  return {
    provider: streamAssistant,
    model: resolveProviderSlot(active.id, "main"),
    providerConfigured: active.isConfigured(),
  };
}

async function runInteractive(opts: {
  initialMessage?: string;
  useFaux: boolean;
  approvalMode: ReturnType<typeof parseApprovalMode>;
  autoAcceptCli: boolean;
  resumeId?: string;
  worktree: boolean;
}): Promise<void> {
  const { provider, model, providerConfigured } = resolveInteractiveProvider(opts.useFaux);
  const hostCwd = process.cwd();
  const sessionIsolation = resolveSessionIsolation(loadConfig().session?.isolation, opts.worktree);

  let messages: AgentContext["messages"] = [];
  let sessionId: string;
  let sessionMeta = undefined;

  if (opts.resumeId) {
    const path = sessionPath(opts.resumeId);
    messages = replayLog(path);
    sessionMeta = replaySessionMeta(path);
    const turns = messages.filter((m) => m.role === "user").length;
    const lastTs = getLastEventTimestamp(path);
    const ago = lastTs ? formatRelativeTime(lastTs) : "unknown";
    process.stderr.write(
      `Resuming session ${opts.resumeId} — ${turns} turn${turns !== 1 ? "s" : ""}, last active ${ago}\n`,
    );
    sessionId = opts.resumeId;
  } else {
    sessionId = resolveStartupSessionId(hostCwd, { isolation: sessionIsolation });
    if (sessionIsolation === "worktree") {
      sessionMeta = replaySessionMeta(sessionPath(sessionId));
    }
  }

  const effectiveIsolation: SessionIsolationMode =
    sessionMeta?.isolation ?? sessionIsolation;

  const sandboxPref = loadConfig().sandbox?.active;
  const workspace = createLocalWorkspace({ sessionId });
  const ctx: AgentContext = { cwd: hostCwd, messages, workspace, todos: rebuildTodosFromMessages(messages) };
  attachSymbolService(ctx, createSymbolService());
  const hooks = createSessionHooks();
  const tooling = await bootstrapOrinTooling(hostCwd, sessionId);
  for (const warning of tooling.mcpWarnings) console.warn(warning);

  await runTuiSession({
    ctx,
    provider,
    tools: tooling.tools,
    ratel: tooling.ratel,
    mcpTools: tooling.mcpTools,
    mcpDispose: tooling.mcpDispose,
    mcpServers: tooling.mcpServers,
    mcpStartupHint: tooling.mcpStatusHint,
    model,
    system: sessionSystem(hostCwd),
    approvalMode: opts.approvalMode,
    autoAcceptCli: opts.autoAcceptCli,
    initialMessage: opts.initialMessage,
    sessionId,
    hooks,
    hostCwd,
    sessionIsolation: effectiveIsolation,
    sessionMeta,
    meta: {
      model: opts.useFaux ? "faux" : model,
      provider: opts.useFaux ? "faux" : resolveActiveProvider().id,
      approval: opts.approvalMode,
      cwd: hostCwd,
      hostCwd,
      sessionIsolation: effectiveIsolation,
      sandbox: sandboxPref === "e2b" && hasE2BApiKey() ? "e2b" : "local",
      faux: opts.useFaux,
      providerConfigured: opts.useFaux || providerConfigured,
    },
  });
  // Force process exit after TUI cleanup — the renderer can leave active handles
  // that prevent Node from exiting naturally (user would need Ctrl+C otherwise).
  process.exit(0);
}

function formatRelativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function printSessionList(): void {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }
  const idCol = 10;
  const dateCol = 18;
  const turnsCol = 9;
  for (const s of sessions) {
    const id = s.sessionId.padEnd(idCol);
    const date = formatDateTime(s.lastTs || s.createdAt).padEnd(dateCol);
    const turns = `${s.turns} turn${s.turns !== 1 ? "s" : ""}`.padStart(turnsCol);
    const cwd = s.cwd.replace(process.env.HOME ?? "/root", "~");
    console.log(`${id}  ${date}  ${turns}  ${cwd}`);
  }
}

function formatDateTime(ts: string): string {
  try {
    const d = new Date(ts);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${min}`;
  } catch {
    return ts;
  }
}

async function runHeadless(opts: {
  prompt: string;
  useFaux: boolean;
  approvalMode: ReturnType<typeof parseApprovalMode>;
  autoAcceptCli: boolean;
  worktree: boolean;
}): Promise<void> {
  const hostCwd = process.cwd();
  const sessionIsolation = resolveSessionIsolation(loadConfig().session?.isolation, opts.worktree);
  let cwd = hostCwd;
  let sessionBranch: string | undefined;
  let worktreeHandle: import("./workspace/worktree.js").WorktreeHandle | undefined;

  if (sessionIsolation === "worktree") {
    const sessionId = generateSessionId();
    const { bootstrapSessionWorktree } = await import("./workspace/session-worktree.js");
    const wt = bootstrapSessionWorktree(hostCwd, sessionId);
    if ("error" in wt) {
      console.error(wt.error);
      process.exit(1);
    }
    cwd = wt.binding.handle.cwd;
    sessionBranch = wt.binding.branch;
    worktreeHandle = wt.binding.handle;
  }

  const ctx: AgentContext = {
    cwd,
    messages: [{ role: "user", content: [{ type: "text", text: opts.prompt }] }],
    workspace: createLocalWorkspace(),
  };
  attachSymbolService(ctx, createSymbolService({ logWarmStats: true }));
  const { provider, model } = resolveProvider(opts.useFaux);
  const { runLoop } = await import("./agent/loop.js");
  const sessionId = opts.useFaux ? undefined : generateSessionId();
  const effectiveSessionId = sessionId ?? generateSessionId();
  const hooks = createSessionHooks();
  const tooling = await bootstrapOrinTooling(hostCwd, effectiveSessionId);
  for (const warning of tooling.mcpWarnings) console.warn(warning);

  const approvalRef: ApprovalGateRef = {
    mode: opts.approvalMode,
    autoAcceptCli: opts.autoAcceptCli,
    tools: tooling.tools,
  };
  installCoreHooks(hooks, approvalRef);

  // Telemetry: turn/tool metrics plus a session summary flushed at session_end
  // (fired in the finally below). No session-log sink in headless mode.
  const telemetrySinks = createDefaultSinks();
  const telemetry = installTelemetry({
    hooks,
    sinks: telemetrySinks,
    sessionId: effectiveSessionId,
    providerId: opts.useFaux ? "faux" : resolveActiveProvider().id,
  });
  let disposeRatelTelemetry: () => void = () => {};
  if (tooling.ratel) {
    disposeRatelTelemetry = installRatelTelemetry({
      hooks,
      sessionId: effectiveSessionId,
      sinks: telemetrySinks,
      getBundle: () => tooling.ratel,
    });
  }

  ctx.loopHost = {
    provider,
    model,
    sessionId,
    hooks,
    approval: approvalRef,
    recordLlmCall: telemetry.recordLlmCall,
    hostCwd: sessionIsolation === "worktree" ? hostCwd : undefined,
    sessionBranch,
    sessionIsolation,
  };

  hooks.observe((event) => {
    if (event.type === "text_delta") process.stdout.write(event.text);
    if (event.type === "tool_start") {
      process.stdout.write(`\n[tool ${event.name}] ${JSON.stringify(event.args)}\n`);
    }
    if (event.type === "tool_end" && event.isError) {
      process.stdout.write(`[tool error] ${event.output}\n`);
    }
  });

  await hooks.fireHook("session_start", { cwd: hostCwd }, ctx);
  try {
    await runLoop(ctx, hooks, {
      provider,
      tools: tooling.tools,
      model,
      system: sessionSystem(hostCwd),
      sessionId,
      ratel: tooling.ratel,
    });
  } finally {
    disposeRatelTelemetry();
    await hooks.fireHook("session_end", { reason: "complete" }, ctx);
    await tooling.mcpDispose();
    if (worktreeHandle) {
      worktreeHandle.harvest();
      try {
        worktreeHandle.remove();
      } catch {
        // best-effort
      }
    }
    await ctx.workspace.dispose();
  }

  const answer = lastAssistantText(ctx);
  if (answer && !answer.endsWith("\n")) process.stdout.write("\n");
}

async function runOneShotMode(opts: { prompt: string; useFaux: boolean }): Promise<void> {
  let provider: StreamAssistantFn;
  let model: string;

  if (opts.useFaux) {
    provider = fauxOneShot(
      "Hello from Orin! Phase 1 provider stream is working (faux mode).",
    );
    model = "faux:test";
  } else {
    const requestedId = activeProviderId();
    const active = repairActiveProviderIfNeeded();
    if (!active.isConfigured()) {
      console.error(
        `Provider "${active.id}" (${active.displayName}) is not configured. `
        + "Use --faux for an offline demo, or configure it in ~/.orin/config.json.",
      );
      process.exit(1);
    }
    if (active.id !== requestedId) {
      console.warn(
        `Active provider "${requestedId}" is not configured — using ${active.id} instead.`,
      );
    }
    provider = streamAssistant;
    model = resolveProviderSlot(active.id, "main");
  }

  await runOneShot(
    provider,
    opts.prompt,
    { model, system: "You are Orin, a concise coding assistant." },
    (chunk) => process.stdout.write(chunk),
  );
  process.stdout.write("\n");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
