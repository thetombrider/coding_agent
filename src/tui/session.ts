import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { runLoop } from "../agent/loop.js";
import type { IsolationMode } from "../agent/isolation.js";
import type { ApprovalMode } from "../approval/policy.js";
import type { ApprovalGateRef } from "../hooks/approval-gate.js";
import { installCoreHooks } from "../hooks/install.js";
import type { HookRegistryImpl } from "../hooks/registry.js";
import { saveConfig, saveProviderConfig, saveE2BApiKey, saveRoleModel } from "../config/config.js";
import type { AgentPreset } from "../agent/presets.js";
import { defaultCheapModel } from "../config/models.js";
import { getProvider, resolveActiveProvider } from "../provider/registry.js";
import { lastUsedPatchForProviderSwitch, resolveModelOnProviderSwitch } from "../provider/picker-models.js";
import { createCheckpointManager } from "../checkpoint/manager.js";
import { isMutatingTool } from "../checkpoint/tracker.js";
import { generateSessionId, listSessions, openLog, rebuildSessionCost, replayCheckpoints, replayLog, sessionPath, deleteSession } from "../session/log.js";
import { rebuildTodosFromMessages } from "../todos/store.js";
import { SessionCostAccumulator } from "../telemetry/accumulator.js";
import { createDefaultSinks, installTelemetry } from "../telemetry/install.js";
import type { LlmCallRecorder } from "../telemetry/events.js";
import type { StreamAssistantFn } from "../provider/types.js";
import type { AnyTool } from "../tools/registry.js";
import { getCoreTools } from "../tools/registry.js";
import type { AgentContext } from "../types.js";
import { createE2BWorkspace } from "../workspace/e2b.js";
import { createLocalWorkspace } from "../workspace/local.js";
import { REMOTE_SANDBOX_ROOT, seedRepoIntoWorkspace } from "../workspace/seed.js";
import { App } from "./app.js";
import { createSessionController, type SessionMeta } from "./controller.js";
import { messagesToTurns } from "./messages-to-turns.js";
import { restoreTerminal } from "./terminal.js";
import { terminalStartupCopyHint } from "./terminal-env.js";
import { terminalBg, terminalFg, theme } from "./theme.js";

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const osc = (code: number, c: { r: number; g: number; b: number }) =>
  `\x1b]${code};rgb:${hex2(c.r)}/${hex2(c.g)}/${hex2(c.b)}\x07`;
/** Set the terminal's default fg/bg so the emulator's padding matches the theme. */
const SET_TERMINAL_COLORS = osc(11, terminalBg) + osc(10, terminalFg);

export interface TuiSessionConfig {
  ctx: AgentContext;
  provider: StreamAssistantFn;
  tools: AnyTool[];
  model: string;
  system: string;
  approvalMode: ApprovalMode;
  autoAcceptCli: boolean;
  meta: SessionMeta;
  initialMessage?: string;
  sessionId: string;
  hooks: HookRegistryImpl;
}

