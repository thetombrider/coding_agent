#!/usr/bin/env bun

import "dotenv/config";

import { lastAssistantText } from "./agent/loop.js";
import { parseApprovalMode } from "./approval/policy.js";
import { loadConfig, ensureConfigFile } from "./config/config.js";
import { defaultMainModel, loadModelConfig } from "./config/models.js";
import { createStatefulFauxProvider, fauxOneShot, runOneShot } from "./provider/faux.js";
import { streamAssistant } from "./provider/stream.js";
import { generateSessionId, getLastEventTimestamp, listSessions, replayLog, sessionPath } from "./session/log.js";
import { getCoreTools } from "./tools/registry.js";
import { runTuiSession } from "./tui/session.js";
import type { StreamAssistantFn } from "./provider/types.js";
import type { AgentContext } from "./types.js";

const SYSTEM = loadConfig().system.prompt;

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
          toolCalls: [{ id: "tc1", name: "read", arguments: { path: "package.json" } }],
        },
        { text: ["package.json lists 2 runtime dependencies (ai, zod)."] },
        { text: ["How can I help with the codebase?"] },
      ]),
      model: "faux:test",
    };
  }

  if (!process.env.OPENROUTER_API_KEY?.trim() && !loadConfig().provider.openrouter?.apiKey) {
    console.error(
      "OPENROUTER_API_KEY is not set. Use --faux for offline demo, set the env var, or add it to ~/.orin/config.json.",
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
  const cwd = process.cwd();
  const { provider, model } = resolveProvider(opts.useFaux);
  const models = loadModelConfig();

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
    sessionId = generateSessionId();
  }

  const ctx: AgentContext = { cwd, messages };

  await runTuiSession({
    ctx,
    provider,
    tools: getCoreTools(),
    model,
    system: SYSTEM,
    approvalMode: opts.approvalMode,
    autoAcceptCli: opts.autoAcceptCli,
    initialMessage: opts.initialMessage,
    sessionId,
    meta: {
      model: opts.useFaux ? "faux" : models.main,
      approval: opts.approvalMode,
      cwd,
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
  };
  const { provider, model } = resolveProvider(opts.useFaux);
  const { runLoop } = await import("./agent/loop.js");
  const sessionId = opts.useFaux ? undefined : generateSessionId();

  await runLoop(ctx, (event) => {
    if (event.type === "text_delta") process.stdout.write(event.text);
    if (event.type === "tool_start") {
      process.stdout.write(`\n[tool ${event.name}] ${JSON.stringify(event.args)}\n`);
    }
    if (event.type === "tool_end" && event.isError) {
      process.stdout.write(`[tool error] ${event.output}\n`);
    }
  }, {
    provider,
    tools: getCoreTools(),
    model,
    system: SYSTEM,
    sessionId,
    approvalMode: opts.approvalMode,
    autoAcceptCli: opts.autoAcceptCli,
  });

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
    if (!process.env.OPENROUTER_API_KEY) {
      console.error(
        "OPENROUTER_API_KEY is not set. Use --faux for offline demo, or add it to .env.",
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
