import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { SessionController, SessionState, Turn } from "./controller.js";
import { hiddenNativeScrollbar, scrollbars, theme } from "./theme.js";
import { ScrollRail } from "./scroll-rail.js";
import { useSpinnerClock } from "./spinner.js";
import { StartupLogo } from "./logo.js";
import { ApprovalBar, Header, TodoSidebar, TurnView } from "./views.js";
import { ToolExpandProvider, createToolExpandState } from "./tool-expand.js";
import { copyToClipboard, formatCopyStatus, formatPasteStatus, readFromClipboard } from "./clipboard.js";
import { pickFocusedCopyText, sessionToPlainText } from "./plaintext.js";
import {
  isCopyAllShortcut,
  isCopyBlockShortcut,
  isInterruptShortcut,
  isPasteShortcut,
  isPlainSelectionCopyShortcut,
  isSelectionCopyShortcut,
  isSelectionHintShortcut,
} from "./shortcuts.js";
import { readRendererSelection } from "./selection.js";
import { selectionCopyHint } from "./terminal-env.js";
import { KEYBOARD_HINTS, processCommand, type CommandResult } from "./commands.js";
import { APPROVAL_MODES, APPROVAL_MODE_LABELS, coerceApprovalMode, type ApprovalMode } from "../approval/policy.js";
import { pickerModelsForProvider } from "../config/models.js";
import { loadPickerModels, resolveModelOnProviderSwitch } from "../provider/picker-models.js";
import {
  defaultProviderAuthIndex,
  providerAuthPaths,
  shouldOpenProviderAuthMenu,
  type ProviderAuthPath,
} from "../provider/auth-paths.js";
import { activeProviderId, providerConfigFields, providerSummaries, type ProviderSummary } from "../provider/registry.js";
import type { ProviderConfigField } from "../provider/types.js";
import {
  ANTHROPIC_OAUTH_POLICY_NOTE,
  beginAnthropicOAuth,
  completeAnthropicOAuthPaste,
  exchangeAnthropicOAuthCode,
  openBrowser,
  storeAnthropicOAuthTokens,
  type AnthropicOAuthSession,
} from "../provider/oauth/anthropic-oauth.js";
import type { SessionSummary } from "../session/log.js";
import type { SessionsPaletteState } from "./sessions-palette.js";
import { selectedSession, sessionsPaletteAfterDelete, sessionsPaletteHint } from "./sessions-palette.js";

const BOLD = createTextAttributes({ bold: true });
const SESSION_LIST_MAX_VISIBLE = 10;

const SLASH_COMMANDS = [
  { name: "model",     label: "/model",     description: "switch model" },
  { name: "mode",      label: "/mode",      description: "set approval mode" },
  { name: "providers", label: "/providers", description: "switch LLM provider" },
  { name: "sessions",  label: "/sessions",  description: "browse sessions" },
  { name: "new",       label: "/new",       description: "archive & start new session" },
  { name: "clear",     label: "/clear",     description: "clear conversation" },
  { name: "help",      label: "/help",      description: "show help" },
  { name: "exit",      label: "/exit",      description: "quit" },
] as const;

type CommandName = (typeof SLASH_COMMANDS)[number]["name"];

type PaletteState =
  | { phase: "commands"; index: number }
  | { phase: "model"; index: number }
  | { phase: "mode"; index: number }
  | { phase: "providers"; index: number; providers: ProviderSummary[] }
  | {
      phase: "provider-auth";
      index: number;
      providerId: string;
      displayName: string;
      paths: ProviderAuthPath[];
      activateOnComplete: boolean;
      providers: ProviderSummary[];
      providersIndex: number;
    }
  | SessionsPaletteState;

type ConfigPromptState = {
  providerId: string;
  displayName: string;
  fields: readonly ProviderConfigField[];
  fieldIndex: number;
  values: Record<string, string>;
  activateOnComplete: boolean;
};

type OAuthPromptState =
  | { phase: "confirm"; providerId: string; activateOnComplete: boolean }
  | { phase: "paste"; providerId: string; session: AnthropicOAuthSession; activateOnComplete: boolean };

function providerAuthLabel(strategy: ProviderSummary["authStrategy"]): string {
  if (strategy === "oauth") return " [oauth]";
  if (strategy === "api-key-or-oauth") return " [api-key|oauth]";
  return "";
}

