#!/usr/bin/env bun

import "dotenv/config";

import { lastAssistantText } from "./agent/loop.js";
import { parseApprovalMode } from "./approval/policy.js";
import { loadConfig } from "./config/config.js";
import { defaultMainModel, loadModelConfig } from "./config/models.js";
import { createStatefulFauxProvider, fauxOneShot, runOneShot } from "./provider/faux.js";
import { streamAssistant } from "./provider/stream.js";
import { getCoreTools } from "./tools/registry.js";
import { runTuiSession } from "./tui/session.js";
import type { StreamAssistantFn } from "./provider/types.js";
import type { AgentContext } from "./types.js";

const SYSTEM = loadConfig().system.prompt;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const promptParts = args.filter((a) => !a.startsWith("--"));
  const prompt = promptParts.join(" ").trim();

  const useFaux = flags.has("--faux");
  const headless = flags.has("--headless");
  const autoAcceptCli = flags.has("--auto-accept") || useFaux;
  const approvalMode = flags.has("--plan")
    ? "plan"
    : autoAcceptCli
      ? "auto-accept"
      : parseApprovalMode();

  if (headless) {
    if (!prompt) {
      console.error("Usage: minicoder --headless <prompt>");
      process.exit(1);
    }
    await runHeadless({ prompt, useFaux, approvalMode, autoAcceptCli });
    return;
  }

  if (prompt && flags.has("--chat")) {
    await runOneShotMode({ prompt, useFaux });
    return;
  }

  await runInteractive({ initialMessage: prompt || undefined, useFaux, approvalMode, autoAcceptCli });
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
      "OPENROUTER_API_KEY is not set. Use --faux for offline demo, set the env var, or add it to ~/.coding-agent/config.json.",
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
}): Promise<void> {
  const cwd = process.cwd();
  const ctx: AgentContext = { cwd, messages: [] };
  const { provider, model } = resolveProvider(opts.useFaux);
  const models = loadModelConfig();

  await runTuiSession({
    ctx,
    provider,
    tools: getCoreTools(),
    model,
    system: SYSTEM,
    approvalMode: opts.approvalMode,
    autoAcceptCli: opts.autoAcceptCli,
    initialMessage: opts.initialMessage,
    meta: {
      model: opts.useFaux ? "faux" : models.main,
      approval: opts.approvalMode,
      cwd,
      faux: opts.useFaux,
    },
  });
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
      "Hello from minicoder! Phase 1 provider stream is working (faux mode).",
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
    { model, system: "You are a concise coding assistant." },
    (chunk) => process.stdout.write(chunk),
  );
  process.stdout.write("\n");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
