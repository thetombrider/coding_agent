import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { runLoop } from "../agent/loop.js";
import type { ApprovalMode } from "../approval/policy.js";
import type { ApprovalGateRef } from "../hooks/approval-gate.js";
import { installCoreHooks } from "../hooks/install.js";
import type { HookRegistryImpl } from "../hooks/registry.js";
import { saveConfig, saveProviderConfig } from "../config/config.js";
import { defaultCheapModel } from "../config/models.js";
import { getProvider } from "../provider/registry.js";
import { lastUsedPatchForProviderSwitch, resolveModelOnProviderSwitch } from "../provider/picker-models.js";
import { generateSessionId, listSessions, openLog, replayLog, sessionPath, deleteSession } from "../session/log.js";
import { rebuildTodosFromMessages } from "../todos/store.js";
import { createDefaultSinks, installTelemetry } from "../telemetry/install.js";
import type { LlmCallRecorder } from "../telemetry/events.js";
import type { StreamAssistantFn } from "../provider/types.js";
import type { AnyTool } from "../tools/registry.js";
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

  // Telemetry: the sinks are created once (the session sink writes through the
  // live `log` binding, which is reassigned on resume/new). `reinstallTelemetry`
  // re-subscribes with the current sessionId/provider so metrics never carry a
  // stale identity after /new, /resume, or a provider switch.
  const telemetrySinks = createDefaultSinks({
    sessionWrite: (event) => log.write({ type: "metric", ts: new Date().toISOString(), event }),
  });
  let disposeTelemetry: () => void = () => {};
  let recordSideLlmCall: LlmCallRecorder = () => {};
  const reinstallTelemetry = () => {
    disposeTelemetry();
    const installed = installTelemetry({
      hooks: config.hooks,
      sinks: telemetrySinks,
      sessionId: activeSessionId,
      providerId: config.meta.provider,
    });
    disposeTelemetry = installed.dispose;
    recordSideLlmCall = installed.recordLlmCall;
    // A fresh install rebinds the accumulator, so point the loop host at the
    // new recorder (compaction / delegate_read tag their side-path calls here).
    if (config.ctx.loopHost) config.ctx.loopHost.recordLlmCall = recordSideLlmCall;
  };

  const onResume = (resumeSessionId: string) => {
    void log.close();
    const messages = replayLog(sessionPath(resumeSessionId));
    config.ctx.messages = messages;
    config.ctx.todos = rebuildTodosFromMessages(messages);
    activeSessionId = resumeSessionId;
    log = openLog(sessionPath(activeSessionId));
    if (config.ctx.loopHost) config.ctx.loopHost.sessionId = activeSessionId;
    reinstallTelemetry();
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
  reinstallTelemetry();

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
    reinstallTelemetry();
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
    if (activate) {
      const fromProvider = config.meta.provider ?? "openrouter";
      const { model } = resolveModelOnProviderSwitch(fromProvider, providerId, activeModel);
      setProvider(providerId, model);
      controller.setStatusHint(`${display} configured and active`);
    } else {
      controller.setStatusHint(`${display} configured — saved to ~/.orin/config.json`);
    }
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


  const runTurn = async (userText: string) => {
    const userContent = [{ type: "text" as const, text: userText }];
    config.ctx.messages.push({ role: "user", content: userContent });
    log.write({ type: "user_message", ts: new Date().toISOString(), content: userContent });
    controller.beginTurn(userText);

    try {
      await runLoop(config.ctx, config.hooks, {
        provider: config.provider,
        tools: config.tools,
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
    if (startupCopyHint) controller.setStatusHint(startupCopyHint);

    await render(
      () =>
        App({
          controller,
          onSubmit: runTurn,
          onExit: resolveExit,
          onSetModel: setModel,
          onSetMode: setApprovalMode,
          onSetProvider: setProvider,
          onConfigureProvider: configureProvider,
          onClear: () => {
            config.ctx.messages = [];
            config.ctx.todos = [];
            log.write({ type: "session_clear", ts: new Date().toISOString() });
          },
          onNew,
          onResume,
          onDeleteSession,
          onListSessions: listSessions,
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
