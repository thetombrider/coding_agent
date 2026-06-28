import type { ApprovalGateRef } from "./approval-gate.js";
import { installApprovalGate } from "./approval-gate.js";
import { installDelegateReadGate } from "./delegate-read-gate.js";
import { installPromptInject } from "./prompt-inject.js";
import type { HookRegistryImpl } from "./registry.js";
import { installRtkRewrite } from "./rtk-rewrite.js";
import { installSkillInject } from "./skill-inject.js";
import { installSymbolIndexHooks } from "../symbols/hook.js";
import { installTodoInject } from "./todo-inject.js";

/** Register built-in lifecycle hooks: approval gate first, then delegate-read gate, then RTK rewrite, then prompt inject, then todo inject, then skill inject, then symbol index. */
export function installCoreHooks(hooks: HookRegistryImpl, approval: ApprovalGateRef): void {
  installApprovalGate(hooks, approval);
  installDelegateReadGate(hooks);
  installRtkRewrite(hooks);
  installPromptInject(hooks);
  installTodoInject(hooks);
  installSkillInject(hooks);
  installSymbolIndexHooks(hooks);
}
