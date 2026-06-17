import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { runLoop } from "../agent/loop.js";
import type { ApprovalMode } from "../approval/policy.js";
import type { ApprovalGateRef } from "../hooks/approval-gate.js";
import { installCoreHooks } from "../hooks/install.js";
import type { HookRegistryImpl } from "../hooks/registry.js";
import { saveConfig, saveProviderConfig } from "../config/config.js";
import { getProvider } from "../provider/registry.js";
import { generateSessionId, listSessions, openLog, replayLog, sessionPath } from "../session/log.js";
import type { StreamAssistantFn } from "../provider/types.js";
import type { AnyTool } from "../tools/registry.js";
import type { AgentContext } from "../types.js";
import { createE2BWorkspace } from "../workspace/e2b.js";
import { createLocalWorkspace } from "../workspace/local.js";
import { REMOTE_SANDBOX_ROOT, seedRepoIntoWorkspace } from "../workspace/seed.js";
import type { SandboxKind } from "../workspace/types.js";
import { App } from "./app.js";
import { createSessionController, type SessionMeta } from "./controller.js";
import { messagesToTurns } from "./messages-to-turns.js";
import { restoreTerminal } from "./terminal.js";
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

  const onResume = (resumeSessionId: string) => {
    void log.close();
    const messages = replayLog(sessionPath(resumeSessionId));
    config.ctx.messages = messages;
    activeSessionId = resumeSessionId;
    log = openLog(sessionPath(activeSessionId));
    const turns = messagesToTurns(messages);
    controller.loadHistory(turns);
    controller.setStatusHint(
      `Resumed session ${resumeSessionId} — ${turns.length} turn${turns.length !== 1 ? "s" : ""}`,
    );
  };

  // Archive the current session (already persisted to its own log file) and
  // start a fresh one with a new id, empty history, and its own log.
  const onNew = () => {
    const previousId = activeSessionId;
    void log.close();
    config.ctx.messages = [];
    activeSessionId = generateSessionId();
    log = openLog(sessionPath(activeSessionId));
    writeMeta();
    controller.clearHistory();
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

  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const setModel = (model: string) => {
    activeModel = model;
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
  const setProvider = (provider: string) => {
    controller.updateMeta({ provider });
    saveConfig({ provider: { active: provider } });
  };

  const configureProvider = (providerId: string, values: Record<string, string>, activate: boolean) => {
    saveProviderConfig(providerId, values);
    const display = getProvider(providerId)?.displayName ?? providerId;
    if (activate) {
      setProvider(providerId);
      controller.setStatusHint(`${display} configured and active`);
    } else {
      controller.setStatusHint(`${display} configured — saved to ~/.orin/config.json`);
    }
  };

  let activeSandbox: SandboxKind = config.meta.sandbox === "e2b" ? "e2b" : "local";

  const setSandbox = async (kind: SandboxKind) => {
    controller.setStatusHint(`Switching to ${kind} sandbox…`);
    try {
      await config.ctx.workspace.dispose();
      if (kind === "e2b") {
        config.ctx.workspace = await createE2BWorkspace();
        config.ctx.cwd = REMOTE_SANDBOX_ROOT;
        const seedMessage = await seedRepoIntoWorkspace(config.ctx.workspace, config.meta.cwd);
        controller.setStatusHint(seedMessage);
      } else {
        config.ctx.workspace = createLocalWorkspace();
        config.ctx.cwd = config.meta.cwd;
        controller.setStatusHint(`sandbox → ${kind}`);
      }
      activeSandbox = kind;
      controller.updateMeta({ sandbox: kind, cwd: config.ctx.cwd });
      saveConfig({ sandbox: { active: kind } });
    } catch (err) {
      await config.ctx.workspace.dispose().catch(() => {});
      config.ctx.workspace = createLocalWorkspace();
      config.ctx.cwd = config.meta.cwd;
      activeSandbox = "local";
      controller.updateMeta({ sandbox: "local", cwd: config.ctx.cwd });
      const message = err instanceof Error ? err.message : String(err);
      controller.setStatusHint(`sandbox switch failed: ${message}`);
    }
  };

  if (activeSandbox === "e2b") {
    await setSandbox("e2b");
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
          onSetSandbox: setSandbox,
          getSandbox: () => activeSandbox,
          onClear: () => {
            config.ctx.messages = [];
            log.write({ type: "session_clear", ts: new Date().toISOString() });
          },
          onNew,
          onResume,
          onListSessions: listSessions,
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
    await config.ctx.workspace.dispose();
    await log.close();
    renderer?.destroy();
    restoreTerminal();
  }

  return config.ctx;
}

/** @deprecated use runTuiSession */
export const runAgentTui = runTuiSession;
