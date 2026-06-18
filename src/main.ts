import "dotenv/config";

import { createHookRegistry } from "./hooks/registry.js";
import { installCoreHooks } from "./hooks/install.js";
import type { ApprovalGateRef } from "./hooks/approval-gate.js";
import { lastAssistantText } from "./agent/loop.js";
import { parseApprovalMode } from "./approval/policy.js";
import { loadConfig, ensureConfigFile } from "./config/config.js";
import { resolveSystemPrompt } from "./prompt/system.js";
import { defaultCheapModel, defaultMainModel, loadModelConfig } from "./config/models.js";
import { createStatefulFauxProvider, fauxOneShot, runOneShot } from "./provider/faux.js";
import { resolveActiveProvider } from "./provider/registry.js";
import { streamAssistant } from "./provider/stream.js";
import { generateSessionId, getLastEventTimestamp, listSessions, replayLog, resolveStartupSessionId, sessionPath } from "./session/log.js";
import { rebuildTodosFromMessages } from "./todos/store.js";
import { getCoreTools } from "./tools/registry.js";
import { createDefaultSinks, installTelemetry } from "./telemetry/install.js";
import { runTuiSession } from "./tui/session.js";
import type { StreamAssistantFn } from "./provider/types.js";
import type { AgentContext } from "./types.js";
import { createLocalWorkspace } from "./workspace/local.js";
import { hasE2BApiKey } from "./config/config.js";

function sessionSystem(cwd: string): string {
  return resolveSystemPrompt(cwd, loadConfig().system.prompt);
}

function createSessionHooks(): ReturnType<typeof createHookRegistry> {
  return createHookRegistry();
}

function flagValue(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith("-")) {
      return args[idx + 1];
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  ensureConfigFile();
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("-")));
  const promptParts = args.filter((a) => !a.startsWith("-"));
  const prompt = promptParts.join(" ").trim();

  const useFaux = flags.has("--faux");
  const headless = flags.has("--headless");
  const listSessionsFlag = flags.has("--list-sessions") || flags.has("-l");
  const resumeId = flagValue(args, "--resume", "-r");
  const autoAcceptCli = flags.has("--auto-accept") || useFaux;
  const approvalMode = flags.has("--plan")
    ? "plan"
    : autoAcceptCli
      ? "auto-accept"
      : parseApprovalMode();

  if (listSessionsFlag) {
    printSessionList();
    return;
  }

  if (headless) {
    if (!prompt) {
      console.error("Usage: orin --headless <prompt>");
      process.exit(1);
    }
    await runHeadless({ prompt, useFaux, approvalMode, autoAcceptCli });
    return;
  }

  if (prompt && flags.has("--chat")) {
    await runOneShotMode({ prompt, useFaux });
    return;
  }

  await runInteractive({ initialMessage: prompt || undefined, useFaux, approvalMode, autoAcceptCli, resumeId });
}

function resolveProvider(useFaux: boolean): { provider: StreamAssistantFn; model: string } {
  if (useFaux) {
    return {
      provider: createStatefulFauxProvider([
        {
          reasoning: ["I'll read package.json to see the dependencies."],
          toolCalls: [{ id: "tc1", name: "read", arguments: { path: "package.json" } }],
        },
        {
          reasoning: ["Two runtime deps — ai and zod."],
          text: ["package.json lists 2 runtime dependencies (ai, zod)."],
        },
        { text: ["How can I help with the codebase?"] },
      ]),
      model: "faux:test",
    };
  }

  const active = resolveActiveProvider();
  if (!active.isConfigured()) {
    console.error(
      `Provider "${active.id}" (${active.displayName}) is not configured. `
      + "Use --faux for an offline demo, set its API key env var, or add it to ~/.orin/config.json.",
    );
    process.exit(1);
  }

  return { provider: streamAssistant, model: defaultMainModel() };
}

async function runInteractive(opts: {
  initialMessage?: string;
  useFaux: boolean;
  approvalMode: ReturnType<typeof parseApprovalMode>;
  autoAcceptCli: boolean;
  resumeId?: string;
}): Promise<void> {
  const { provider, model } = resolveProvider(opts.useFaux);
  const models = loadModelConfig();
  const localCwd = process.cwd();

  let messages: AgentContext["messages"] = [];
  let sessionId: string;

  if (opts.resumeId) {
    const path = sessionPath(opts.resumeId);
    messages = replayLog(path);
    const turns = messages.filter((m) => m.role === "user").length;
    const lastTs = getLastEventTimestamp(path);
    const ago = lastTs ? formatRelativeTime(lastTs) : "unknown";
    process.stderr.write(
      `Resuming session ${opts.resumeId} — ${turns} turn${turns !== 1 ? "s" : ""}, last active ${ago}\n`,
    );
    sessionId = opts.resumeId;
  } else {
    sessionId = resolveStartupSessionId(localCwd);
  }

  const sandboxPref = loadConfig().sandbox?.active;
  const workspace = createLocalWorkspace();
  const ctx: AgentContext = { cwd: localCwd, messages, workspace, todos: rebuildTodosFromMessages(messages) };
  const hooks = createSessionHooks();

  await runTuiSession({
    ctx,
    provider,
    tools: getCoreTools(),
    model,
    system: sessionSystem(localCwd),
    approvalMode: opts.approvalMode,
    autoAcceptCli: opts.autoAcceptCli,
    initialMessage: opts.initialMessage,
    sessionId,
    hooks,
    meta: {
      model: opts.useFaux ? "faux" : models.main,
      provider: opts.useFaux ? "faux" : resolveActiveProvider().id,
      approval: opts.approvalMode,
      cwd: localCwd,
      sandbox: sandboxPref === "e2b" && hasE2BApiKey() ? "e2b" : "local",
      faux: opts.useFaux,
    },
  });
}

function formatRelativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function printSessionList(): void {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }
  const idCol = 10;
  const dateCol = 18;
  const turnsCol = 9;
  for (const s of sessions) {
    const id = s.sessionId.padEnd(idCol);
    const date = formatDateTime(s.lastTs || s.createdAt).padEnd(dateCol);
    const turns = `${s.turns} turn${s.turns !== 1 ? "s" : ""}`.padStart(turnsCol);
    const cwd = s.cwd.replace(process.env.HOME ?? "/root", "~");
    console.log(`${id}  ${date}  ${turns}  ${cwd}`);
  }
}

function formatDateTime(ts: string): string {
  try {
    const d = new Date(ts);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${min}`;
  } catch {
    return ts;
  }
}

async function runHeadless(opts: {
  prompt: string;
  useFaux: boolean;
  approvalMode: ReturnType<typeof parseApprovalMode>;
  autoAcceptCli: boolean;
}): Promise<void> {
  const cwd = process.cwd();
  const ctx: AgentContext = {
    cwd,
    messages: [{ role: "user", content: [{ type: "text", text: opts.prompt }] }],
    workspace: createLocalWorkspace(),
  };
  const { provider, model } = resolveProvider(opts.useFaux);
  const { runLoop } = await import("./agent/loop.js");
  const sessionId = opts.useFaux ? undefined : generateSessionId();
  const hooks = createSessionHooks();
  const approvalRef: ApprovalGateRef = {
    mode: opts.approvalMode,
    autoAcceptCli: opts.autoAcceptCli,
    tools: getCoreTools(),
  };
  installCoreHooks(hooks, approvalRef);

  // Telemetry: turn/tool metrics plus a session summary flushed at session_end
  // (fired in the finally below). No session-log sink in headless mode.
  installTelemetry({
    hooks,
    sinks: createDefaultSinks(),
    sessionId: sessionId ?? generateSessionId(),
    providerId: opts.useFaux ? "faux" : resolveActiveProvider().id,
  });

  ctx.loopHost = {
    provider,
    model,
    cheapModel: defaultCheapModel(),
    sessionId,
    hooks,
    approval: approvalRef,
  };

  hooks.observe((event) => {
    if (event.type === "text_delta") process.stdout.write(event.text);
    if (event.type === "tool_start") {
      process.stdout.write(`\n[tool ${event.name}] ${JSON.stringify(event.args)}\n`);
    }
    if (event.type === "tool_end" && event.isError) {
      process.stdout.write(`[tool error] ${event.output}\n`);
    }
  });

  await hooks.fireHook("session_start", { cwd }, ctx);
  try {
    await runLoop(ctx, hooks, {
      provider,
      tools: getCoreTools(),
      model,
      system: sessionSystem(cwd),
      sessionId,
    });
  } finally {
    await hooks.fireHook("session_end", { reason: "complete" }, ctx);
    await ctx.workspace.dispose();
  }

  const answer = lastAssistantText(ctx);
  if (answer && !answer.endsWith("\n")) process.stdout.write("\n");
}

async function runOneShotMode(opts: { prompt: string; useFaux: boolean }): Promise<void> {
  let provider: StreamAssistantFn;
  let model: string;

  if (opts.useFaux) {
    provider = fauxOneShot(
      "Hello from Orin! Phase 1 provider stream is working (faux mode).",
    );
    model = "faux:test";
  } else {
    const active = resolveActiveProvider();
    if (!active.isConfigured()) {
      console.error(
        `Provider "${active.id}" (${active.displayName}) is not configured. `
        + "Use --faux for an offline demo, or configure it in ~/.orin/config.json.",
      );
      process.exit(1);
    }
    provider = streamAssistant;
    model = defaultMainModel();
  }

  await runOneShot(
    provider,
    opts.prompt,
    { model, system: "You are Orin, a concise coding assistant." },
    (chunk) => process.stdout.write(chunk),
  );
  process.stdout.write("\n");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
