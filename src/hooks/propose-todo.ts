import { proposeTodoSchema } from "../tools/propose-todo.js";
import type { HookRegistryImpl } from "./registry.js";

/**
 * Forward a subagent's `propose_todo` call as a `todo_proposal` event on the
 * *current* hook registry (issue #149). Installed on the child's hooks via
 * `installCoreHooks`, so the event is emitted on the child side first; the
 * child → parent forwarder in `task.ts` then re-emits it on the host's hooks
 * with the `subagentId` tag. The parent session applies the proposal to its
 * own `ctx.todos`.
 *
 * Re-parsing the args from the `after_tool` event keeps the proposal contents
 * authoritative — the tool's schema validation has already run by this point,
 * so a parse failure here would only fire if the hook ever sees an
 * unvalidated call.
 */
export function installProposeTodo(hooks: HookRegistryImpl): void {
  hooks.on("after_tool", ({ name, args, output }) => {
    if (name !== "propose_todo") return;
    if (output.startsWith("Error")) return;
    const parsed = proposeTodoSchema.safeParse(args);
    if (!parsed.success) return;
    hooks.emit({ type: "todo_proposal", todos: parsed.data.todos });
  });
}
