import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { runLoop } from "../agent/loop.js";
import type { ApprovalMode } from "../approval/policy.js";
import type { StreamAssistantFn } from "../provider/types.js";
import type { AnyTool } from "../tools/registry.js";
import type { AgentContext } from "../types.js";
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
}

export async function runTuiSession(config: TuiSessionConfig): Promise<AgentContext> {
  const controller = createSessionController(config.meta);

  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const runTurn = async (userText: string) => {
    config.ctx.messages.push({
      role: "user",
      content: [{ type: "text", text: userText }],
    });
    controller.beginTurn(userText);

    try {
      await runLoop(config.ctx, controller.handleEvent, {
        provider: config.provider,
        tools: config.tools,
        model: config.model,
        system: config.system,
        approvalMode: config.approvalMode,
        autoAcceptCli: config.autoAcceptCli,
        confirm: controller.requestApproval,
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
    renderer.destroy();
    if (process.stdout.isTTY) process.stdout.write(RESET_TERMINAL_COLORS);
  }

  return config.ctx;
}

/** @deprecated use runTuiSession */
export const runAgentTui = runTuiSession;
