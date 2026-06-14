import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { runLoop } from "../agent/loop.js";
import type { ApprovalMode } from "../approval/policy.js";
import type { StreamAssistantFn } from "../provider/types.js";
import type { AnyTool } from "../tools/registry.js";
import type { AgentContext } from "../types.js";
import { App } from "./app.js";
import { createSessionController, type SessionMeta } from "./controller.js";
import { theme } from "./theme.js";

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

  if (config.initialMessage) {
    queueMicrotask(() => {
      void runTurn(config.initialMessage!);
    });
  }

  try {
    await exitPromise;
  } finally {
    renderer.destroy();
  }

  return config.ctx;
}

/** @deprecated use runTuiSession */
export const runAgentTui = runTuiSession;
