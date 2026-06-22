import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { SessionController, SessionState, Turn } from "./controller.js";
import { hiddenNativeScrollbar, scrollbars, theme } from "./theme.js";
import { ScrollRail } from "./scroll-rail.js";
import { useSpinnerClock } from "./spinner.js";
import { StartupLogo } from "./logo.js";
import { ApprovalBar, formatContextWindowLabel, formatModelPricingLabel, formatSessionCost, Header, QuestionBar, TodoSidebar, TurnView } from "./views.js";
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
import { sanitizePromptInput, selectionCopyHint } from "./terminal-env.js";
import { KEYBOARD_HINTS, processCommand, isActionableCommandResult, type CommandResult } from "./commands.js";
import { APPROVAL_MODES, APPROVAL_MODE_LABELS, coerceApprovalMode, type ApprovalMode } from "../approval/policy.js";
import { ISOLATION_MODES, ISOLATION_LABELS, type IsolationMode } from "../agent/isolation.js";
import type { AgentPreset } from "../agent/presets.js";
import { pickerModelsForProvider } from "../config/models.js";
import { hasE2BApiKey, loadConfig } from "../config/config.js";
import { resolveDisplayModelPricing } from "../config/model-pricing.js";
import { loadPickerModels, resolveModelOnProviderSwitch } from "../provider/picker-models.js";
import { getContextWindow } from "../provider/context-window.js";
import { activeProviderId, providerConfigFields, providerSummaries, type ProviderSummary } from "../provider/registry.js";
import type { ProviderConfigField } from "../provider/types.js";
import type { SessionSummary } from "../session/log.js";
import type { CheckpointRecord } from "../checkpoint/manager.js";
import type { SessionsPaletteState } from "./sessions-palette.js";
import { selectedSession, sessionsPaletteAfterDelete, sessionsPaletteHint } from "./sessions-palette.js";

const BOLD = createTextAttributes({ bold: true });
const SESSION_LIST_MAX_VISIBLE = 10;
const MODEL_LIST_MAX_VISIBLE = 10;

