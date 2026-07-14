import type { ApprovalMode } from "../approval/policy.js";
import {
  isAutoApprovedBash,
  isToolBlocked,
  needsInteractiveApproval,
} from "../approval/policy.js";
import { confirmTool } from "../approval/prompt.js";
import type { AnyTool } from "../tools/registry.js";
import type { HookRegistryImpl } from "./registry.js";

/** Mutable approval state shared across turns in a session. */
export interface ApprovalGateRef {
  mode: ApprovalMode;
  autoAcceptCli: boolean;
  tools: AnyTool[];
  confirm?: (
    name: string,
    args: unknown,
    providerInputSchema?: Record<string, unknown>,
  ) => Promise<boolean>;
}

export function installApprovalGate(
  hooks: HookRegistryImpl,
  ref: ApprovalGateRef,
): () => void {
  return hooks.on("before_tool", async ({ id, name, args }, ctx) => {
    if (ctx.invokeToolInner) return;
    const tool = ref.tools.find((t) => t.name === name);
    const display = tool?.approvalDisplayArgs?.(args) ?? { name, args };
    const autoApproved = isAutoApprovedBash(name, args);
    const displayTool =
      display.name !== name
        ? ref.tools.find((t) => t.name === display.name) ?? tool
        : tool;
    const providerInputSchema = displayTool?.providerInputSchema;

    if (isToolBlocked(ref.mode, name)) {
      hooks.emit({
        type: "approval_required",
        id,
        name: display.name,
        args: display.args,
        providerInputSchema,
      });
      return { block: true, reason: `Tool ${name} blocked in plan mode.` };
    }

    const requiresApproval = needsInteractiveApproval(
      ref.mode,
      ref.autoAcceptCli,
      name,
      tool?.needsApproval?.(args, ctx),
      autoApproved,
    );

    if (!requiresApproval) return;

    hooks.emit({
      type: "approval_required",
      id,
      name: display.name,
      args: display.args,
      providerInputSchema,
    });
    const approved = await (ref.confirm ?? confirmTool)(
      display.name,
      display.args,
      providerInputSchema,
    );
    if (!approved) {
      return { block: true, reason: "Tool execution denied by user." };
    }
  });
}
