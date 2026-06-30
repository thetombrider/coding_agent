import { createCliRenderer } from "@opentui/core";
import { existsSync } from "node:fs";
import { render } from "@opentui/solid";
import { runLoop } from "../agent/loop.js";
import type { IsolationMode } from "../agent/isolation.js";
import type { SessionIsolationMode } from "../agent/session-isolation.js";
import { sessionWorktreeEnableHint } from "../agent/workspace-settings.js";
import type { ApprovalMode } from "../approval/policy.js";
import type { ApprovalGateRef } from "../hooks/approval-gate.js";
import { installCoreHooks } from "../hooks/install.js";
import type { HookRegistryImpl } from "../hooks/registry.js";
import { saveConfig, saveProviderConfig, saveE2BApiKey, saveExaApiKey, saveProviderModelSlot, type ModelSlot } from "../config/config.js";
import { getProvider, resolveActiveProvider, activeProviderId } from "../provider/registry.js";
import { getContextWindow } from "../provider/context-window.js";
import { resolveModelOnProviderSwitch } from "../provider/picker-models.js";
import { createCheckpointManager } from "../checkpoint/manager.js";
import { isMutatingTool } from "../checkpoint/tracker.js";
import { removeCheckpointRepo, scheduleCheckpointCleanup } from "../checkpoint/retention.js";
import { generateSessionId, listSessions, openLog, rebuildSessionCost, replayCheckpoints, replayLog, replaySessionMeta, sessionPath, deleteSession } from "../session/log.js";
import type { SessionMetaRecord } from "../session/log.js";
import { rebuildTodosFromMessages } from "../todos/store.js";
import { SessionCostAccumulator } from "../telemetry/accumulator.js";
import { createDefaultSinks, installTelemetry } from "../telemetry/install.js";
import type { LlmCallRecorder } from "../telemetry/events.js";
import type { StreamAssistantFn } from "../provider/types.js";
import type { AnyTool } from "../tools/registry.js";
import { getCoreTools } from "../tools/registry.js";
import type { OrinRatelBundle } from "../ratel/catalog.js";
import { reloadOrinTooling } from "../ratel/session.js";
import { installRatelTelemetry } from "../ratel/telemetry.js";
import type { McpServerConfig } from "../mcp/config.js";
import { removeMcpServer, upsertMcpServer } from "../mcp/config.js";
import { loadMcpServers, type McpServerStatus } from "../mcp/loader.js";
import { authenticateMcpServer, enableMcpOAuth } from "../mcp/oauth.js";
import type { AgentContext } from "../types.js";
import { createE2BWorkspace } from "../workspace/e2b.js";
import { createLocalWorkspace } from "../workspace/local.js";
import { REMOTE_SANDBOX_ROOT, seedRepoIntoWorkspace } from "../workspace/seed.js";
import { bootstrapSessionWorktree, removeSessionWorktree, type SessionWorktreeBinding } from "../workspace/session-worktree.js";
import { App } from "./app.js";
import { installCrashDiagnostics } from "./crash.js";
import { createSessionController, type SessionMeta } from "./controller.js";
import { messagesToTurns } from "./messages-to-turns.js";
import { forceFullRepaint, restoreTerminal } from "./terminal.js";
import {
  blocksNativeCopyShortcut,
  consumeMouseReports,
  consumeTerminalCapabilityLeak,
  terminalStartupCopyHint,
} from "./terminal-env.js";
import { terminalBg, terminalFg, theme } from "./theme.js";
import { isAbortError } from "../util/abort.js";

/** Max time to wait for an in-flight turn to settle after abort before teardown. */
const TURN_STOP_TIMEOUT_MS = 5000;

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const osc = (code: number, c: { r: number; g: number; b: number }) =>
  `\x1b]${code};rgb:${hex2(c.r)}/${hex2(c.g)}/${hex2(c.b)}\x07`;
/** Set the terminal's default fg/bg so the emulator's padding matches the theme. */
const SET_TERMINAL_COLORS = osc(11, terminalBg) + osc(10, terminalFg);

export interface McpReloadResult {
  servers: McpServerStatus[];
  statusHint?: string;
  warnings: string[];
}

