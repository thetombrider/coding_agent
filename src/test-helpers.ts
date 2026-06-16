import type { AgentContext } from "./types.js";
import { createLocalWorkspace } from "./workspace/local.js";

/** Build an AgentContext for tests with a local workspace. */
export function testAgentContext(cwd: string, messages: AgentContext["messages"] = []): AgentContext {
  return { cwd, messages, workspace: createLocalWorkspace() };
}