function formatSessionDate(ts: string): string {
  try {
    const d = new Date(ts);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day} ${hour}:${min}`;
  } catch {
    return ts;
  }
}

function currentTurn(state: SessionState): Turn | null {
  if (
    !state.currentUserText
    && !state.streamingText
    && !state.streamingReasoning
    && state.currentTools.length === 0
  ) {
    return null;
  }
  return {
    userText: state.currentUserText,
    assistantText: state.streamingText,
    reasoningText: state.streamingReasoning || undefined,
    tools: state.currentTools,
  };
}

export function App(props: {
  controller: SessionController;
  onSubmit: (text: string) => void | Promise<void>;
  onExit: () => void;
  onSetModel: (model: string) => void;
  onSetMode: (mode: ApprovalMode) => void;
  onSetProvider: (provider: string, model?: string) => void;
  onConfigureProvider: (
    provider: string,
    values: Record<string, string>,
    activate: boolean,
    preferredAuth?: "api-key" | "oauth",
  ) => void;
  onSetProviderAuthPreference: (provider: string, preferredAuth: "api-key" | "oauth") => void;
  onClear: () => void;
  onNew: () => void;
  onResume: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => { ok: boolean; message: string };
  onListSessions: () => SessionSummary[];
  activeSessionId: string;
}) {
  const [state, setState] = createSignal(props.controller.getState());
  const [submitting, setSubmitting] = createSignal(false);
  const [palette, setPalette] = createSignal<PaletteState | null>(null);
  const [configPrompt, setConfigPrompt] = createSignal<ConfigPromptState | null>(null);
  const [oauthPrompt, setOauthPrompt] = createSignal<OAuthPromptState | null>(null);
  const [oauthRunning, setOauthRunning] = createSignal(false);
  const toolExpand = createToolExpandState();
  const renderer = useRenderer();
  onCleanup(props.controller.subscribe(setState));
  useSpinnerClock();

  const copyShortcutsEnabled = () =>
    state().phase === "input"
    && palette() === null
    && configPrompt() === null
    && !submitting();

  const pasteShortcutEnabled = () =>
    state().phase !== "approval"
    && palette() === null
    && !submitting();

  const performCopy = async (text: string | null | undefined) => {
    if (!text) {
      props.controller.setStatusHint("Nothing to copy — see ~/.orin/sessions/*.jsonl");
      return;
    }
    const result = await copyToClipboard(text, {
      osc52Copy: renderer.isOsc52Supported()
        ? (payload) => renderer.copyToClipboardOSC52(payload)
        : undefined,
    });
    props.controller.setStatusHint(formatCopyStatus(result));
  };

  const copyFocusedBlock = () => {
    const selected = readRendererSelection(renderer);
    if (selected) return performCopy(selected);
    return performCopy(pickFocusedCopyText(state(), toolExpand.getHoveredOutput()));
  };

  const copyConversation = () => performCopy(sessionToPlainText(state()));

  const performPaste = async () => {
    const result = await readFromClipboard();
    if (!result.ok || !result.text) {
      props.controller.setStatusHint(formatPasteStatus(result, 0));
      return;
    }
    const text = result.text.replace(/\r?\n/g, " ");
    if (inputRef) {
      inputRef.insertText(text);
      handleInput(inputRef.value);
    } else {
      props.controller.setInput(state().input + text);
    }
    props.controller.setStatusHint(formatPasteStatus(result, text.length));
  };

  const [scrollRailRevision, setScrollRailRevision] = createSignal(0);
  const bumpScrollRail = () => setScrollRailRevision((n) => n + 1);

  createEffect(() => {
    completed();
    live();
    queueMicrotask(bumpScrollRail);
  });

  let scrollRef: ScrollBoxRenderable | undefined;
  let sessionListScrollRef: ScrollBoxRenderable | undefined;
  let inputRef: InputRenderable | undefined;

  const scrollSessionIntoView = (index: number) => {
    sessionListScrollRef?.scrollChildIntoView(`session-row-${index}`);
  };

  createEffect(() => {
    const p = palette();
    if (p?.phase !== "sessions" || p.menu !== "list") return;
    const index = p.index;
    queueMicrotask(() => scrollSessionIntoView(index));
  });

  const live = () => currentTurn(state());
  const completed = () => state().completedTurns;
  const hasContent = () => completed().length > 0 || live() !== null;

  const [pickerModelList, setPickerModelList] = createSignal<string[]>([
    ...pickerModelsForProvider(activeProviderId()),
  ]);

  createEffect(() => {
    const providerId = state().meta.provider ?? activeProviderId();
    setPickerModelList([...pickerModelsForProvider(providerId)]);
    void loadPickerModels(providerId).then((models) => {
      if ((state().meta.provider ?? activeProviderId()) === providerId) {
        setPickerModelList(models);
      }
    });
  });

  const pickerModels = () => pickerModelList();

  const filteredCommands = () => {
    const input = state().input;
    if (!input.startsWith("/")) return [...SLASH_COMMANDS];
    const filter = input.slice(1).toLowerCase();
    if (!filter) return [...SLASH_COMMANDS];
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(filter));
  };

  const closeOAuthPrompt = () => {
    const prompt = oauthPrompt();
    prompt?.phase === "paste" && prompt.session.loopback?.close();
    setOauthPrompt(null);
    setOauthRunning(false);
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
  };

  const commandContext = () => {
    const meta = state().meta;
    return {
      currentModel: meta.model,
      currentMode: coerceApprovalMode(meta.approval) ?? "normal",
      knownModels: pickerModels(),
      currentProvider: meta.provider ?? activeProviderId(),
      providers: providerSummaries(),
      providerConfigFields,
    };
  };

  const switchToProvider = (providerId: string, notePrefix = "") => {
    const { model, note } = resolveModelOnProviderSwitch(
      state().meta.provider ?? activeProviderId(),
      providerId,
      state().meta.model,
    );
    props.onSetProvider(providerId, model);
    props.controller.setStatusHint(`${notePrefix}provider → ${providerId}${note}`);
  };

  const finishOAuthSetup = (providerId: string, activateOnComplete: boolean) => {
    props.onSetProviderAuthPreference(providerId, "oauth");
    closeOAuthPrompt();
    if (activateOnComplete) {
      switchToProvider(providerId, "Anthropic OAuth configured · ");
    } else {
      props.controller.setStatusHint("Anthropic OAuth configured — tokens saved to ~/.orin/tokens.json");
    }
  };

  const openProviderAuthPalette = (
    provider: ProviderSummary,
    activateOnComplete: boolean,
    providers: ProviderSummary[],
    providersIndex: number,
  ) => {
    const paths = provider.authPaths ?? providerAuthPaths(provider.id) ?? [];
    setPalette({
      phase: "provider-auth",
      index: defaultProviderAuthIndex(paths),
      providerId: provider.id,
      displayName: provider.displayName,
      paths,
      activateOnComplete,
      providers,
      providersIndex,
    });
    props.controller.setStatusHint(`${provider.displayName}: choose API key or OAuth · ↑↓ Enter · Esc back`);
  };

  const beginOAuthFlow = (providerId: string, activateOnComplete: boolean) => {
    setOauthPrompt({ phase: "confirm", providerId, activateOnComplete });
    props.controller.setStatusHint(
      `${ANTHROPIC_OAUTH_POLICY_NOTE} Type "yes" to continue · Esc to cancel`,
    );
  };

  const runAnthropicOAuth = async (providerId: string, activateOnComplete: boolean) => {
    if (providerId !== "anthropic") {
      props.controller.setStatusHint(`OAuth is not available for ${providerId}`);
      closeOAuthPrompt();
      return;
    }

    setOauthRunning(true);
    props.controller.setStatusHint("Starting OAuth — opening browser…");

    try {
      const session = await beginAnthropicOAuth("loopback");
      openBrowser(session.authorizeUrl);
      props.controller.setStatusHint("Complete sign-in in your browser (loopback)…");
      const callback = await session.loopback!.waitForCallback(120_000);
      const tokens = await exchangeAnthropicOAuthCode(
        callback.code,
        session.verifier,
        session.redirectUri,
        callback.state,
      );
      storeAnthropicOAuthTokens(tokens);
      session.loopback!.close();
      finishOAuthSetup(providerId, activateOnComplete);
    } catch {
      try {
        const session = await beginAnthropicOAuth("manual");
        setOauthPrompt({ phase: "paste", providerId, session, activateOnComplete });
        openBrowser(session.authorizeUrl);
        props.controller.setStatusHint(
          "Loopback unavailable — paste authorization code (code or code#state) · Esc to cancel",
        );
      } catch (err) {
        closeOAuthPrompt();
        const message = err instanceof Error ? err.message : String(err);
        props.controller.setStatusHint(`OAuth failed: ${message}`);
      }
    } finally {
      setOauthRunning(false);
    }
  };

  const handleOAuthSubmit = async (raw: string) => {
    const prompt = oauthPrompt();
    if (!prompt) return;

    const trimmed = raw.trim();
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();

    if (prompt.phase === "confirm") {
      if (trimmed.toLowerCase() !== "yes") {
        props.controller.setStatusHint('Type "yes" to accept the policy and continue, or Esc to cancel');
        return;
      }
      void runAnthropicOAuth(prompt.providerId, prompt.activateOnComplete);
      return;
    }

    if (!trimmed) {
      props.controller.setStatusHint("authorization code required — Esc to cancel");
      return;
    }

    setOauthRunning(true);
    try {
      const tokens = await completeAnthropicOAuthPaste(prompt.session, trimmed);
      storeAnthropicOAuthTokens(tokens);
      prompt.session.loopback?.close();
      finishOAuthSetup(prompt.providerId, prompt.activateOnComplete);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      props.controller.setStatusHint(`OAuth failed: ${message} — try again or Esc to cancel`);
    } finally {
      setOauthRunning(false);
    }
  };

  const closeConfigPrompt = () => {
    setConfigPrompt(null);
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
  };

  const configFieldHint = (prompt: ConfigPromptState): string => {
    const field = prompt.fields[prompt.fieldIndex];
    if (!field) return "";
    const env = field.envVar ? ` (or set ${field.envVar})` : "";
    return `Configure ${prompt.displayName}: enter ${field.label}${env} · Esc to cancel`;
  };

  const beginConfigPrompt = (opts: {
    providerId: string;
    displayName: string;
    fields: readonly ProviderConfigField[];
    activateOnComplete: boolean;
  }) => {
    setConfigPrompt({
      providerId: opts.providerId,
      displayName: opts.displayName,
      fields: opts.fields,
      fieldIndex: 0,
      values: {},
      activateOnComplete: opts.activateOnComplete,
    });
    props.controller.setStatusHint(
      `Configure ${opts.displayName}: enter ${opts.fields[0]?.label ?? "value"}`
      + (opts.fields[0]?.envVar ? ` (or set ${opts.fields[0].envVar})` : "")
      + " · Esc to cancel",
    );
  };

  const handleConfigSubmit = (raw: string) => {
    const prompt = configPrompt();
    if (!prompt) return;

    const trimmed = raw.trim();
    if (!trimmed) {
      props.controller.setStatusHint("value required — Esc to cancel");
      return;
    }

    const field = prompt.fields[prompt.fieldIndex];
    if (!field) return;

    const values = { ...prompt.values, [field.key]: trimmed };
    const nextIndex = prompt.fieldIndex + 1;

    if (inputRef) inputRef.value = "";
    props.controller.clearInput();

    if (nextIndex < prompt.fields.length) {
      const next = { ...prompt, fieldIndex: nextIndex, values };
      setConfigPrompt(next);
      props.controller.setStatusHint(configFieldHint(next));
      return;
    }

    closeConfigPrompt();
    props.onConfigureProvider(
      prompt.providerId,
      values,
      prompt.activateOnComplete,
      "api-key",
    );
  };

  const closePalette = () => {
    setPalette(null);
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
  };

  const openSessionsPalette = (state: SessionsPaletteState) => {
    setPalette(state);
  };

  const confirmSessionDelete = () => {
    const p = palette();
    if (p?.phase !== "sessions" || p.menu !== "delete") return;

    const session = selectedSession(p);
    if (!session) return;

    const result = props.onDeleteSession(session.sessionId);
    props.controller.setStatusHint(result.message);
    if (!result.ok) {
      setPalette({ ...p, menu: "list" });
      return;
    }

    const next = sessionsPaletteAfterDelete(props.onListSessions(), p.index);
    if (!next) {
      closePalette();
      return;
    }

    openSessionsPalette(next);
  };

  const handleProviderAuthSelect = (auth: ProviderAuthPath, paletteState: Extract<PaletteState, { phase: "provider-auth" }>) => {
    setPalette(null);
    if (auth.id === "api-key") {
      if (auth.configured) {
        props.onSetProviderAuthPreference(paletteState.providerId, "api-key");
        if (paletteState.activateOnComplete) {
          switchToProvider(paletteState.providerId, "Using API key · ");
        } else {
          props.controller.setStatusHint("Anthropic API key is active — run /providers configure anthropic to update");
        }
        return;
      }
      const fields = providerConfigFields(paletteState.providerId);
      if (!fields.length) {
        props.controller.setStatusHint(`${paletteState.displayName} has no API key fields`);
        return;
      }
      beginConfigPrompt({
        providerId: paletteState.providerId,
        displayName: paletteState.displayName,
        fields,
        activateOnComplete: paletteState.activateOnComplete,
      });
      return;
    }

    if (auth.configured) {
      props.onSetProviderAuthPreference(paletteState.providerId, "oauth");
      if (paletteState.activateOnComplete) {
        switchToProvider(paletteState.providerId, "Using OAuth · ");
      } else {
        props.controller.setStatusHint("Anthropic OAuth is active — re-authenticate from this menu to refresh");
      }
      return;
    }
    beginOAuthFlow(paletteState.providerId, paletteState.activateOnComplete);
  };

  const applyCommandResult = (result: CommandResult) => {
    switch (result.type) {
      case "exit":
        props.onExit();
        return;
      case "clear":
        props.onClear();
        props.controller.clearHistory();
        props.controller.setTodos([]);
        return;
      case "new":
        props.onNew();
        return;
      case "sessions": {
        const sessions = props.onListSessions();
        if (sessions.length === 0) {
          props.controller.setStatusHint("No sessions found.");
          return;
        }
        setPalette({ phase: "sessions", index: 0, sessions, menu: "list" });
        return;
      }
      case "set-model":
        props.onSetModel(result.model);
        props.controller.setStatusHint(result.message);
        return;
      case "set-mode":
        props.onSetMode(result.mode);
        props.controller.setStatusHint(result.message);
        return;
      case "set-provider":
        props.onSetProvider(result.provider, result.model);
        props.controller.setStatusHint(result.message);
        return;
      case "configure-provider":
        beginConfigPrompt({
          providerId: result.provider,
          displayName:
            providerSummaries().find((p) => p.id === result.provider)?.displayName ?? result.provider,
          fields: result.fields,
          activateOnComplete: result.activateOnComplete,
        });
        return;
      case "start-oauth":
        beginOAuthFlow(result.provider, result.activateOnComplete ?? false);
        return;
      case "open-provider-auth": {
        const providers = providerSummaries();
        const idx = providers.findIndex((p) => p.id === result.provider);
        const provider = providers[idx];
        if (!provider) {
          props.controller.setStatusHint(`unknown provider "${result.provider}"`);
          return;
        }
        openProviderAuthPalette(provider, result.activateOnComplete, providers, Math.max(0, idx));
        return;
      }
      case "info":
      case "error":
        props.controller.setStatusHint(result.message);
        return;
      case "not-command":
        break;
    }
  };

  const handlePaletteSelect = () => {
    const p = palette();
    if (!p) return;

    // Don't act on palette selections (model/mode/provider/session switches)
    // while a turn is running — close the palette instead.
    if (submitting() || state().phase !== "input") {
      setPalette(null);
      return;
    }

    if (p.phase === "commands") {
      const cmds = filteredCommands();
      const cmd = cmds[p.index];
      if (!cmd) return;

      const name = cmd.name as CommandName;

      if (name === "model") {
        const currentIdx = pickerModels().indexOf(state().meta.model);
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        setPalette({ phase: "model", index: Math.max(0, currentIdx) });
        return;
      }

      if (name === "mode") {
        const currentMode = coerceApprovalMode(state().meta.approval) ?? "normal";
        const currentIdx = APPROVAL_MODES.indexOf(currentMode);
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        setPalette({ phase: "mode", index: Math.max(0, currentIdx) });
        return;
      }

      if (name === "providers") {
        const providers = providerSummaries();
        const currentIdx = providers.findIndex((p) => p.active);
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        setPalette({ phase: "providers", index: Math.max(0, currentIdx), providers });
        return;
      }

      if (name === "sessions") {
        const sessions = props.onListSessions();
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        if (sessions.length === 0) {
          closePalette();
          props.controller.setStatusHint("No sessions found.");
          return;
        }
        setPalette({ phase: "sessions", index: 0, sessions, menu: "list" });
        return;
      }

      closePalette();

      if (name === "clear") {
        props.onClear();
        props.controller.clearHistory();
        props.controller.setTodos([]);
      } else if (name === "new") {
        props.onNew();
      } else if (name === "exit") {
        props.onExit();
      } else if (name === "help") {
        props.controller.setStatusHint(
          `${KEYBOARD_HINTS}  ·  ${SLASH_COMMANDS.map((c) => `${c.label}: ${c.description}`).join("  ·  ")}`,
        );
      }
      return;
    }

    if (p.phase === "model") {
      const model = pickerModels()[p.index];
      if (model) {
        setPalette(null);
        props.onSetModel(model);
        props.controller.setStatusHint(`model → ${model}`);
      }
      return;
    }

    if (p.phase === "mode") {
      const mode = APPROVAL_MODES[p.index];
      if (mode) {
        setPalette(null);
        props.onSetMode(mode);
        props.controller.setStatusHint(`mode → ${APPROVAL_MODE_LABELS[mode]}`);
      }
      return;
    }

    if (p.phase === "providers") {
      const provider = p.providers[p.index];
      if (!provider) return;

      if (shouldOpenProviderAuthMenu(provider)) {
        openProviderAuthPalette(provider, !provider.active, p.providers, p.index);
        return;
      }

      if (!provider.active) {
        setPalette(null);
        if (!provider.configured && provider.authStrategy === "api-key") {
          const fields = providerConfigFields(provider.id);
          if (fields.length) {
            beginConfigPrompt({
              providerId: provider.id,
              displayName: provider.displayName,
              fields,
              activateOnComplete: true,
            });
            return;
          }
        }
        switchToProvider(provider.id);
      } else {
        setPalette(null);
      }
      return;
    }

    if (p.phase === "provider-auth") {
      const auth = p.paths[p.index];
      if (auth) handleProviderAuthSelect(auth, p);
      return;
    }

    if (p.phase === "sessions") {
      if (p.menu === "delete") {
        confirmSessionDelete();
        return;
      }
      const session = p.sessions[p.index];
      if (session) {
        setPalette(null);
        props.onResume(session.sessionId);
      }
      return;
    }
  };

  const handleSubmit = async (raw: string) => {
    if (oauthPrompt() !== null) {
      await handleOAuthSubmit(raw);
      return;
    }

    // Provider config prompt takes priority over the command palette.
    if (configPrompt() !== null) {
      handleConfigSubmit(raw);
      return;
    }

    // If palette is open, Enter selects unless the input is a complete slash command.
    if (palette() !== null) {
      const text = raw.trim();
      if (text.startsWith("/")) {
        const result = processCommand(text, commandContext());
        if (result.type !== "not-command") {
          if (inputRef) inputRef.value = "";
          props.controller.clearInput();
          closePalette();
          applyCommandResult(result);
          return;
        }
      }
      handlePaletteSelect();
      return;
    }

    const text = raw.trim();
    if (inputRef) inputRef.value = "";
    if (!text) return;

    // Exit must work even while a turn is running.
    if (text === "/exit" || text === "/quit") {
      props.onExit();
      return;
    }

    // Anything else is rejected while the agent is busy.
    if (submitting() || oauthRunning() || state().phase !== "input") return;

    if (text.startsWith("/")) {
      props.controller.clearInput();
      applyCommandResult(processCommand(text, commandContext()));
      return;
    }

    props.controller.clearInput();
    setSubmitting(true);
    try {
      await props.onSubmit(text);
    } finally {
      setSubmitting(false);
    }
  };

  const handleInput = (value: string) => {
    props.controller.setInput(value);
    if (configPrompt() !== null) return;

    const p = palette();

    if (value.startsWith("/")) {
      if (p === null) {
        setPalette({ phase: "commands", index: 0 });
      } else if (p.phase === "commands") {
        // Re-clamp index after filter change
        const cmds = SLASH_COMMANDS.filter((c) => {
          const filter = value.slice(1).toLowerCase();
          return !filter || c.name.startsWith(filter);
        });
        const clamped = Math.min(p.index, Math.max(0, cmds.length - 1));
        if (clamped !== p.index) setPalette({ phase: "commands", index: clamped });
      }
    } else if (p?.phase === "commands") {
      setPalette(null);
    }
  };

  useKeyboard((key) => {
    const phase = state().phase;

    // Copy before quit — Ctrl+Shift+C must not match the Ctrl+C exit handler.
    if (isSelectionCopyShortcut(key)) {
      const selected = readRendererSelection(renderer);
      if (selected) void performCopy(selected);
      else props.controller.setStatusHint("Select text to copy");
      return;
    }

    if (isPlainSelectionCopyShortcut(key)) {
      const selected = readRendererSelection(renderer);
      if (selected) {
        void performCopy(selected);
        return;
      }
    }

    if (isInterruptShortcut(key)) {
      if (oauthPrompt() !== null) {
        closeOAuthPrompt();
        props.controller.setStatusHint("OAuth cancelled");
        return;
      }
      if (configPrompt() !== null) {
        closeConfigPrompt();
        props.controller.setStatusHint("configuration cancelled");
        return;
      }
      props.onExit();
      return;
    }

    if (phase === "approval") {
      if (key.name === "y") props.controller.respondApproval(true);
      if (key.name === "n") props.controller.respondApproval(false);
      if (key.name === "escape" && !renderer.hasSelection) props.controller.respondApproval(false);
      return;
    }

    if (oauthPrompt() !== null) {
      if (key.name === "escape") {
        closeOAuthPrompt();
        props.controller.setStatusHint("OAuth cancelled");
      }
      return;
    }

    if (configPrompt() !== null) {
      if (key.name === "escape") {
        closeConfigPrompt();
        props.controller.setStatusHint("configuration cancelled");
      }
      return;
    }

    const p = palette();
    if (p !== null) {
      if (p.phase === "sessions") {
        if (p.menu === "delete") {
          if (key.name === "left" || key.name === "escape") {
            setPalette({ ...p, menu: "list" });
            return;
          }
          // Enter is handled by the input submit path (handlePaletteSelect) only.
          // Handling it here too would delete then immediately resume on the same keypress.
          if (key.name !== undefined) return;
        } else if (key.name === "right") {
          setPalette({ ...p, menu: "delete" });
          return;
        }
      }

      if (key.name === "up") {
        setPalette({ ...p, index: Math.max(0, p.index - 1) });
        return;
      }
      if (key.name === "down") {
        const maxIdx =
          p.phase === "commands"
            ? Math.max(0, filteredCommands().length - 1)
            : p.phase === "model"
              ? Math.max(0, pickerModels().length - 1)
              : p.phase === "providers"
                ? Math.max(0, p.providers.length - 1)
                : p.phase === "provider-auth"
                  ? Math.max(0, p.paths.length - 1)
                  : p.phase === "sessions"
                    ? Math.max(0, p.sessions.length - 1)
                    : APPROVAL_MODES.length - 1;
        setPalette({ ...p, index: Math.min(maxIdx, p.index + 1) });
        return;
      }
      if (key.name === "escape") {
        if (p.phase === "sessions" && p.menu === "delete") {
          setPalette({ ...p, menu: "list" });
          return;
        }
        if (p.phase === "provider-auth") {
          setPalette({
            phase: "providers",
            index: p.providersIndex,
            providers: p.providers,
          });
          return;
        }
        if (p.phase !== "commands") {
          // Go back to command list
          setPalette({ phase: "commands", index: 0 });
        } else {
          closePalette();
        }
        return;
      }
      // Swallow all other special keys when palette is open so they don't scroll.
      if (key.name !== undefined) return;
    }

    if (!scrollRef) return;

    if (key.name === "escape" && renderer.hasSelection) {
      renderer.clearSelection();
      props.controller.setStatusHint("Selection cleared");
      return;
    }

    if (pasteShortcutEnabled() && isPasteShortcut(key)) {
      void performPaste();
      return;
    }
    if (copyShortcutsEnabled()) {
      if (isSelectionHintShortcut(key)) {
        props.controller.setStatusHint(selectionCopyHint());
        return;
      }
      if (isCopyBlockShortcut(key)) {
        void copyFocusedBlock();
        return;
      }
      if (isCopyAllShortcut(key)) {
        void copyConversation();
        return;
      }
      if (isPlainSelectionCopyShortcut(key)) {
        const expanded = toolExpand.getHoveredExpandedOutput();
        if (expanded) {
          void performCopy(expanded);
          return;
        }
      }
    }
    if (
      key.name === "o"
      && phase === "input"
      && palette() === null
      && configPrompt() === null
      && !submitting()
    ) {
      toolExpand.toggleHovered();
      return;
    }
    const page = Math.max(3, Math.floor(scrollRef.viewport.height / 2));
    switch (key.name) {
      case "up":
        scrollRef.scrollBy({ x: 0, y: -2 });
        return;
      case "down":
        scrollRef.scrollBy({ x: 0, y: 2 });
        return;
      case "pageup":
        scrollRef.scrollBy({ x: 0, y: -page });
        return;
      case "pagedown":
        scrollRef.scrollBy({ x: 0, y: page });
        return;
      case "end":
        scrollRef.scrollTo({ x: 0, y: scrollRef.scrollHeight });
        return;
    }
  });

  return (
    <ToolExpandProvider value={toolExpand}>
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexShrink={0}>
        <Header
          model={state().meta.model}
          approval={state().meta.approval}
          cwd={state().meta.cwd}
          provider={state().meta.provider}
          sandbox={state().meta.sandbox}
        />
      </box>

      <box flexDirection="row" flexGrow={1}>
        <scrollbox
          ref={scrollRef}
          flexGrow={1}
          stickyScroll
          stickyStart="bottom"
          contentOptions={{ flexDirection: "column" }}
          {...hiddenNativeScrollbar}
          on:scroll={bumpScrollRail}
        >
          <Show
            when={hasContent()}
            fallback={
              <box flexDirection="column">
                <StartupLogo />
                <text fg={theme.secondary}>Ask anything about this codebase.</text>
              </box>
            }
          >
            <For each={completed()}>
              {(turn, i) => (
                <TurnView
                  turn={turn}
                  turnKey={`turn-${i()}`}
                  first={i() === 0}
                  reasoningId={`reasoning-${i()}`}
                />
              )}
            </For>
            <Show when={live()}>
              {(turn) => (
                <TurnView
                  turn={turn()}
                  turnKey="turn-live"
                  first={completed().length === 0}
                  reasoningId="reasoning-live"
                  reasoningStreaming={state().phase === "running" && !turn().assistantText}
                />
              )}
            </Show>
          </Show>
        </scrollbox>

        <ScrollRail
          scrollRef={() => scrollRef}
          revision={scrollRailRevision()}
          trackColor={scrollbars.main.track}
          thumbColor={scrollbars.main.thumb}
        />

        <TodoSidebar todos={state().todos} phase={state().phase} />
      </box>

      <Show when={state().pendingApproval}>
        {(pending) => (
          <box flexShrink={0}>
            <ApprovalBar name={pending().name} args={pending().args} />
          </box>
        )}
      </Show>

      <box flexShrink={0} flexDirection="column" marginTop={1} paddingTop={1} border={["top"]} borderColor={theme.border}>
        <Show when={configPrompt()}>
          {(prompt) => (
            <box
              flexShrink={0}
              flexDirection="column"
              marginBottom={1}
              paddingLeft={1}
              paddingRight={1}
              borderStyle="rounded"
              border
              borderColor={theme.accent}
              backgroundColor={theme.codeBg}
            >
              <text fg={theme.accent} attributes={BOLD}>
                Provider setup — {prompt().displayName}
              </text>
              <text fg={theme.secondary}>
                {prompt().fields[prompt().fieldIndex]?.secret
                  ? "Paste your API key (saved to ~/.orin/config.json, not sent to the agent)"
                  : "Enter the value below (saved to ~/.orin/config.json)"}
              </text>
            </box>
          )}
        </Show>

        <Show when={palette()}>
          {(p) => (
            <box
              flexShrink={0}
              flexDirection="column"
              marginBottom={1}
              paddingLeft={1}
              paddingRight={1}
              paddingTop={0}
              paddingBottom={0}
              borderStyle="rounded"
              border
              borderColor={theme.border}
              backgroundColor={theme.codeBg}
            >
              <Show when={p().phase === "commands"}>
                <For each={filteredCommands()}>
                  {(cmd, i) => {
                    const selected = () => (p() as { phase: "commands"; index: number }).index === i();
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{cmd.label}
                        </text>
                        <text fg={theme.secondary}>  {cmd.description}</text>
                      </box>
                    );
                  }}
                </For>
              </Show>

              <Show when={p().phase === "model"}>
                <For each={[...pickerModels()]}>
                  {(model, i) => {
                    const selected = () => (p() as { phase: "model"; index: number }).index === i();
                    const isCurrent = () => model === state().meta.model;
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{model}
                        </text>
                        <Show when={isCurrent()}>
                          <text fg={theme.secondary}>  (current)</text>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </Show>

              <Show when={p().phase === "providers"}>
                <For each={(p() as { phase: "providers"; providers: ProviderSummary[] }).providers}>
                  {(provider, i) => {
                    const selected = () => (p() as { phase: "providers"; index: number }).index === i();
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{provider.id}{providerAuthLabel(provider.authStrategy)}
                        </text>
                        <Show when={provider.active}>
                          <text fg={theme.secondary}>  (active)</text>
                        </Show>
                        <Show when={!provider.configured}>
                          <text fg={theme.secondary}>  (needs setup)</text>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </Show>

              <Show when={p().phase === "provider-auth"}>
                <For each={(p() as { phase: "provider-auth"; paths: ProviderAuthPath[] }).paths}>
                  {(path, i) => {
                    const selected = () => (p() as { phase: "provider-auth"; index: number }).index === i();
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{path.label}
                        </text>
                        <Show when={path.configured}>
                          <text fg={theme.secondary}>  (configured)</text>
                        </Show>
                        <Show when={!path.configured}>
                          <text fg={theme.secondary}>  (needs setup)</text>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </Show>

              <Show when={p().phase === "mode"}>
                <For each={APPROVAL_MODES}>
                  {(mode, i) => {
                    const selected = () => (p() as { phase: "mode"; index: number }).index === i();
                    const isCurrent = () => mode === (coerceApprovalMode(state().meta.approval) ?? "normal");
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{APPROVAL_MODE_LABELS[mode]}
                        </text>
                        <Show when={isCurrent()}>
                          <text fg={theme.secondary}>  (current)</text>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </Show>

              <Show when={p().phase === "sessions"}>
                <Show
                  when={(p() as SessionsPaletteState).menu === "list"}
                  fallback={
                    <Show when={selectedSession(p() as SessionsPaletteState)}>
                      {(session) => {
                        const date = formatSessionDate(session().lastTs || session().createdAt);
                        const turns = `${session().turns} turn${session().turns !== 1 ? "s" : ""}`;
                        const active = () => session().sessionId === props.activeSessionId;
                        return (
                          <box flexDirection="column">
                            <text fg={theme.toolError} attributes={BOLD}>delete</text>
                            <text fg={theme.fg} attributes={BOLD}>
                              {date}  {session().sessionId}
                            </text>
                            <text fg={theme.secondary}>  {turns}  {session().cwd}</text>
                            <Show when={active()}>
                              <text fg={theme.secondary}>  active session — cannot delete</text>
                            </Show>
                          </box>
                        );
                      }}
                    </Show>
                  }
                >
                  <scrollbox
                    ref={sessionListScrollRef}
                    height={Math.min(
                      (p() as SessionsPaletteState).sessions.length,
                      SESSION_LIST_MAX_VISIBLE,
                    )}
                    scrollY
                    contentOptions={{ flexDirection: "column" }}
                  >
                    <For each={(p() as SessionsPaletteState).sessions}>
                      {(session, i) => {
                        const sp = () => p() as SessionsPaletteState;
                        const selected = () => sp().index === i();
                        const date = formatSessionDate(session.lastTs || session.createdAt);
                        const turns = `${session.turns} turn${session.turns !== 1 ? "s" : ""}`;
                        const active = () => session.sessionId === props.activeSessionId;
                        return (
                          <box id={`session-row-${i()}`} flexDirection="row">
                            <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                              {selected() ? "▶ " : "  "}{date}  {session.sessionId}
                            </text>
                            <text fg={theme.secondary}>  {turns}  {session.cwd}</text>
                            <Show when={active()}>
                              <text fg={theme.muted}>  (active)</text>
                            </Show>
                          </box>
                        );
                      }}
                    </For>
                  </scrollbox>
                </Show>
              </Show>

              <box marginTop={1}>
                <text fg={theme.secondary}>
                  {p().phase === "commands"
                    ? "↑↓ navigate · Enter select · Esc close"
                    : p().phase === "sessions"
                      ? sessionsPaletteHint((p() as SessionsPaletteState).menu)
                      : "↑↓ navigate · Enter select · Esc back"}
                </text>
              </box>
            </box>
          )}
        </Show>

        <box flexDirection="row">
          <text fg={theme.accent} attributes={BOLD}>› </text>
          <input
            ref={inputRef}
            flexGrow={1}
            focused={state().phase !== "approval"}
            textColor={theme.fg}
            focusedTextColor={theme.fg}
            backgroundColor={theme.bg}
            focusedBackgroundColor={theme.bg}
            onInput={handleInput}
            onSubmit={() => void handleSubmit(inputRef?.value ?? "")}
          />
        </box>
        <text fg={theme.secondary}>{state().statusHint}</text>
      </box>
    </box>
    </ToolExpandProvider>
  );
}