export interface McpSessionHost {
  getServers: () => McpServerStatus[];
  reload: () => Promise<McpReloadResult>;
  saveServer: (
    name: string,
    server: McpServerConfig,
    opts?: { replace?: string },
  ) => Promise<McpReloadResult>;
  removeServer: (name: string) => Promise<McpReloadResult>;
  authenticateServer: (name: string) => Promise<McpReloadResult>;
  enableOAuth: (name: string) => Promise<McpReloadResult>;
}

export interface TuiSessionConfig {
  ctx: AgentContext;
  provider: StreamAssistantFn;
  tools: AnyTool[];
  /** Ratel bundle when `ratel.enabled` is set in config (issue #295). */
  ratel?: OrinRatelBundle;
  /** MCP tools merged into `tools`; kept separately for refreshTools(). */
  mcpTools?: AnyTool[];
  mcpDispose?: () => Promise<void>;
  mcpServers?: McpServerStatus[];
  /** Startup status hint after MCP servers connect, e.g. "MCP: fs (8 tools)". */
  mcpStartupHint?: string;
  model: string;
  system: string;
  approvalMode: ApprovalMode;
  autoAcceptCli: boolean;
  meta: SessionMeta;
  initialMessage?: string;
  sessionId: string;
  hooks: HookRegistryImpl;
  /** Repo root where Orin was launched (host tree). */
  hostCwd: string;
  /** Resolved whole-session isolation for the parent loop. */
  sessionIsolation: SessionIsolationMode;
  /** Prior session_meta when resuming or reusing an empty worktree session. */
  sessionMeta?: SessionMetaRecord;
}

