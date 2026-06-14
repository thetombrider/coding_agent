#!/usr/bin/env node

import "dotenv/config";

import { runLoop, lastAssistantText } from "./agent/loop.js";
import { defaultMainModel } from "./provider/openrouter.js";
import { createStatefulFauxProvider, fauxOneShot, runOneShot } from "./provider/faux.js";
import { streamAssistant } from "./provider/stream.js";
import { getCoreTools } from "./tools/registry.js";
import type { StreamAssistantFn } from "./provider/types.js";
import type { AgentContext } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const promptParts = args.filter((a) => !a.startsWith("--"));
  const prompt = promptParts.join(" ").trim();

  if (!prompt) {
    console.error("Usage: minicoder [--faux] [--agent] [--auto-accept] <prompt>");
    process.exit(1);
  }

  const useFaux = flags.has("--faux");
  const agentMode = flags.has("--agent") || useFaux;
  const autoAccept = flags.has("--auto-accept") || useFaux;

  if (agentMode) {
    await runAgent({ prompt, useFaux, autoAccept });
    return;
  }

  await runOneShotMode({ prompt, useFaux });
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

async function runAgent(opts: {
  prompt: string;
  useFaux: boolean;
  autoAccept: boolean;
}): Promise<void> {
  const cwd = process.cwd();
  const ctx: AgentContext = {
    cwd,
    messages: [{ role: "user", content: [{ type: "text", text: opts.prompt }] }],
  };

  let provider: StreamAssistantFn;
  let model: string;

  if (opts.useFaux) {
    provider = createStatefulFauxProvider([
      {
        toolCalls: [{ id: "tc1", name: "read", arguments: { path: "package.json" } }],
      },
      { text: ["package.json lists 2 runtime dependencies (ai, zod)."] },
    ]);
    model = "faux:test";
  } else {
    if (!process.env.OPENROUTER_API_KEY) {
      console.error("OPENROUTER_API_KEY is not set. Use --faux --agent for offline demo.");
      process.exit(1);
    }
    provider = streamAssistant;
    model = defaultMainModel();
  }

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
    system: "You are a coding agent. Use read to inspect files. Answer concisely.",
    autoAccept: opts.autoAccept,
  });

  const answer = lastAssistantText(ctx);
  if (answer && !answer.endsWith("\n")) process.stdout.write("\n");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