const SLASH_COMMANDS = [
  { name: "model",     label: "/model",     description: "switch model" },
  { name: "mode",      label: "/mode",      description: "set approval mode" },
  { name: "providers", label: "/providers", description: "switch LLM provider" },
  { name: "settings",  label: "/settings",  description: "E2B key, isolation, task models" },
  { name: "sessions",  label: "/sessions",  description: "browse sessions" },
  { name: "checkpoints", label: "/checkpoints", description: "list workspace checkpoints" },
  { name: "restore",   label: "/restore",   description: "roll back the working tree" },
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
  | { phase: "settings"; index: number }
  | { phase: "settings-isolation"; index: number }
  | { phase: "settings-role"; index: number; role: AgentPreset }
  | SessionsPaletteState;

/** Roles a user can pin a task-tool model to, in menu order. */
const SETTINGS_ROLES: ReadonlyArray<{ role: AgentPreset; label: string }> = [
  { role: "implement", label: "Task model · implement (coding)" },
  { role: "review", label: "Task model · review" },
  { role: "explore", label: "Task model · explore" },
];

type SettingsItem =
  | { kind: "e2b" }
  | { kind: "isolation" }
  | { kind: "role"; role: AgentPreset; label: string };

const SETTINGS_ITEMS: readonly SettingsItem[] = [
  { kind: "e2b" },
  { kind: "isolation" },
  ...SETTINGS_ROLES.map((r) => ({ kind: "role" as const, role: r.role, label: r.label })),
];

/** Sentinel row in the role-model picker that clears the override. */
const ROLE_MODEL_DEFAULT = "default (use tier model)";

type ConfigPromptState = {
  providerId: string;
  displayName: string;
  fields: readonly ProviderConfigField[];
  fieldIndex: number;
  values: Record<string, string>;
  activateOnComplete: boolean;
};

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
  onStopTurn: () => void;
  onExit: () => void;
  onSetModel: (model: string) => void;
  onSetMode: (mode: ApprovalMode) => void;
  onSetIsolation: (isolation: IsolationMode) => void;
  onSetRoleModel: (role: AgentPreset, model: string, providerId: string) => void;
  onSetProvider: (provider: string, model?: string) => void;
  onConfigureProvider: (
    provider: string,
    values: Record<string, string>,
    activate: boolean,
  ) => void;
  onConfigureE2b: (apiKey: string) => void;
  onClear: () => void;
  onNew: () => void;
  onResume: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => { ok: boolean; message: string };
  onListSessions: () => SessionSummary[];
  onListCheckpoints: () => CheckpointRecord[];
  onRestoreCheckpoint: (id?: string) => { ok: boolean; message: string };
  activeSessionId: string;
}) {
  const [state, setState] = createSignal(props.controller.getState());
  const [submitting, setSubmitting] = createSignal(false);
  const [questionIndex, setQuestionIndex] = createSignal(0);
  const [palette, setPalette] = createSignal<PaletteState | null>(null);
  const [configPrompt, setConfigPrompt] = createSignal<ConfigPromptState | null>(null);
  const [e2bPrompt, setE2bPrompt] = createSignal(false);
  const toolExpand = createToolExpandState();
  const renderer = useRenderer();
  onCleanup(props.controller.subscribe(setState));
  useSpinnerClock();

  // Reset the highlighted option whenever a new question is posed. Keyed on the
  // question text via a memo so option navigation (which doesn't change the
  // text) doesn't get clobbered by the per-keystroke state churn.
  const questionKey = createMemo(() => state().pendingQuestion?.question ?? null);
  createEffect(() => {
    questionKey();
    setQuestionIndex(0);
  });

  const canStopTurn = () =>
    submitting()
    || state().phase === "running"
    || state().phase === "approval"
    || state().phase === "question";

  const handleStopTurn = () => {
    if (!canStopTurn()) return;
    props.onStopTurn();
    props.controller.setStatusHint("Stopping…");
  };

  const copyShortcutsEnabled = () =>
    state().phase === "input"
    && palette() === null
    && configPrompt() === null
    && !e2bPrompt()
    && !submitting();

  const pasteShortcutEnabled = () =>
    state().phase !== "approval"
    && state().phase !== "question"
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
    // The approval bar / phase changes resize the scroll row, so re-measure the
    // rail when they toggle — otherwise it keeps a stale (taller) height and
    // overflows over the approval bar.
    state().phase;
    state().pendingApproval;
    queueMicrotask(bumpScrollRail);
  });

  let scrollRef: ScrollBoxRenderable | undefined;
  let sessionListScrollRef: ScrollBoxRenderable | undefined;
  let modelListScrollRef: ScrollBoxRenderable | undefined;
  let inputRef: InputRenderable | undefined;

  const scrollSessionIntoView = (index: number) => {
    sessionListScrollRef?.scrollChildIntoView(`session-row-${index}`);
  };

  const scrollModelIntoView = (index: number) => {
    modelListScrollRef?.scrollChildIntoView(`model-row-${index}`);
  };

  createEffect(() => {
    const p = palette();
    if (p?.phase !== "sessions" || p.menu !== "list") return;
    const index = p.index;
    queueMicrotask(() => scrollSessionIntoView(index));
  });

  createEffect(() => {
    const p = palette();
    if (p?.phase !== "model" && p?.phase !== "settings-role") return;
    const index = p.index;
    queueMicrotask(() => scrollModelIntoView(index));
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

  // Context windows for the picker rows. Resolved off the catalog (cached, so it
  // costs one fetch per provider) and keyed by model id. Reset per provider/list
  // change so a model id shared across providers can't show a stale window.
  const [modelContextWindows, setModelContextWindows] = createSignal<Record<string, number>>({});
  createEffect(() => {
    const providerId = state().meta.provider ?? activeProviderId();
    const models = pickerModelList();
    void Promise.all(
      models.map(
        async (model) => [model, await getContextWindow(model).catch(() => undefined)] as const,
      ),
    ).then((entries) => {
      if ((state().meta.provider ?? activeProviderId()) !== providerId) return;
      const next: Record<string, number> = {};
      for (const [model, window] of entries) {
        if (typeof window === "number" && window > 0) next[model] = window;
      }
      setModelContextWindows(next);
    });
  });

  const pickerModels = () => pickerModelList();

  // Provider the role-model menu reads from and writes to. Role overrides are
  // provider-scoped, so configuring a role pins it to the active provider's
  // models — switching providers (via /providers) configures a different set.
  const roleProviderId = () => state().meta.provider ?? activeProviderId();

  // Role-model picker: the provider's curated models plus a leading sentinel
  // that clears the override back to the role's tier default.
  const roleModelList = () => [ROLE_MODEL_DEFAULT, ...pickerModels()];

  // Pricing comes from the static config table, which doesn't change during a
  // session. Read it once here instead of calling loadConfig() (which re-reads
  // and re-merges the config file from disk) inside hot render paths.
  const modelPricing = loadConfig().models.pricing;

  const filteredCommands = () => {
    const input = state().input;
    if (!input.startsWith("/")) return [...SLASH_COMMANDS];
    const filter = input.slice(1).toLowerCase();
    if (!filter) return [...SLASH_COMMANDS];
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(filter));
  };

  const commandContext = () => {
    const meta = state().meta;
    return {
      currentModel: meta.model,
      currentMode: coerceApprovalMode(meta.approval) ?? "normal",
      currentIsolation: loadConfig().subagent.isolation,
      knownModels: pickerModels(),
      currentProvider: meta.provider ?? activeProviderId(),
      providers: providerSummaries(),
      providerConfigFields,
      modelPricing,
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

  const closeE2bPrompt = () => {
    setE2bPrompt(false);
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
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

  const handleE2bSubmit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      props.controller.setStatusHint("API key required — Esc to cancel");
      return;
    }

    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
    closeE2bPrompt();
    props.onConfigureE2b(trimmed);
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
      case "checkpoints": {
        const records = props.onListCheckpoints();
        if (records.length === 0) {
          props.controller.setStatusHint(
            "No checkpoints yet — they're created after edits on a local workspace.",
          );
          return;
        }
        const lines = records.map((r) => `  ${r.id}  ${r.label}  (${formatSessionDate(r.ts)})`);
        props.controller.setStatusHint(
          `checkpoints (newest first):\n${lines.join("\n")}\n/restore <id> to roll back`,
        );
        return;
      }
      case "restore": {
        const res = props.onRestoreCheckpoint(result.id);
        props.controller.setStatusHint(res.message);
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
      case "set-isolation":
        props.onSetIsolation(result.isolation);
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
      case "configure-e2b":
        setE2bPrompt(true);
        props.controller.setStatusHint(result.message);
        return;
      case "open-settings":
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        setPalette({ phase: "settings", index: 0 });
        return;
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

      if (name === "settings") {
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        setPalette({ phase: "settings", index: 0 });
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
      } else if (name === "checkpoints") {
        applyCommandResult({ type: "checkpoints" });
      } else if (name === "restore") {
        applyCommandResult({ type: "restore" });
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

    if (p.phase === "settings") {
      const item = SETTINGS_ITEMS[p.index];
      if (!item) return;
      if (item.kind === "e2b") {
        setPalette(null);
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        setE2bPrompt(true);
        props.controller.setStatusHint(
          "Configure E2B: paste your API key (get one at https://e2b.dev/docs/api-key) · Esc to cancel",
        );
        return;
      }
      if (item.kind === "isolation") {
        const currentIdx = ISOLATION_MODES.indexOf(loadConfig().subagent.isolation);
        setPalette({ phase: "settings-isolation", index: Math.max(0, currentIdx) });
        return;
      }
      // role
      const list = roleModelList();
      const current = loadConfig().models.roles?.[roleProviderId()]?.[item.role]?.trim();
      const currentIdx = current ? list.indexOf(current) : 0;
      setPalette({ phase: "settings-role", index: Math.max(0, currentIdx), role: item.role });
      return;
    }

    if (p.phase === "settings-isolation") {
      const mode = ISOLATION_MODES[p.index];
      if (mode) {
        props.onSetIsolation(mode);
        setPalette({ phase: "settings", index: 1 });
      }
      return;
    }

    if (p.phase === "settings-role") {
      const list = roleModelList();
      const choice = list[p.index];
      if (choice === undefined) return;
      const model = choice === ROLE_MODEL_DEFAULT ? "" : choice;
      props.onSetRoleModel(p.role, model, roleProviderId());
      const roleIdx = SETTINGS_ITEMS.findIndex((i) => i.kind === "role" && i.role === p.role);
      setPalette({ phase: "settings", index: Math.max(0, roleIdx) });
      return;
    }

    if (p.phase === "providers") {
      const provider = p.providers[p.index];
      if (!provider) return;

      if (!provider.active) {
        setPalette(null);
        if (!provider.configured) {
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
    // A pending question intercepts Enter: a typed reply wins; otherwise the
    // highlighted option is selected.
    if (state().phase === "question") {
      const pending = state().pendingQuestion;
      if (pending) {
        const typed = raw.trim();
        const answer = typed || pending.options[questionIndex()] || "";
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        props.controller.respondQuestion(answer);
      }
      return;
    }

    // Provider/E2B config prompts take priority over the command palette.
    if (configPrompt() !== null) {
      handleConfigSubmit(raw);
      return;
    }
    if (e2bPrompt()) {
      handleE2bSubmit(raw);
      return;
    }

    // If palette is open, Enter selects unless the input is an actionable slash command.
    if (palette() !== null) {
      const text = raw.trim();
      if (text.startsWith("/")) {
        const result = processCommand(text, commandContext());
        if (isActionableCommandResult(result)) {
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
    if (submitting() || state().phase !== "input") return;

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

  const handleInput = (rawValue: string) => {
    // Strip any Kitty graphics capability probe Terminal.app may have leaked into
    // the field (no-op for ordinary input). If we cleaned anything, write the
    // cleaned value back so the InputRenderable doesn't keep the garbage.
    const value = sanitizePromptInput(rawValue);
    if (value !== rawValue && inputRef) inputRef.value = value;
    props.controller.setInput(value);
    if (configPrompt() !== null || e2bPrompt()) return;

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
      if (configPrompt() !== null) {
        closeConfigPrompt();
        props.controller.setStatusHint("configuration cancelled");
        return;
      }
      if (e2bPrompt()) {
        closeE2bPrompt();
        props.controller.setStatusHint("configuration cancelled");
        return;
      }
      if (canStopTurn()) {
        handleStopTurn();
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

    // Question: arrow keys move the highlighted option, Esc skips. Typing a
    // custom reply and Enter (to submit) fall through to the focused input —
    // Enter lands in the input's onSubmit → handleSubmit's question branch.
    if (phase === "question") {
      const pending = state().pendingQuestion;
      if (!pending) return;
      if (key.name === "up") {
        setQuestionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.name === "down") {
        setQuestionIndex((i) => Math.min(pending.options.length - 1, i + 1));
        return;
      }
      if (key.name === "escape" && !renderer.hasSelection) {
        props.controller.rejectPendingQuestion();
        props.controller.setStatusHint("Question skipped — continuing");
        return;
      }
      return;
    }

    if (phase === "running" && key.name === "escape" && !renderer.hasSelection) {
      handleStopTurn();
      return;
    }

    if (configPrompt() !== null) {
      if (key.name === "escape") {
        closeConfigPrompt();
        props.controller.setStatusHint("configuration cancelled");
      }
      return;
    }

    if (e2bPrompt()) {
      if (key.name === "escape") {
        closeE2bPrompt();
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
                : p.phase === "sessions"
                    ? Math.max(0, p.sessions.length - 1)
                    : p.phase === "settings"
                      ? Math.max(0, SETTINGS_ITEMS.length - 1)
                      : p.phase === "settings-isolation"
                        ? Math.max(0, ISOLATION_MODES.length - 1)
                        : p.phase === "settings-role"
                          ? Math.max(0, roleModelList().length - 1)
                          : APPROVAL_MODES.length - 1;
        setPalette({ ...p, index: Math.min(maxIdx, p.index + 1) });
        return;
      }
      if (key.name === "escape") {
        if (p.phase === "sessions" && p.menu === "delete") {
          setPalette({ ...p, menu: "list" });
          return;
        }
        // Settings submenus step back to the settings menu, not the command list.
        if (p.phase === "settings-isolation" || p.phase === "settings-role") {
          setPalette({ phase: "settings", index: 0 });
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
      && !e2bPrompt()
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
          costUsd={state().meta.costUsd}
          tokenTotals={state().meta.tokenTotals}
          contextTokens={state().meta.contextTokens}
          contextWindow={state().meta.contextWindow}
          faux={state().meta.faux}
        />
      </box>

      {/*
        Clip the scroll row to its own bounds. When the approval bar appears the
        row shrinks (flexGrow/flexShrink), but the ScrollRail (stale metrics) and
        the TodoSidebar (long todo lists) have flexShrink=0 children that would
        otherwise overflow downward; the approval bar, a later sibling, then
        paints over that overflow — the "approval bar overlapping the rail /
        sidebar" bug. overflow:hidden + minHeight:0 keeps everything inside the row.
      */}
      <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        <scrollbox
          ref={scrollRef}
          flexGrow={1}
          stickyScroll
          stickyStart="bottom"
          contentOptions={{ flexDirection: "column" }}
          {...hiddenNativeScrollbar}
          on:scroll={bumpScrollRail}
          // Re-measure the rail when the scroll row actually resizes (e.g. the
          // approval bar appearing shrinks it). Fires after layout, so the rail
          // reads the fresh viewport height instead of the stale taller one the
          // queueMicrotask bump below would otherwise catch.
          onSizeChange={bumpScrollRail}
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

      <Show when={state().pendingQuestion}>
        {(pending) => (
          <box flexShrink={0}>
            <QuestionBar
              question={pending().question}
              options={pending().options}
              selectedIndex={questionIndex()}
            />
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

        <Show when={e2bPrompt()}>
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
              E2B setup
            </text>
            <text fg={theme.secondary}>
              Paste your E2B API key (saved to ~/.orin/config.json, enables the task tool)
            </text>
          </box>
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
                <scrollbox
                  ref={modelListScrollRef}
                  height={Math.min(pickerModels().length, MODEL_LIST_MAX_VISIBLE)}
                  scrollY
                  contentOptions={{ flexDirection: "column" }}
                >
                  <For each={[...pickerModels()]}>
                    {(model, i) => {
                      const selected = () => (p() as { phase: "model"; index: number }).index === i();
                      const isCurrent = () => model === state().meta.model;
                      const providerId = () => state().meta.provider ?? activeProviderId();
                      const pricingLabel = () =>
                        formatModelPricingLabel(
                          resolveDisplayModelPricing(
                            model,
                            providerId(),
                            modelPricing,
                          ),
                        );
                      const contextLabel = () => formatContextWindowLabel(modelContextWindows()[model]);
                      return (
                        <box id={`model-row-${i()}`} flexDirection="row">
                          <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                            {selected() ? "▶ " : "  "}{model}
                          </text>
                          <text fg={theme.secondary}>  {pricingLabel()}</text>
                          <Show when={contextLabel()}>
                            <text fg={theme.secondary}>  {contextLabel()}</text>
                          </Show>
                          <Show when={isCurrent()}>
                            <text fg={theme.secondary}>  (current)</text>
                          </Show>
                        </box>
                      );
                    }}
                  </For>
                </scrollbox>
              </Show>

              <Show when={p().phase === "providers"}>
                <For each={(p() as { phase: "providers"; providers: ProviderSummary[] }).providers}>
                  {(provider, i) => {
                    const selected = () => (p() as { phase: "providers"; index: number }).index === i();
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{provider.id}
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

              <Show when={p().phase === "settings"}>
                <text fg={theme.secondary}>
                  Task model overrides apply to the active provider · {roleProviderId()}
                </text>
                <For each={SETTINGS_ITEMS}>
                  {(item, i) => {
                    const selected = () => (p() as { phase: "settings"; index: number }).index === i();
                    const cfg = () => loadConfig();
                    const label = () =>
                      item.kind === "e2b"
                        ? "E2B API key"
                        : item.kind === "isolation"
                          ? "Subagent isolation"
                          : item.label;
                    const value = () =>
                      item.kind === "e2b"
                        ? (hasE2BApiKey() ? "configured" : "not configured")
                        : item.kind === "isolation"
                          ? cfg().subagent.isolation
                          : (cfg().models.roles?.[roleProviderId()]?.[item.role]?.trim() || "default");
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{label()}
                        </text>
                        <text fg={theme.secondary}>  {value()}</text>
                      </box>
                    );
                  }}
                </For>
              </Show>

              <Show when={p().phase === "settings-isolation"}>
                <For each={ISOLATION_MODES}>
                  {(mode, i) => {
                    const selected = () => (p() as { phase: "settings-isolation"; index: number }).index === i();
                    const isCurrent = () => mode === loadConfig().subagent.isolation;
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{ISOLATION_LABELS[mode]}
                        </text>
                        <Show when={isCurrent()}>
                          <text fg={theme.secondary}>  (current)</text>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </Show>

              <Show when={p().phase === "settings-role"}>
                <text fg={theme.secondary}>
                  {(p() as { phase: "settings-role"; role: AgentPreset }).role} model · provider {roleProviderId()}
                </text>
                <scrollbox
                  ref={modelListScrollRef}
                  height={Math.min(roleModelList().length, MODEL_LIST_MAX_VISIBLE)}
                  scrollY
                  contentOptions={{ flexDirection: "column" }}
                >
                  <For each={roleModelList()}>
                    {(model, i) => {
                      const sp = () => p() as { phase: "settings-role"; index: number; role: AgentPreset };
                      const selected = () => sp().index === i();
                      const providerId = () => roleProviderId();
                      const override = () => loadConfig().models.roles?.[providerId()]?.[sp().role]?.trim() ?? "";
                      const isCurrent = () =>
                        model === ROLE_MODEL_DEFAULT ? override() === "" : model === override();
                      const pricingLabel = () =>
                        model === ROLE_MODEL_DEFAULT
                          ? ""
                          : formatModelPricingLabel(
                              resolveDisplayModelPricing(model, providerId(), modelPricing),
                            );
                      const contextLabel = () =>
                        model === ROLE_MODEL_DEFAULT
                          ? ""
                          : formatContextWindowLabel(modelContextWindows()[model]);
                      return (
                        <box id={`model-row-${i()}`} flexDirection="row">
                          <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                            {selected() ? "▶ " : "  "}{model}
                          </text>
                          <Show when={pricingLabel()}>
                            <text fg={theme.secondary}>  {pricingLabel()}</text>
                          </Show>
                          <Show when={contextLabel()}>
                            <text fg={theme.secondary}>  {contextLabel()}</text>
                          </Show>
                          <Show when={isCurrent()}>
                            <text fg={theme.secondary}>  (current)</text>
                          </Show>
                        </box>
                      );
                    }}
                  </For>
                </scrollbox>
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
                            <text fg={theme.secondary}>  {turns}  {formatSessionCost(session().costUsd)}  {session().cwd}</text>
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
                            <text fg={theme.secondary}>  {turns}  {formatSessionCost(session.costUsd)}  {session.cwd}</text>
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
