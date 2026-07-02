import { describe, expect, it } from "vitest";
import {
  applyWizardStep,
  beginAddWizard,
  beginEditWizard,
  currentWizardStep,
  validateWizardStep,
  wizardComplete,
  wizardNeedsOAuthAfterSave,
  wizardToServerConfig,
} from "./wizard.js";

describe("MCP wizard", () => {
  it("walks through add stdio server steps", () => {
    let state = beginAddWizard();

    let step = currentWizardStep(state)!;
    expect(step.id).toBe("name");
    expect(validateWizardStep(state, step, "fs")).toBeNull();
    state = applyWizardStep(state, step, "fs");

    step = currentWizardStep(state)!;
    expect(step.id).toBe("transport");
    state = applyWizardStep(state, step, "stdio");

    step = currentWizardStep(state)!;
    expect(step.id).toBe("command");
    state = applyWizardStep(state, step, "npx");

    step = currentWizardStep(state)!;
    expect(step.id).toBe("args");
    state = applyWizardStep(state, step, "-y @modelcontextprotocol/server-filesystem .");

    expect(wizardComplete(state)).toBe(true);
    expect(wizardToServerConfig(state)).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    });
  });

  it("prefills edit wizard from existing http bearer config", () => {
    const state = beginEditWizard("github", {
      type: "http",
      url: "https://mcp.example.com/github",
      headers: { Authorization: "Bearer secret" },
    });
    expect(state.transport).toBe("http");
    expect(state.url).toBe("https://mcp.example.com/github");
    expect(state.authMode).toBe("bearer");
    expect(state.token).toBe("Bearer secret");
    expect(currentWizardStep(state)?.id).toBe("transport");
  });

  it("stores bearer token as Authorization header", () => {
    let state = beginAddWizard();
    for (const [stepId, value] of [
      ["name", "github"],
      ["transport", "http"],
      ["url", "https://api.githubcopilot.com/mcp/"],
      ["authMode", "bearer"],
      ["token", "ghp_test"],
    ] as const) {
      const step = currentWizardStep(state)!;
      expect(step.id).toBe(stepId);
      state = applyWizardStep(state, step, value);
    }
    expect(wizardToServerConfig(state)).toEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ghp_test" },
    });
  });

  it("stores oauth config from wizard", () => {
    let state = beginAddWizard();
    for (const [stepId, value] of [
      ["name", "context7"],
      ["transport", "http"],
      ["url", "https://mcp.context7.com/mcp/oauth"],
      ["authMode", "oauth"],
      ["oauthClientId", ""],
      ["oauthClientSecret", ""],
      ["oauthScopes", ""],
    ] as const) {
      const step = currentWizardStep(state)!;
      expect(step.id).toBe(stepId);
      state = applyWizardStep(state, step, value);
    }
    expect(wizardToServerConfig(state)).toEqual({
      type: "http",
      url: "https://mcp.context7.com/mcp/oauth",
      oauth: true,
    });
    expect(wizardNeedsOAuthAfterSave(state)).toBe(true);
  });

  it("prefills oauth fields when editing", () => {
    const state = beginEditWizard("ctx", {
      type: "http",
      url: "https://example.com/mcp",
      oauth: { clientId: "cid", scopes: ["read", "write"] },
    });
    expect(state.authMode).toBe("oauth");
    expect(state.oauthClientId).toBe("cid");
    expect(state.oauthScopes).toBe("read write");
  });

  it("rejects invalid server names", () => {
    const state = beginAddWizard();
    const step = currentWizardStep(state)!;
    expect(validateWizardStep(state, step, "bad name")).toMatch(/name must/);
  });

  it("exposes select options for transport and authMode steps", () => {
    let state = beginAddWizard();
    state = applyWizardStep(state, currentWizardStep(state)!, "fs");

    const transportStep = currentWizardStep(state)!;
    expect(transportStep.id).toBe("transport");
    expect(transportStep.options).toEqual(["stdio", "http", "ws"]);

    state = applyWizardStep(state, transportStep, "http");
    state = applyWizardStep(state, currentWizardStep(state)!, "https://mcp.example.com");

    const authStep = currentWizardStep(state)!;
    expect(authStep.id).toBe("authMode");
    expect(authStep.options).toEqual(["none", "bearer", "oauth"]);
  });

  it("hints that ${env:VAR} is supported in the token step", () => {
    let state = beginAddWizard();
    for (const [stepId, value] of [
      ["name", "github"],
      ["transport", "http"],
      ["url", "https://api.githubcopilot.com/mcp/"],
      ["authMode", "bearer"],
    ] as const) {
      const step = currentWizardStep(state)!;
      expect(step.id).toBe(stepId);
      state = applyWizardStep(state, step, value);
    }
    const tokenStep = currentWizardStep(state)!;
    expect(tokenStep.id).toBe("token");
    expect(tokenStep.hint).toMatch(/\$\{env:VAR\}/);
  });
});
