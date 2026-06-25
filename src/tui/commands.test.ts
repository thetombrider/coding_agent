import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processCommand, isActionableCommandResult, type CommandContext } from "./commands.js";
import type { ProviderSummary } from "../provider/registry.js";

// Isolate config reads from the developer's real ~/.orin/config.json so
// hasE2BApiKey()/loadConfig() see an empty config rather than saved keys or
// last-used provider models.
let configHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  configHome = mkdtempSync(join(tmpdir(), "orin-commands-test-"));
  process.env.HOME = configHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(configHome, { recursive: true, force: true });
});

const ctx: CommandContext = {
  currentModel: "anthropic/claude-sonnet-4",
  currentMode: "normal",
  knownModels: ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4", "openai/gpt-4o"],
  currentProvider: "openrouter",
  modelPricing: {
    "anthropic/claude-opus-4": { inputPerM: 15, outputPerM: 75 },
    "anthropic/claude-sonnet-4": { inputPerM: 3, outputPerM: 15 },
  },
};

const providers: ProviderSummary[] = [
  { id: "openrouter", displayName: "OpenRouter", authStrategy: "api-key", active: true, configured: true },
  { id: "anthropic", displayName: "Anthropic", authStrategy: "api-key", active: false, configured: false },
  { id: "regolo", displayName: "Regolo", authStrategy: "api-key", active: false, configured: false },
];

const provCtx: CommandContext = {
  ...ctx,
  currentProvider: "openrouter",
  providers,
  providerConfigFields: (id) =>
    id === "openrouter"
      ? [{ key: "apiKey", label: "OpenRouter API key", secret: true }]
      : id === "regolo"
        ? [{ key: "apiKey", label: "Regolo AI API key", secret: true }]
        : id === "anthropic"
          ? [{ key: "apiKey", label: "Anthropic API key", secret: true }]
          : [],
};

