import type { ApprovalGateRef } from "./approval-gate.js";
import { installApprovalGate } from "./approval-gate.js";
import { installPromptInject } from "./prompt-inject.js";
import type { HookRegistryImpl } from "./registry.js";
import { installRtkRewrite } from "./rtk-rewrite.js";
import { installSymbolIndexHooks } from "../symbols/hook.js";
import { installTodoInject } from "./todo-inject.js";

/** Register built-in lifecycle hooks: approval gate first, then RTK rewrite, then prompt inject, then todo inject, then symbol index. */
export function installCoreHooks(hooks: HookRegistryImpl, approval: ApprovalGateRef): void {
  installApprovalGate(hooks, approval);
  installRtkRewrite(hooks);
  installPromptInject(hooks);
  installTodoInject(hooks);
  installSymbolIndexHooks(hooks);
}
