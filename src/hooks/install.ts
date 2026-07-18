import type { ApprovalGateRef } from "./approval-gate.js";
import { installApprovalGate } from "./approval-gate.js";
import { installDelegateReadGate } from "./delegate-read-gate.js";
import { installPromptInject } from "./prompt-inject.js";
import { installProposeTodo } from "./propose-todo.js";
import type { HookRegistryImpl } from "./registry.js";
import { installRtkRewrite } from "./rtk-rewrite.js";
import { installSkillInject } from "./skill-inject.js";
import { installReadStalenessHooks } from "./read-staleness.js";
import { installSymbolIndexHooks } from "../symbols/hook.js";
import { installTodoInject } from "./todo-inject.js";

/** Register built-in lifecycle hooks: approval gate first, then delegate-read gate, then RTK rewrite, then prompt inject, then todo inject, then propose_todo, then skill inject, then symbol index, then read staleness. */
export function installCoreHooks(hooks: HookRegistryImpl, approval: ApprovalGateRef): void {
  installApprovalGate(hooks, approval);
  installDelegateReadGate(hooks);
  installRtkRewrite(hooks);
  installPromptInject(hooks);
  installTodoInject(hooks);
  installProposeTodo(hooks);
  installSkillInject(hooks);
  installSymbolIndexHooks(hooks);
  installReadStalenessHooks(hooks);
}
