import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { runLoop } from "../agent/loop.js";
import type { ApprovalMode } from "../approval/policy.js";
import { saveConfig } from "../config/config.js";
import { generateSessionId, listSessions, openLog, replayLog, sessionPath } from "../session/log.js";
import type { StreamAssistantFn } from "../provider/types.js";
import type { AnyTool } from "../tools/registry.js";
import type { AgentContext, Message } from "../types.js";
import { App } from "./app.js";
import { createSessionController, type SessionMeta } from "./controller.js";
import { terminalBg, terminalFg, theme } from "./theme.js";

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const osc = (code: number, c: { r: number; g: number; b: number }) =>
  `\x1b]${code};rgb:${hex2(c.r)}/${hex2(c.g)}/${hex2(c.b)}\x07`;
/** Set the terminal's default fg/bg so the emulator's padding matches the theme. */
const SET_TERMINAL_COLORS = osc(11, terminalBg) + osc(10, terminalFg);
const RESET_TERMINAL_COLORS = "\x1b]111\x07\x1b]110\x07";

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
}

export async function runTuiSession(config: TuiSessionConfig): Promise<AgentContext> {
  const controller = createSessionController(config.meta);

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
    controller.updateMeta({ approval: mode });
    saveConfig({ approval: { mode } });
  };

  const runTurn = async (userText: string) => {
    const userContent = [{ type: "text" as const, text: userText }];
    config.ctx.messages.push({ role: "user", content: userContent });
    log.write({ type: "user_message", ts: new Date().toISOString(), content: userContent });
    controller.beginTurn(userText);

    try {
      await runLoop(config.ctx, controller.handleEvent, {
        provider: config.provider,
        tools: config.tools,
        model: activeModel,
        system: config.system,
        approvalMode: activeApprovalMode,
        autoAcceptCli: config.autoAcceptCli,
        confirm: controller.requestApproval,
        onEvent: log.write,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      controller.handleEvent({ type: "text_delta", text: `\nError: ${message}` });
    } finally {
      controller.finalizeTurn();
    }
  };

  const renderer = await createCliRenderer({
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

  try {
    await exitPromise;
  } finally {
    await log.close();
    renderer.destroy();
    if (process.stdout.isTTY) process.stdout.write(RESET_TERMINAL_COLORS);
  }

  return config.ctx;
}

/** Convert a flat message list into displayable turns for the controller. */
function messagesToTurns(messages: Message[]) {
  const turns: { userText: string; assistantText: string; tools: [] }[] = [];
  let current: { userText: string; assistantText: string } | null = null;
  for (const msg of messages) {
    if (msg.role === "user") {
      if (current) turns.push({ ...current, tools: [] });
      const text = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      current = { userText: text, assistantText: "" };
    } else if (msg.role === "assistant" && current) {
      const text = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      current.assistantText += text;
    }
  }
  if (current) turns.push({ ...current, tools: [] });
  return turns;
}

/** @deprecated use runTuiSession */
export const runAgentTui = runTuiSession;