describe("processCommand", () => {
  it("treats bare / as non-actionable so the palette can handle Enter", () => {
    const r = processCommand("/", provCtx);
    expect(r.type).toBe("error");
    expect(isActionableCommandResult(r)).toBe(false);
  });

  it("treats non-slash input as a normal turn", () => {
    expect(processCommand("hello world", ctx)).toEqual({ type: "not-command" });
  });

  it("handles /exit and /quit", () => {
    expect(processCommand("/exit", ctx).type).toBe("exit");
    expect(processCommand("/quit", ctx).type).toBe("exit");
  });

  it("handles /clear", () => {
    expect(processCommand("/clear", ctx).type).toBe("clear");
  });

  it("handles /new", () => {
    expect(processCommand("/new", ctx).type).toBe("new");
  });

  it("handles /sessions", () => {
    expect(processCommand("/sessions", ctx).type).toBe("sessions");
  });

  it("handles /checkpoints", () => {
    const r = processCommand("/checkpoints", ctx);
    expect(r.type).toBe("checkpoints");
    expect(isActionableCommandResult(r)).toBe(true);
  });

  it("handles /restore with and without an id", () => {
    expect(processCommand("/restore", ctx)).toEqual({ type: "restore", id: undefined });
    expect(processCommand("/restore abc123", ctx)).toEqual({ type: "restore", id: "abc123" });
    expect(processCommand("/undo", ctx)).toEqual({ type: "restore", id: undefined });
    expect(isActionableCommandResult({ type: "restore" })).toBe(true);
  });

  it("reports unknown commands", () => {
    const r = processCommand("/bogus", ctx);
    expect(r.type).toBe("error");
  });

  describe("/mode", () => {
    it("cycles when given no argument", () => {
      const r = processCommand("/mode", ctx);
      expect(r).toMatchObject({ type: "set-mode", mode: "auto-accept" });
    });

    it("wraps the cycle from plan back to normal", () => {
      const r = processCommand("/mode", { ...ctx, currentMode: "plan" });
      expect(r).toMatchObject({ type: "set-mode", mode: "normal" });
    });

    it("sets a named mode, including the 'allow all' alias", () => {
      expect(processCommand("/mode plan", ctx)).toMatchObject({ type: "set-mode", mode: "plan" });
      expect(processCommand("/mode allow all", ctx)).toMatchObject({
        type: "set-mode",
        mode: "auto-accept",
      });
    });

    it("is a no-op info when already in that mode", () => {
      expect(processCommand("/mode normal", ctx).type).toBe("info");
    });

    it("errors on an unknown mode name", () => {
      expect(processCommand("/mode turbo", ctx).type).toBe("error");
    });
  });

  describe("/model", () => {
    it("lists models when given no argument", () => {
      const r = processCommand("/model", ctx);
      expect(r.type).toBe("info");
      if (r.type === "info") {
        expect(r.message).toContain("openai/gpt-4o");
        expect(r.message).toContain("in $3.00 · out $15.00/M");
        expect(r.message).toContain("—");
      }
    });

    it("sets a model by explicit id", () => {
      expect(processCommand("/model openai/gpt-4o", ctx)).toMatchObject({
        type: "set-model",
        model: "openai/gpt-4o",
      });
    });

    it("sets a model by numeric index", () => {
      expect(processCommand("/model 1", ctx)).toMatchObject({
        type: "set-model",
        model: "anthropic/claude-opus-4",
      });
    });

    it("errors on an out-of-range index", () => {
      expect(processCommand("/model 99", ctx).type).toBe("error");
    });

    it("is a no-op info when already using the model", () => {
      expect(processCommand("/model anthropic/claude-sonnet-4", ctx).type).toBe("info");
    });
  });

  describe("/providers", () => {
    it("lists providers when given no argument", () => {
      const r = processCommand("/providers", provCtx);
      expect(r.type).toBe("info");
      if (r.type === "info") {
        expect(r.message).toContain("openrouter");
        expect(r.message).toContain("anthropic");
        expect(r.message).toContain("needs setup");
      }
    });

    it("accepts the /provider alias", () => {
      expect(processCommand("/provider", provCtx).type).toBe("info");
    });

    it("switches by explicit id when configured", () => {
      expect(processCommand("/providers regolo", {
        ...provCtx,
        providers: [{ ...providers[2]!, configured: true }],
      })).toMatchObject({
        type: "set-provider",
        provider: "regolo",
      });
    });

    it("switches unconfigured anthropic with configure hint", () => {
      expect(processCommand("/providers anthropic", provCtx)).toMatchObject({
        type: "set-provider",
        provider: "anthropic",
      });
      const r = processCommand("/providers anthropic", provCtx);
      if (r.type === "set-provider") {
        expect(r.message).toMatch(/\/providers configure anthropic/);
      }
    });

    it("switches configured anthropic by explicit id", () => {
      expect(processCommand("/providers anthropic", {
        ...provCtx,
        providers: [{ ...providers[1]!, configured: true }],
      })).toMatchObject({
        type: "set-provider",
        provider: "anthropic",
      });
    });

    it("switches by numeric index", () => {
      expect(processCommand("/providers 2", provCtx)).toMatchObject({
        type: "set-provider",
        provider: "anthropic",
      });
    });

    it("is a no-op info when already active", () => {
      expect(processCommand("/providers openrouter", provCtx).type).toBe("info");
    });

    it("errors on an unknown provider", () => {
      expect(processCommand("/providers bogus", provCtx).type).toBe("error");
    });

    it("errors on an out-of-range index", () => {
      expect(processCommand("/providers 99", provCtx).type).toBe("error");
    });

    it("lists providers for configure with no argument", () => {
      const r = processCommand("/providers configure", provCtx);
      expect(r.type).toBe("info");
      if (r.type === "info") {
        expect(r.message).toContain("configure a provider");
        expect(r.message).toContain("openrouter");
      }
    });

    it("starts configure flow for an api-key provider", () => {
      expect(processCommand("/providers configure openrouter", provCtx)).toMatchObject({
        type: "configure-provider",
        provider: "openrouter",
        activateOnComplete: false,
      });
    });

    it("starts configure flow by numeric index", () => {
      expect(processCommand("/providers configure 1", provCtx)).toMatchObject({
        type: "configure-provider",
        provider: "openrouter",
      });
    });

    it("starts configure flow for anthropic api key", () => {
      expect(processCommand("/providers configure anthropic", provCtx)).toMatchObject({
        type: "configure-provider",
        provider: "anthropic",
      });
    });

    it("points unconfigured api-key switches at /providers configure", () => {
      const r = processCommand("/providers regolo", provCtx);
      if (r.type === "set-provider") expect(r.message).toMatch(/\/providers configure regolo/);
    });

    it("starts configure flow for regolo", () => {
      expect(processCommand("/providers configure regolo", provCtx)).toMatchObject({
        type: "configure-provider",
        provider: "regolo",
        activateOnComplete: false,
      });
    });

    it("rejects removed oauth subcommand", () => {
      expect(processCommand("/providers oauth anthropic", provCtx).type).toBe("error");
    });

    it("auto-swaps model when moving to regolo with an OpenRouter-style model id", () => {
      const r = processCommand("/providers regolo", {
        ...provCtx,
        providers: [{ ...providers[2]!, configured: true }],
      });
      expect(r).toMatchObject({
        type: "set-provider",
        provider: "regolo",
        model: "Llama-3.3-70B-Instruct",
      });
      if (r.type === "set-provider") {
        expect(r.message).toMatch(/model → Llama-3\.3-70B-Instruct/);
      }
    });
  });

  it("rejects /sandbox as an unknown command", () => {
    const r = processCommand("/sandbox", ctx);
    expect(r.type).toBe("error");
    if (r.type === "error") {
      expect(r.message).toMatch(/unknown command/);
    }
  });

  describe("/settings", () => {
    it("starts E2B configure flow when no key is set", () => {
      const r = processCommand("/settings e2b", ctx);
      expect(r).toMatchObject({ type: "configure-e2b" });
      expect(isActionableCommandResult(r)).toBe(true);
    });

    it("starts Exa configure flow when no key is set", () => {
      const r = processCommand("/settings exa", ctx);
      expect(r).toMatchObject({ type: "configure-exa" });
      expect(isActionableCommandResult(r)).toBe(true);
    });

    it("opens the settings menu with no argument", () => {
      const r = processCommand("/settings", ctx);
      expect(r.type).toBe("open-settings");
      expect(isActionableCommandResult(r)).toBe(true);
    });

    it("rejects unknown settings", () => {
      const r = processCommand("/settings foo", ctx);
      expect(r.type).toBe("error");
    });

    it("shows the isolation floor and options", () => {
      const r = processCommand("/settings isolation", { ...ctx, currentIsolation: "worktree" });
      expect(r.type).toBe("info");
      if (r.type === "info") {
        expect(r.message).toContain("worktree");
        expect(r.message).toContain("sandbox");
      }
    });

    it("sets a new isolation floor", () => {
      const r = processCommand("/settings isolation worktree", { ...ctx, currentIsolation: "shared" });
      expect(r).toMatchObject({ type: "set-isolation", isolation: "worktree" });
      expect(isActionableCommandResult(r)).toBe(true);
    });

    it("no-ops when the isolation floor is unchanged", () => {
      const r = processCommand("/settings isolation shared", { ...ctx, currentIsolation: "shared" });
      expect(r.type).toBe("info");
    });

    it("rejects an unknown isolation mode", () => {
      const r = processCommand("/settings isolation vm", ctx);
      expect(r.type).toBe("error");
    });

    it("sets session isolation", () => {
      const r = processCommand("/settings session-isolation worktree", {
        ...ctx,
        currentSessionIsolation: "shared",
      });
      expect(r).toMatchObject({ type: "set-session-isolation", isolation: "worktree" });
    });

    it("shows the telemetry capture state with no argument", () => {
      const r = processCommand("/settings telemetry", { ...ctx, currentCaptureContent: false });
      expect(r.type).toBe("info");
      if (r.type === "info") expect(r.message).toContain("off");
    });

    it("turns telemetry content capture on", () => {
      const r = processCommand("/settings telemetry on", { ...ctx, currentCaptureContent: false });
      expect(r).toMatchObject({ type: "set-telemetry-capture", enabled: true });
      expect(isActionableCommandResult(r)).toBe(true);
    });

    it("turns telemetry content capture off (accepts aliases)", () => {
      const r = processCommand("/settings telemetry false", { ...ctx, currentCaptureContent: true });
      expect(r).toMatchObject({ type: "set-telemetry-capture", enabled: false });
    });

    it("no-ops when the telemetry capture state is unchanged", () => {
      const r = processCommand("/settings telemetry on", { ...ctx, currentCaptureContent: true });
      expect(r.type).toBe("info");
    });

    it("rejects an unknown telemetry value", () => {
      const r = processCommand("/settings telemetry maybe", ctx);
      expect(r.type).toBe("error");
    });
  });
});