export async function runTuiSession(config: TuiSessionConfig): Promise<AgentContext> {
  const controller = createSessionController(config.meta);
  config.ctx.todos = rebuildTodosFromMessages(config.ctx.messages);
  controller.setTodos(config.ctx.todos);
  if (config.ctx.messages.length > 0) {
    controller.loadHistory(messagesToTurns(config.ctx.messages));
  }
  config.hooks.observe(controller.handleEvent);
  await config.hooks.fireHook("session_start", { cwd: config.ctx.cwd }, config.ctx);

  let activeSessionId = config.sessionId;
  let log = openLog(sessionPath(activeSessionId));
  const writeMeta = () => {
    log.write({
      type: "session_meta",
      ts: new Date().toISOString(),
      sessionId: activeSessionId,
      cwd: config.ctx.cwd,
      model: config.meta.model,
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
  let disposeTelemetry: () => void = () => {};
  let recordSideLlmCall: LlmCallRecorder = () => {};
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
  };

  const onResume = (resumeSessionId: string) => {
    void log.close();
    const messages = replayLog(sessionPath(resumeSessionId));
    config.ctx.messages = messages;
    config.ctx.todos = rebuildTodosFromMessages(messages);
    activeSessionId = resumeSessionId;
    log = openLog(sessionPath(activeSessionId));
    if (config.ctx.loopHost) config.ctx.loopHost.sessionId = activeSessionId;
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
    if (!deleteSession(sessionId)) {
      return { ok: false, message: `Session ${sessionId} not found.` };
    }
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

  reinstallTelemetry();

  let activeTools = config.tools;
  const refreshTools = () => {
    activeTools = getCoreTools();
    approvalRef.tools = activeTools;
  };

  config.ctx.loopHost = {
    provider: config.provider,
    model: activeModel,
    cheapModel: defaultCheapModel(),
    sessionId: activeSessionId,
    onEvent: (event) => log.write(event),
    hooks: config.hooks,
    approval: approvalRef,
    recordLlmCall: recordSideLlmCall,
  };

  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const setModel = (model: string) => {
    activeModel = model;
    if (config.ctx.loopHost) config.ctx.loopHost.model = model;
    controller.updateMeta({ model });
    saveConfig({ models: { main: model } });
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

  // Persisted only — `resolvePresetModel` reads `models.roles` from config each
  // time the task tool spawns a subagent, so no live ref needs rewiring.
  const setRoleModel = (role: AgentPreset, model: string) => {
    saveRoleModel(role, model);
    controller.setStatusHint(
      model ? `task model · ${role} → ${model}` : `task model · ${role} → default`,
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
    const patch = lastUsedPatchForProviderSwitch(fromProvider, activeModel, defaultCheapModel(fromProvider));
    controller.updateMeta({ provider });
    saveConfig({
      provider: { active: provider },
      models: { lastUsed: patch },
    });
    config.meta.provider = provider;
    // Preserve the running total across the switch by seeding from the live log.
    reinstallTelemetry(rebuildSessionCost(sessionPath(activeSessionId)));
    if (model && model !== activeModel) {
      setModel(model);
    }
  };

  const configureProvider = (
    providerId: string,
    values: Record<string, string>,
    activate: boolean,
  ) => {
    saveProviderConfig(providerId, values);
    const display = getProvider(providerId)?.displayName ?? providerId;
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
      config.ctx.workspace = createLocalWorkspace();
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

    const userContent = [{ type: "text" as const, text: userText }];
    config.ctx.messages.push({ role: "user", content: userContent });
    log.write({ type: "user_message", ts: new Date().toISOString(), content: userContent });
    controller.beginTurn(userText);

    try {
      await runLoop(config.ctx, config.hooks, {
        provider: config.provider,
        tools: activeTools,
        model: activeModel,
        system: config.system,
        sessionId: activeSessionId,
        onEvent: log.write,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      controller.handleEvent({ type: "text_delta", text: `\nError: ${message}` });
    } finally {
      controller.finalizeTurn();
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
    });

    const startupCopyHint = terminalStartupCopyHint();
    if (!config.meta.faux && config.meta.providerConfigured === false) {
      const active = resolveActiveProvider();
      controller.setStatusHint(
        `${active.displayName} needs setup — run /providers configure ${active.id}`,
      );
    } else if (startupCopyHint) {
      controller.setStatusHint(startupCopyHint);
    }

    await render(
      () =>
        App({
          controller,
          onSubmit: runTurn,
          onExit: resolveExit,
          onSetModel: setModel,
          onSetMode: setApprovalMode,
          onSetIsolation: setSubagentIsolation,
          onSetRoleModel: setRoleModel,
          onSetProvider: setProvider,
          onConfigureProvider: configureProvider,
          onConfigureE2b: configureE2b,
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

    if (config.initialMessage) {
      queueMicrotask(() => {
        void runTurn(config.initialMessage!);
      });
    }

    await exitPromise;
  } finally {
    process.removeListener("exit", onProcessExit);
    await config.hooks.fireHook("session_end", { reason: "exit" }, config.ctx);
    disposeTelemetry();
    await config.ctx.workspace.dispose();
    await log.close();
    renderer?.destroy();
    restoreTerminal();
  }

  return config.ctx;
}

/** @deprecated use runTuiSession */
export const runAgentTui = runTuiSession;