export async function runTuiSession(config: TuiSessionConfig): Promise<AgentContext> {
  const controller = createSessionController(config.meta);
  // Let the askuser tool pause the loop and surface a question to this UI.
  config.ctx.askUser = controller.requestQuestion;
  config.ctx.todos = rebuildTodosFromMessages(config.ctx.messages);
  controller.setTodos(config.ctx.todos);
  if (config.ctx.messages.length > 0) {
    controller.loadHistory(messagesToTurns(config.ctx.messages));
  }
  config.hooks.observe(controller.handleEvent);
  // A subagent can `propose_todo` to push a replacement list to the parent
  // (issue #149). The child's own `ctx.todos` is never touched — the proposal
  // is forwarded to the host's hooks, we apply it to the parent context here
  // and re-emit a canonical `todo_update` so every observer (controller UI,
  // reminders, telemetry) sees a single source of truth.
  config.hooks.observe((event) => {
    if (event.type !== "todo_proposal") return;
    config.ctx.todos = event.todos;
    config.hooks.emit({ type: "todo_update", todos: event.todos });
  });
  await config.hooks.fireHook("session_start", { cwd: config.ctx.cwd }, config.ctx);

  let activeSessionId = config.sessionId;
  let sessionWorktree: SessionWorktreeBinding | undefined;

  const applyWorktreeBinding = (binding: SessionWorktreeBinding) => {
    sessionWorktree = binding;
    config.ctx.cwd = binding.handle.cwd;
    if (config.ctx.loopHost) {
      config.ctx.loopHost.hostCwd = binding.hostCwd;
      config.ctx.loopHost.sessionBranch = binding.branch;
      config.ctx.loopHost.sessionIsolation = "worktree";
    }
    controller.updateMeta({
      cwd: binding.handle.cwd,
      hostCwd: binding.hostCwd,
      branch: binding.branch,
      sessionIsolation: "worktree",
    });
  };

  const clearWorktreeBinding = () => {
    sessionWorktree = undefined;
    config.ctx.cwd = config.hostCwd;
    if (config.ctx.loopHost) {
      config.ctx.loopHost.hostCwd = undefined;
      config.ctx.loopHost.sessionBranch = undefined;
      config.ctx.loopHost.sessionIsolation = "shared";
    }
    controller.updateMeta({
      cwd: config.hostCwd,
      hostCwd: config.hostCwd,
      branch: undefined,
      sessionIsolation: "shared",
    });
  };

  const bindSessionWorktree = (sessionId: string, meta?: SessionMetaRecord) => {
    if (config.sessionIsolation !== "worktree") return;
    const result = bootstrapSessionWorktree(config.hostCwd, sessionId, meta);
    if ("error" in result) {
      controller.setStatusHint(`worktree bootstrap failed: ${result.error} — running in shared mode`);
      config.sessionIsolation = "shared";
      config.ctx.cwd = config.hostCwd;
      return;
    }
    applyWorktreeBinding(result.binding);
  };

  bindSessionWorktree(activeSessionId, config.sessionMeta);

  // Crash breadcrumbs: log JS-level faults to ~/.orin/crash.log and detect a
  // prior session that died without a clean exit (e.g. a native renderer abort
  // on resume-from-sleep) so the next launch can surface it. See ./crash.ts.
  const crash = installCrashDiagnostics({
    sessionId: activeSessionId,
    getCwd: () => config.ctx.cwd,
  });

  let log = openLog(sessionPath(activeSessionId));
  const writeMeta = () => {
    log.write({
      type: "session_meta",
      ts: new Date().toISOString(),
      sessionId: activeSessionId,
      cwd: config.ctx.cwd,
      model: config.meta.model,
      hostCwd: config.hostCwd,
      branch: sessionWorktree?.branch,
      worktreeDir: sessionWorktree?.worktreeDir,
      isolation: config.sessionIsolation,
    });
  };
  writeMeta();

  // Workspace checkpoints: a shadow git repo per session snapshots the local tree
  // after each mutating tool so the user can /restore. No-op under E2B (disposable).
  const checkpoints = createCheckpointManager({
    getSessionId: () => activeSessionId,
    getWorkTree: () => config.ctx.cwd,
    isLocalWorkspace: () => config.ctx.workspace.kind === "local",
    record: (rec) =>
      log.write({
        type: "checkpoint",
        ts: rec.ts,
        checkpointId: rec.id,
        label: rec.label,
        tool: rec.tool,
      }),
  });

  // Telemetry: the sinks are created once (the session sink writes through the
  // live `log` binding, which is reassigned on resume/new). `reinstallTelemetry`
  // re-subscribes with the current sessionId/provider so metrics never carry a
  // stale identity after /new, /resume, or a provider switch.
  const telemetrySinks = createDefaultSinks({
    sessionWrite: (event) => log.write({ type: "metric", ts: new Date().toISOString(), event }),
  });
  let activeTools = config.tools;
  let ratelBundle = config.ratel;
  let currentMcpTools = config.mcpTools ?? [];
  let currentMcpDispose = config.mcpDispose;
  let mcpServers = config.mcpServers ?? [];
  let disposeTelemetry: () => void = () => {};
  let disposeRatelTelemetry: () => void = () => {};
  let recordSideLlmCall: LlmCallRecorder = () => {};
  const reinstallRatelTelemetry = () => {
    disposeRatelTelemetry();
    if (!ratelBundle) return;
    disposeRatelTelemetry = installRatelTelemetry({
      hooks: config.hooks,
      sessionId: activeSessionId,
      sinks: telemetrySinks,
      getBundle: () => ratelBundle,
    });
  };
  // Each (re)install can be seeded with a prebuilt accumulator so the running
  // header total survives resume / provider switch instead of resetting to zero.
  const reinstallTelemetry = (seed?: SessionCostAccumulator) => {
    disposeTelemetry();
    const accumulator = seed ?? new SessionCostAccumulator(activeSessionId);
    const installed = installTelemetry({
      hooks: config.hooks,
      sinks: telemetrySinks,
      sessionId: activeSessionId,
      providerId: config.meta.provider,
      accumulator,
      onSessionCost: (snapshot) => controller.setSessionCost(snapshot),
    });
    disposeTelemetry = installed.dispose;
    recordSideLlmCall = installed.recordLlmCall;
    // A fresh install rebinds the accumulator, so point the loop host at the
    // new recorder (compaction / delegate_read tag their side-path calls here).
    if (config.ctx.loopHost) config.ctx.loopHost.recordLlmCall = recordSideLlmCall;
    // Reflect the seeded (or reset) total in the header before the next turn.
    controller.setSessionCost(accumulator.snapshot());
    reinstallRatelTelemetry();
  };

  const onResume = (resumeSessionId: string) => {
    void log.close();
    const path = sessionPath(resumeSessionId);
    const messages = replayLog(path);
    const meta = replaySessionMeta(path);
    config.ctx.messages = messages;
    config.ctx.todos = rebuildTodosFromMessages(messages);
    activeSessionId = resumeSessionId;
    log = openLog(sessionPath(activeSessionId));
    if (config.ctx.loopHost) config.ctx.loopHost.sessionId = activeSessionId;
    if (meta?.isolation === "worktree") {
      config.sessionIsolation = "worktree";
      bindSessionWorktree(activeSessionId, meta);
    } else {
      sessionWorktree = undefined;
      clearWorktreeBinding();
      config.sessionIsolation = "shared";
    }
    // Seed the resumed session's checkpoints so /restore can target them.
    checkpoints.bind(activeSessionId, replayCheckpoints(sessionPath(activeSessionId)));
    // Rebuild the cost accumulator from the resumed log so the header total is
    // correct (and continues to grow) before the next turn.
    reinstallTelemetry(rebuildSessionCost(sessionPath(activeSessionId)));
    const turns = messagesToTurns(messages);
    controller.loadHistory(turns);
    controller.setTodos(config.ctx.todos);
    controller.setStatusHint(
      `Resumed session ${resumeSessionId} — ${turns.length} turn${turns.length !== 1 ? "s" : ""}`,
    );
  };

  const onDeleteSession = (sessionId: string): { ok: boolean; message: string } => {
    if (sessionId === activeSessionId) {
      return {
        ok: false,
        message: "Cannot delete the active session — use /new to archive it first.",
      };
    }
    const path = sessionPath(sessionId);
    const meta = replaySessionMeta(path);
    if (!existsSync(path)) {
      return { ok: false, message: `Session ${sessionId} not found.` };
    }
    removeSessionWorktree(sessionId, meta);
    if (!deleteSession(sessionId)) {
      return { ok: false, message: `Session ${sessionId} not found.` };
    }
    // Reclaim the session's shadow-git checkpoint repo too, so deleting a session
    // leaves no orphaned snapshots growing under ~/.orin/checkpoints.
    removeCheckpointRepo(sessionId);
    return { ok: true, message: `Deleted session ${sessionId}.` };
  };

  // Archive the current session (already persisted to its own log file) and
  // start a fresh one with a new id, empty history, and its own log.
  const onNew = () => {
    const previousId = activeSessionId;
    void log.close();
    config.ctx.messages = [];
    config.ctx.todos = [];
    activeSessionId = generateSessionId();
    log = openLog(sessionPath(activeSessionId));
    if (config.ctx.loopHost) config.ctx.loopHost.sessionId = activeSessionId;
    sessionWorktree = undefined;
    if (config.sessionIsolation === "worktree") {
      bindSessionWorktree(activeSessionId);
    } else {
      config.ctx.cwd = config.hostCwd;
    }
    writeMeta();
    // Fresh session: empty checkpoint list, then baseline the current tree.
    checkpoints.bind(activeSessionId, []);
    checkpoints.baseline();
    reinstallTelemetry();
    controller.clearHistory();
    controller.setTodos([]);
    controller.setStatusHint(
      `New session ${activeSessionId} — archived ${previousId} (browse via /sessions)`,
    );
  };

  // Mutable so /model and /mode take effect on the next turn.
  let activeModel = config.model;
  let activeApprovalMode = config.approvalMode;

  // Resolve the active model's context window (provider catalog → config →
  // default) and fold it into the header meta so the context-fill badge has a
  // denominator. Async + best-effort: a slow/unreachable catalog just leaves the
  // badge hidden until it resolves. Skipped under --faux (no real model).
  const refreshContextWindow = (model: string) => {
    if (config.meta.faux) return;
    void getContextWindow(model)
      .then((contextWindow) => controller.updateMeta({ contextWindow }))
      .catch(() => {});
  };

  const approvalRef: ApprovalGateRef = {
    mode: activeApprovalMode,
    autoAcceptCli: config.autoAcceptCli,
    tools: config.tools,
    confirm: controller.requestApproval,
  };
  installCoreHooks(config.hooks, approvalRef);

  // After each mutating tool on the primary agent's local tree, snapshot a
  // checkpoint. Subagents (depth > 0) may run in isolated trees, so skip them.
  config.hooks.on("after_tool", ({ name }, ctx) => {
    if ((ctx.depth ?? 0) > 0 || !isMutatingTool(name)) return;
    const rec = checkpoints.afterTool(name);
    if (rec) controller.setStatusHint(`checkpoint ${rec.id} — /restore ${rec.id} to undo`);
  });

  config.hooks.on("after_tool", ({ name }, ctx) => {
    if (name === "skill_write" && ratelBundle) {
      ratelBundle.refreshSkills(ctx.cwd);
    }
  });

  reinstallTelemetry();

  const refreshTools = () => {
    if (ratelBundle) {
      void applyMcpLoad();
      return;
    }
    const flatTools = [...getCoreTools(), ...currentMcpTools];
    activeTools = flatTools;
    approvalRef.tools = activeTools;
  };

  const applyMcpLoad = async (): Promise<McpReloadResult> => {
    await currentMcpDispose?.();
    if (ratelBundle) {
      const tooling = await reloadOrinTooling(config.ctx.cwd, activeSessionId);
      ratelBundle = tooling.ratel;
      activeTools = tooling.tools;
      currentMcpTools = tooling.mcpTools;
      currentMcpDispose = tooling.mcpDispose;
      mcpServers = tooling.mcpServers;
      approvalRef.tools = activeTools;
      reinstallRatelTelemetry();
      return {
        servers: tooling.mcpServers,
        statusHint: tooling.mcpStatusHint,
        warnings: tooling.mcpWarnings,
      };
    }
    const mcp = await loadMcpServers(config.hostCwd);
    currentMcpTools = mcp.tools;
    currentMcpDispose = mcp.dispose;
    mcpServers = mcp.servers;
    activeTools = [...getCoreTools(), ...currentMcpTools];
    approvalRef.tools = activeTools;
    return { servers: mcp.servers, statusHint: mcp.statusHint, warnings: mcp.warnings };
  };

  const mcpHost: McpSessionHost = {
    getServers: () => mcpServers,
    reload: applyMcpLoad,
    saveServer: async (name, server, opts) => {
      upsertMcpServer(name, server, opts);
      return applyMcpLoad();
    },
    removeServer: async (name) => {
      removeMcpServer(name);
      return applyMcpLoad();
    },
    authenticateServer: async (name) => {
      const result = await authenticateMcpServer(name);
      if (!result.ok) {
        return {
          servers: mcpServers,
          warnings: [`MCP OAuth failed for "${name}": ${result.error ?? "unknown error"}`],
          statusHint: `MCP OAuth failed: ${name}`,
        };
      }
      return applyMcpLoad();
    },
    enableOAuth: async (name) => {
      enableMcpOAuth(name);
      return applyMcpLoad();
    },
  };

  config.ctx.loopHost = {
    provider: config.provider,
    model: activeModel,
    sessionId: activeSessionId,
    onEvent: (event) => log.write(event),
    hooks: config.hooks,
    approval: approvalRef,
    recordLlmCall: recordSideLlmCall,
    hostCwd: sessionWorktree?.hostCwd,
    sessionBranch: sessionWorktree?.branch,
    sessionIsolation: config.sessionIsolation,
  };

  // Seed the header's context-fill denominator for the starting model.
  refreshContextWindow(activeModel);

  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  let turnAbort: AbortController | null = null;
  const activeTurn = { promise: null as Promise<void> | null };

  const stopTurn = () => {
    controller.rejectPendingApproval();
    controller.rejectPendingQuestion();
    turnAbort?.abort();
  };

  const requestExit = () => {
    stopTurn();
    resolveExit();
  };

  const setModel = (model: string) => {
    activeModel = model;
    if (config.ctx.loopHost) config.ctx.loopHost.model = model;
    controller.updateMeta({ model });
    refreshContextWindow(model);
    saveProviderModelSlot(config.meta.provider ?? activeProviderId(), "main", model);
  };

  const setApprovalMode = (mode: ApprovalMode) => {
    activeApprovalMode = mode;
    approvalRef.mode = mode;
    controller.updateMeta({ approval: mode });
    saveConfig({ approval: { mode } });
  };

  // Persisted only — the task tool reads `subagent.isolation` from config when it
  // spawns a child, so no live ref needs rewiring.
  const setSubagentIsolation = (isolation: IsolationMode) => {
    saveConfig({ subagent: { isolation } });
    controller.setStatusHint(`subagent isolation → ${isolation}`);
  };

  const setSessionIsolation = (isolation: SessionIsolationMode) => {
    if (isolation === config.sessionIsolation) {
      controller.setStatusHint(`session isolation already ${isolation}`);
      return;
    }

    if (isolation === "worktree" && config.meta.sandbox === "e2b") {
      controller.setStatusHint("session worktree requires a local workspace (not E2B sandbox)");
      return;
    }

    config.sessionIsolation = isolation;

    if (isolation === "worktree") {
      saveConfig({ session: { isolation: "worktree" } });
      bindSessionWorktree(activeSessionId, replaySessionMeta(sessionPath(activeSessionId)));
      if (config.sessionIsolation !== "worktree") {
        saveConfig({ session: { isolation: "shared" } });
        return;
      }
      writeMeta();
      controller.setStatusHint(sessionWorktreeEnableHint(sessionWorktree?.branch));
      return;
    }

    saveConfig({ session: { isolation: "shared" } });
    clearWorktreeBinding();
    writeMeta();
    controller.setStatusHint("Parent → host tree (serial subagents use your isolation floor)");
  };

  // Opt-in OTLP content capture (telemetry 7a). The OTel exporter reads
  // `captureContent` when the consumer is built, so re-subscribe telemetry to
  // pick up the change this session; seed from the live log to preserve the
  // running cost total across the reinstall.
  const setTelemetryCapture = (enabled: boolean) => {
    saveConfig({ telemetry: { otel: { captureContent: enabled } } });
    reinstallTelemetry(rebuildSessionCost(sessionPath(activeSessionId)));
    controller.setStatusHint(
      enabled
        ? "telemetry content capture → on (prompts/responses on OTLP spans when an endpoint is set)"
        : "telemetry content capture → off",
    );
  };

  const setModelSlot = (slot: ModelSlot, model: string, providerId: string) => {
    saveProviderModelSlot(providerId, slot, model);
    controller.setStatusHint(
      model
        ? `model slot · ${providerId} · ${slot} → ${model}`
        : `model slot · ${providerId} · ${slot} → default (use provider default)`,
    );
  };

  // Persist the active provider. The provider call paths (stream/delegate/
  // compaction) resolve the active provider from config on each turn, so the
  // switch takes effect on the next turn without rewiring the loop.
  const setProvider = (provider: string, model?: string) => {
    const impl = getProvider(provider);
    if (impl && !impl.isConfigured()) {
      controller.setStatusHint(`${provider} is not configured — complete setup first`);
      return;
    }
    const fromProvider = config.meta.provider ?? "openrouter";
    saveProviderModelSlot(fromProvider, "main", activeModel);
    controller.updateMeta({ provider });
    saveConfig({ provider: { active: provider } });
    config.meta.provider = provider;
    // Preserve the running total across the switch by seeding from the live log.
    reinstallTelemetry(rebuildSessionCost(sessionPath(activeSessionId)));
    if (model && model !== activeModel) {
      setModel(model);
    } else {
      // Provider catalogs can disagree on the same model's window, so re-resolve
      // even when the model id is unchanged.
      refreshContextWindow(activeModel);
    }
  };

  const configureProvider = (
    providerId: string,
    values: Record<string, string>,
    activate: boolean,
  ) => {
    const provider = getProvider(providerId);
    saveProviderConfig(providerId, values, provider?.configSection);
    const display = provider?.displayName ?? providerId;
    controller.updateMeta({ providerConfigured: true });
    if (activate) {
      const fromProvider = config.meta.provider ?? "openrouter";
      const { model } = resolveModelOnProviderSwitch(fromProvider, providerId, activeModel);
      setProvider(providerId, model);
      controller.setStatusHint(`${display} configured and active`);
    } else {
      controller.setStatusHint(`${display} configured — saved to ~/.orin/config.json`);
    }
  };

  const configureE2b = (apiKey: string) => {
    saveE2BApiKey(apiKey);
    refreshTools();
    controller.setStatusHint("E2B configured — task tool enabled");
  };

  const configureExa = (apiKey: string) => {
    saveExaApiKey(apiKey);
    refreshTools();
    controller.setStatusHint("Exa configured — web_search tool enabled");
  };

  const bootstrapE2BSandbox = async () => {
    controller.setStatusHint("Starting E2B sandbox…");
    try {
      await config.ctx.workspace.dispose();
      config.ctx.workspace = await createE2BWorkspace();
      config.ctx.cwd = REMOTE_SANDBOX_ROOT;
      const seedMessage = await seedRepoIntoWorkspace(config.ctx.workspace, config.meta.cwd);
      controller.updateMeta({ sandbox: "e2b", cwd: config.ctx.cwd });
      controller.setStatusHint(seedMessage);
    } catch (err) {
      await config.ctx.workspace.dispose().catch(() => {});
      config.ctx.workspace = createLocalWorkspace({ sessionId: activeSessionId });
      config.ctx.cwd = config.meta.cwd;
      controller.updateMeta({ sandbox: "local", cwd: config.ctx.cwd });
      const message = err instanceof Error ? err.message : String(err);
      controller.setStatusHint(`sandbox bootstrap failed: ${message}`);
    }
  };

  if (config.meta.sandbox === "e2b") {
    await bootstrapE2BSandbox();
  }

  // Baseline the starting tree once the final workspace is settled, so even the
  // first edit is reversible. No-op for E2B.
  checkpoints.baseline();

  const runTurn = async (userText: string) => {
    if (!config.meta.faux) {
      const active = resolveActiveProvider();
      if (!active.isConfigured()) {
        controller.setStatusHint(
          `${active.displayName} is not configured — run /providers configure ${active.id}`,
        );
        return;
      }
    }

    turnAbort?.abort();
    const abort = new AbortController();
    turnAbort = abort;

    const userContent = [{ type: "text" as const, text: userText }];
    config.ctx.messages.push({ role: "user", content: userContent });
    log.write({ type: "user_message", ts: new Date().toISOString(), content: userContent });
    controller.beginTurn(userText);

    let cancelled = false;
    try {
      await runLoop(config.ctx, config.hooks, {
        provider: config.provider,
        tools: activeTools,
        ratel: ratelBundle,
        model: activeModel,
        system: config.system,
        sessionId: activeSessionId,
        onEvent: log.write,
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted || isAbortError(err)) {
        cancelled = true;
      } else {
        const message = err instanceof Error ? err.message : String(err);
        controller.handleEvent({ type: "text_delta", text: `\nError: ${message}` });
      }
    } finally {
      if (turnAbort === abort) turnAbort = null;
      controller.finalizeTurn();
      if (cancelled || abort.signal.aborted) {
        controller.setStatusHint("Turn stopped — ready for input");
      }
    }
  };

  const runTurnTracked = async (userText: string) => {
    const turn = runTurn(userText);
    activeTurn.promise = turn;
    try {
      await turn;
    } finally {
      if (activeTurn.promise === turn) activeTurn.promise = null;
    }
  };

  // Creating the renderer switches the terminal into raw mode / the alternate
  // screen and enables mouse tracking. From here on, any failure (a renderer or
  // render error, an uncaught exception, or the process being killed) must
  // restore it — otherwise the user is left with a garbled terminal echoing
  // mouse/color-query escapes. `process.exit` fires the "exit" event, so this
  // also covers hard exits.
  const onProcessExit = () => restoreTerminal();
  process.once("exit", onProcessExit);

  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined;
  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      backgroundColor: theme.bg,
      // Forward OPENTUI_GRAPHICS to the *native* renderer so it actually honors
      // the disable. OpenTUI only forwards env vars to native when asked
      // (otherwise none are), which is why setting OPENTUI_GRAPHICS=0 alone never
      // stopped the native Kitty graphics probe — native never saw it. The
      // forward loop skips undefined vars, so this is a no-op on terminals where
      // we don't set it (i.e. everything except Terminal.app).
      forwardEnvKeys: ["OPENTUI_GRAPHICS"],
      // Belt-and-suspenders: if a terminal ever feeds OpenTUI's leaked Kitty
      // graphics probe back on stdin, drop it before it reaches the prompt.
      prependInputHandlers: [consumeTerminalCapabilityLeak, consumeMouseReports],
    });

    const startupCopyHint = terminalStartupCopyHint();
    if (!config.meta.faux && config.meta.providerConfigured === false) {
      const active = resolveActiveProvider();
      controller.setStatusHint(
        `${active.displayName} needs setup — run /providers configure ${active.id}`,
      );
    } else if (crash.previousCrashes.length > 0) {
      controller.setStatusHint(
        "Previous Orin session ended unexpectedly — details in ~/.orin/crash.log",
      );
    } else if (config.mcpStartupHint) {
      controller.setStatusHint(config.mcpStartupHint);
    } else if (startupCopyHint) {
      controller.setStatusHint(startupCopyHint);
    }

    await render(
      () =>
        App({
          controller,
          onSubmit: runTurnTracked,
          onStopTurn: stopTurn,
          onExit: requestExit,
          onSetModel: setModel,
          onSetMode: setApprovalMode,
          onSetIsolation: setSubagentIsolation,
          onSetSessionIsolation: setSessionIsolation,
          onSetTelemetryCapture: setTelemetryCapture,
          onSetModelSlot: setModelSlot,
          onSetProvider: setProvider,
          onConfigureProvider: configureProvider,
          onConfigureE2b: configureE2b,
          onConfigureExa: configureExa,
          mcpHost,
          onClear: () => {
            config.ctx.messages = [];
            config.ctx.todos = [];
            log.write({ type: "session_clear", ts: new Date().toISOString() });
          },
          onNew,
          onResume,
          onDeleteSession,
          onListSessions: listSessions,
          onListCheckpoints: () => checkpoints.list(),
          onRestoreCheckpoint: (id) => checkpoints.restore(id),
          activeSessionId,
        }),
      renderer,
    );

    // Set the terminal's default fg/bg AFTER OpenTUI has switched to the alternate
    // screen (done in native setup during render), so the emulator paints its
    // window padding with the theme color instead of its own default. Re-assert on
    // the next tick in case the initial frame races the screen switch.
    if (process.stdout.isTTY) {
      process.stdout.write(SET_TERMINAL_COLORS);
      setTimeout(() => {
        if (process.stdout.isTTY) process.stdout.write(SET_TERMINAL_COLORS);
      }, 50);
    }

    // Terminal.app paints OpenTUI's native Kitty graphics probe as literal text
    // in the prompt (it can't parse the APC wrapper, and native writes it past
    // any JS output hook). Force a couple of full repaints once startup settles
    // so OpenTUI overwrites those stray cells. No-op everywhere else.
    if (blocksNativeCopyShortcut() && renderer) {
      const r = renderer;
      for (const delay of [150, 600]) {
        const t = setTimeout(() => forceFullRepaint(r), delay);
        t.unref?.();
      }
    }

    // Reclaim old shadow-git checkpoint repos under ~/.orin/checkpoints (gc the
    // survivors, delete dirs past the age/count caps). Non-blocking and deferred
    // well clear of the terminal capability handshake so it can never perturb it.
    scheduleCheckpointCleanup({ protect: [activeSessionId] }, 2000);

    if (config.initialMessage) {
      queueMicrotask(() => {
        void runTurnTracked(config.initialMessage!);
      });
    }

    await exitPromise;
  } finally {
    process.removeListener("exit", onProcessExit);
    stopTurn();
    const pendingTurn = activeTurn.promise;
    if (pendingTurn) {
      await Promise.race([
        pendingTurn.then(() => undefined, () => undefined),
        new Promise((resolve) => setTimeout(resolve, TURN_STOP_TIMEOUT_MS)),
      ]);
    }
    disposeRatelTelemetry();
    await config.hooks.fireHook("session_end", { reason: "exit" }, config.ctx);
    await currentMcpDispose?.();
    disposeTelemetry();
    await config.ctx.workspace.dispose();
    await log.close();
    renderer?.destroy();
    restoreTerminal();
    crash.markCleanExit();
    crash.dispose();
  }

  return config.ctx;
}

/** @deprecated use runTuiSession */
export const runAgentTui = runTuiSession;
