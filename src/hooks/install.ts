import type { ApprovalGateRef } from "./approval-gate.js";
import { installApprovalGate } from "./approval-gate.js";
import type { HookRegistryImpl } from "./registry.js";
import { installRtkRewrite } from "./rtk-rewrite.js";

/** Register built-in lifecycle hooks: approval gate first, then RTK rewrite. */
export function installCoreHooks(hooks: HookRegistryImpl, approval: ApprovalGateRef): void {
  installApprovalGate(hooks, approval);
  installRtkRewrite(hooks);
}
