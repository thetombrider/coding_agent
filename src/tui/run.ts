import { render } from "ink";
import React from "react";
import { runLoop } from "../agent/loop.js";
import type { ApprovalMode } from "../approval/policy.js";
import type { StreamAssistantFn } from "../provider/types.js";
import type { AnyTool } from "../tools/registry.js";
import type { AgentContext } from "../types.js";
import { App } from "./app.js";
import { createTuiController } from "./controller.js";

export interface RunAgentTuiOptions {
  ctx: AgentContext;
  provider: StreamAssistantFn;
  tools: AnyTool[];
  model: string;
  system: string;
  approvalMode: ApprovalMode;
  autoAcceptCli: boolean;
  statusLine: string;
}

export async function runAgentTui(options: RunAgentTuiOptions): Promise<AgentContext> {
  const controller = createTuiController(options.statusLine);

  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const { waitUntilExit, unmount } = render(
    React.createElement(App, {
      controller,
      onExit: () => {
        resolveExit();
        unmount();
      },
    }),
  );

  const loopPromise = runLoop(options.ctx, controller.handleEvent, {
    provider: options.provider,
    tools: options.tools,
    model: options.model,
    system: options.system,
    approvalMode: options.approvalMode,
    autoAcceptCli: options.autoAcceptCli,
    confirm: controller.requestApproval,
  });

  await loopPromise;
  await exitPromise;
  await waitUntilExit();
  return options.ctx;
}
