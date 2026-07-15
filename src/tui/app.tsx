import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, Index, onCleanup, Show } from "solid-js";
import { IDLE_STATUS_HINT, type SessionController, type SessionState, type Turn } from "./controller.js";
import { hiddenNativeScrollbar, scrollbars, theme } from "./theme.js";
import { ScrollRail } from "./scroll-rail.js";
import { spinnerFrame, useSpinnerClock } from "./spinner.js";
import { StartupLogo } from "./logo.js";
import { ApprovalBar, formatContextWindowLabel, formatModelPricingLabel, InfoSidebar, QuestionBar, TurnView } from "./views.js";
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
  isTogglePanelsShortcut,
} from "./shortcuts.js";
import { readRendererSelection } from "./selection.js";
import { sanitizePromptInput, selectionCopyHint } from "./terminal-env.js";
import { forceFullRepaint } from "./terminal.js";
import { KEYBOARD_HINTS, processCommand, isActionableCommandResult, type CommandResult } from "./commands.js";
import { APPROVAL_MODES, APPROVAL_MODE_LABELS, coerceApprovalMode, type ApprovalMode } from "../approval/policy.js";
import { ISOLATION_MODES, ISOLATION_LABELS, type IsolationMode } from "../agent/isolation.js";
import {
  SESSION_ISOLATION_MODES,
  SESSION_ISOLATION_LABELS,
  type SessionIsolationMode,
} from "../agent/session-isolation.js";
import {
  PARALLEL_SUBAGENT_INFO,
  PARALLEL_SUBAGENT_MENU_VALUE,
  effectiveSerialSubagentMenuValue,
  parentWorkspaceMenuValue,
  serialSubagentPaletteHeader,
} from "../agent/workspace-settings.js";
import { hasE2BApiKey, hasExaApiKey, loadConfig, type ModelSlot } from "../config/config.js";
import { pickerModelsForProvider, resolveProviderSlot } from "../config/models.js";
import { resolveDisplayModelPricing } from "../config/model-pricing.js";
import { loadPickerModels, resolveModelOnProviderSwitch } from "../provider/picker-models.js";
import { getContextWindow } from "../provider/context-window.js";
import { activeProviderId, providerConfigFields, providerSummaries, type ProviderSummary } from "../provider/registry.js";
import type { ProviderConfigField } from "../provider/types.js";
import type { SessionSummary } from "../session/log.js";
import type { CheckpointRecord } from "../checkpoint/manager.js";
import type { SkillsPaletteState } from "./skills-palette.js";
import type { McpPaletteState } from "./mcp-palette.js";
import {
  mcpListRowLabel,
  mcpListRows,
  mcpPaletteAfterReload,
  mcpPaletteHint,
  mcpServerDetailLines,
  selectedMcpListRow,
} from "./mcp-palette.js";
import { mcpDetailCanAuthenticate } from "../mcp/oauth.js";
import type { McpSessionHost } from "./session.js";
import {
  applyWizardStep,
  beginAddWizard,
  beginEditWizard,
  currentWizardStep,
  validateWizardStep,
  wizardComplete,
  wizardFieldValue,
  wizardNeedsOAuthAfterSave,
  wizardToServerConfig,
  type McpWizardState,
} from "../mcp/wizard.js";
import {
  selectedSkill,
  skillInvocationMessage,
  skillPrefill,
  skillScopeLabel,
  skillsPaletteHint,
} from "./skills-palette.js";
import { discoverSkills } from "../skills/discovery.js";
import {
  DEFAULT_SIDEBAR_VISIBILITY,
  hideAllSidebars,
  showAllSidebars,
  sidebarVisibilityHint,
  toggleSidebar,
  type SidebarVisibility,
} from "./sidebar-state.js";
import {
  SessionsSidebar,
  sessionsSidebarHint,
  type SessionsSidebarMenu,
} from "./sessions-sidebar.js";

type SessionsSidebarState = {
  index: number;
  menu: SessionsSidebarMenu;
  focused: boolean;
};

const BOLD = createTextAttributes({ bold: true });
const MODEL_LIST_MAX_VISIBLE = 10;
const SKILLS_LIST_MAX_VISIBLE = 10;
const MCP_LIST_MAX_VISIBLE = 10;

const SLASH_COMMANDS = [
  { name: "model",     label: "/model",     description: "switch model" },
  { name: "mode",      label: "/mode",      description: "set approval mode" },
  { name: "providers", label: "/providers", description: "switch LLM provider" },
  { name: "settings",  label: "/settings",  description: "MCP, E2B key, isolation, telemetry, task models" },
  { name: "mcp",       label: "/mcp",       description: "browse and configure MCP servers" },
  { name: "sessions",  label: "/sessions",  description: "focus sessions sidebar" },
  { name: "panels",    label: "/panels",    description: "toggle sidebars" },
  { name: "skills",    label: "/skills",    description: "browse available skills" },
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
  | { phase: "settings-session-isolation"; index: number }
  | { phase: "settings-serial-info"; index: number }
  | { phase: "settings-parallel-info"; index: number }
  | { phase: "settings-model-slot"; index: number; slot: ModelSlot }
  | SkillsPaletteState
  | McpPaletteState;

function settingsItemIndex(kind: SettingsItem["kind"]): number {
  return SETTINGS_ITEMS.findIndex((item) => item.kind === kind);
}

function liveSessionIsolation(state: SessionState): SessionIsolationMode {
  return state.meta.sessionIsolation ?? loadConfig().session?.isolation ?? "shared";
}

const SETTINGS_MODEL_SLOTS: ReadonlyArray<{ slot: ModelSlot; label: string }> = [
  { slot: "implement", label: "Task model · implement (coding)" },
  { slot: "review", label: "Task model · review" },
  { slot: "explore", label: "Task model · explore" },
  { slot: "delegate_read", label: "Delegate read model" },
  { slot: "compaction", label: "Compaction model" },
];

type SettingsItem =
  | { kind: "mcp" }
  | { kind: "e2b" }
  | { kind: "exa" }
  | { kind: "session-isolation" }
  | { kind: "isolation" }
  | { kind: "parallel-info" }
  | { kind: "telemetry-capture" }
  | { kind: "model-slot"; slot: ModelSlot; label: string };

const SETTINGS_ITEMS: readonly SettingsItem[] = [
  { kind: "session-isolation" },
  { kind: "isolation" },
  { kind: "parallel-info" },
  { kind: "mcp" },
  { kind: "e2b" },
  { kind: "exa" },
  { kind: "telemetry-capture" },
  ...SETTINGS_MODEL_SLOTS.map((r) => ({ kind: "model-slot" as const, slot: r.slot, label: r.label })),
];

/** Sentinel row in the model-slot picker that clears the override. */
const MODEL_SLOT_DEFAULT = "default (use provider default)";

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
    blocks: state.currentBlocks,
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
  onSetSessionIsolation: (isolation: SessionIsolationMode) => void;
  onSetTelemetryCapture: (enabled: boolean) => void;
  onSetModelSlot: (slot: ModelSlot, model: string, providerId: string) => void;
  onSetProvider: (provider: string, model?: string) => void;
  onConfigureProvider: (
    provider: string,
    values: Record<string, string>,
    activate: boolean,
  ) => void;
  onConfigureE2b: (apiKey: string) => void;
  onConfigureExa: (apiKey: string) => void;
  mcpHost: McpSessionHost;
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
  const [sidebarVisibility, setSidebarVisibility] = createSignal<SidebarVisibility>(
    DEFAULT_SIDEBAR_VISIBILITY,
  );
  const [sessionsSidebar, setSessionsSidebar] = createSignal<SessionsSidebarState>({
    index: 0,
    menu: "list",
    focused: false,
  });
  const sessionsList = createMemo(() => props.onListSessions());
  const mcpPaletteRows = createMemo(() => {
    const pal = palette();
    if (!pal || pal.phase !== "mcp" || pal.menu !== "list") return [];
    return mcpListRows(pal.servers);
  });
  const [configPrompt, setConfigPrompt] = createSignal<ConfigPromptState | null>(null);
  const [mcpWizard, setMcpWizard] = createSignal<McpWizardState | null>(null);
  const [e2bPrompt, setE2bPrompt] = createSignal(false);
  const [exaPrompt, setExaPrompt] = createSignal(false);
  const [mcpServers, setMcpServers] = createSignal(props.mcpHost.getServers());
  const toolExpand = createToolExpandState();
  const renderer = useRenderer();
  onCleanup(props.controller.subscribe(setState));
  useSpinnerClock();

  // Reset the highlighted option whenever a new question is posed. Keyed on the
  // question's id (stable per `requestQuestion` call, even across a queue of
  // back-to-back questions with identical text) so option navigation — which
  // doesn't change the id — doesn't get clobbered by per-keystroke state churn.
  const questionKey = createMemo(() => state().pendingQuestion?.id ?? null);
  createEffect(() => {
    questionKey();
    setQuestionIndex(0);
  });

  // Options-based wizard steps (transport, authMode) are answered with arrow
  // keys + enter. Reset the highlight whenever the step changes, preselecting
  // the current value when editing an existing server.
  const [mcpWizardOptionIndex, setMcpWizardOptionIndex] = createSignal(0);
  const mcpWizardStepKey = createMemo(() => {
    const wizard = mcpWizard();
    const step = wizard ? currentWizardStep(wizard) : undefined;
    return step ? `${wizard!.stepIndex}:${step.id}` : null;
  });
  createEffect(() => {
    mcpWizardStepKey();
    const wizard = mcpWizard();
    const step = wizard ? currentWizardStep(wizard) : undefined;
    if (!wizard || !step?.options) return;
    const currentValue = wizardFieldValue(wizard, step.id);
    const idx = step.options.indexOf(currentValue);
    setMcpWizardOptionIndex(idx >= 0 ? idx : 0);
  });

  const canStopTurn = () =>
    submitting()
    || state().phase === "running"
    || state().phase === "approval"
    || state().phase === "question";

  const handleStopTurn = () => {
    if (!canStopTurn()) return;
    props.onStopTurn();
    props.controller.setStatusHint("Stopping… · please wait");
  };

  const copyShortcutsEnabled = () =>
    state().phase === "input"
    && palette() === null
    && configPrompt() === null
    && mcpWizard() === null
    && !e2bPrompt()
    && !exaPrompt()
    && !submitting();

  const pasteShortcutEnabled = () =>
    state().phase !== "approval"
    && state().phase !== "question"
    && palette() === null
    && mcpWizard() === null
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

  const showHoverFooter = () =>
    state().phase === "input"
    && palette() === null
    && configPrompt() === null
    && mcpWizard() === null
    && !e2bPrompt()
    && !exaPrompt()
    && !submitting()
    && state().statusHint === IDLE_STATUS_HINT;

  const footerHint = createMemo(() => {
    const hover = toolExpand.getHoverFooterHint();
    if (hover && showHoverFooter()) return hover;
    return state().statusHint;
  });

  // Ticks every spinner frame (80ms) so the footer keeps visibly moving even
  // during long silent stretches — e.g. a model generating a large `write` tool
  // call streams no usable increment, so this is the only sign of life.
  const runningElapsedLabel = createMemo(() => {
    spinnerFrame();
    const startedAt = state().turnStartedAt;
    if (state().phase !== "running" || startedAt === null) return null;
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${seconds}s`;
  });

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
  let skillsListScrollRef: ScrollBoxRenderable | undefined;
  let approvalScrollRef: ScrollBoxRenderable | undefined;
  const [approvalRailRevision, setApprovalRailRevision] = createSignal(0);
  const bumpApprovalRail = () => setApprovalRailRevision((n) => n + 1);
  let inputRef: InputRenderable | undefined;

  /** /mcp is keyboard-driven — blur the prompt so hover mouse reports cannot leak in. */
  const isSessionsSidebarFocused = createMemo(() =>
    sidebarVisibility().left
    && sessionsSidebar().focused
    && palette() === null
    && configPrompt() === null
    && mcpWizard() === null
    && !e2bPrompt()
    && !exaPrompt()
    && state().phase === "input"
    && !submitting(),
  );

  const inputFocused = createMemo(() => {
    if (state().phase === "approval") return false;
    if (palette()?.phase === "mcp") return false;
    if (isSessionsSidebarFocused()) return false;
    return true;
  });

  const swallowSidebarKey = (key: { preventDefault: () => void; stopPropagation: () => void }) => {
    key.preventDefault();
    key.stopPropagation();
  };

  const scrubLeakedPromptInput = () => {
    if (!inputRef) return;
    const raw = inputRef.value;
    const cleaned = sanitizePromptInput(raw);
    if (cleaned !== raw) {
      inputRef.value = cleaned;
      props.controller.setInput(cleaned);
      forceFullRepaint(renderer);
    }
  };

  createEffect(() => {
    if (palette()?.phase !== "mcp") return;
    let raf = 0;
    const loop = () => {
      scrubLeakedPromptInput();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  createEffect(() => {
    const p = palette();
    if (p?.phase === "mcp") {
      queueMicrotask(() => inputRef?.blur());
      return;
    }
    if (inputFocused()) {
      queueMicrotask(() => inputRef?.focus());
    }
  });

  const scrollSessionIntoView = (index: number) => {
    sessionListScrollRef?.scrollChildIntoView(`session-row-${index}`);
  };

  const focusSessionsSidebar = () => {
    const sessions = sessionsList();
    const activeIdx = sessions.findIndex((s) => s.sessionId === props.activeSessionId);
    setSidebarVisibility((v) => ({ ...v, left: true }));
    setSessionsSidebar({
      index: activeIdx >= 0 ? activeIdx : 0,
      menu: "list",
      focused: true,
    });
    queueMicrotask(() => inputRef?.blur());
    if (sessions.length === 0) {
      props.controller.setStatusHint("No sessions found.");
    } else {
      props.controller.setStatusHint(sessionsSidebarHint("list", true));
    }
  };

  const unfocusSessionsSidebar = () => {
    setSessionsSidebar((s) => ({ ...s, menu: "list", focused: false }));
    if (state().phase !== "approval") {
      queueMicrotask(() => inputRef?.focus());
    }
  };

  const syncSessionsSidebarIndex = () => {
    const sessions = sessionsList();
    const activeIdx = sessions.findIndex((s) => s.sessionId === props.activeSessionId);
    if (activeIdx >= 0) {
      setSessionsSidebar((s) => ({ ...s, index: activeIdx }));
    }
  };

  const scrollSkillIntoView = (index: number) => {
    skillsListScrollRef?.scrollChildIntoView(`skill-row-${index}`);
  };

  const scrollModelIntoView = (index: number) => {
    modelListScrollRef?.scrollChildIntoView(`model-row-${index}`);
  };

  createEffect(() => {
    props.activeSessionId;
    syncSessionsSidebarIndex();
  });

  createEffect(() => {
    const sb = sessionsSidebar();
    if (!sidebarVisibility().left || sb.menu !== "list") return;
    const index = sb.index;
    queueMicrotask(() => scrollSessionIntoView(index));
  });

  createEffect(() => {
    const p = palette();
    if (p?.phase !== "model" && p?.phase !== "settings-model-slot") return;
    const index = p.index;
    queueMicrotask(() => scrollModelIntoView(index));
  });

  createEffect(() => {
    const p = palette();
    if (p?.phase !== "skills" || p.menu !== "list") return;
    const index = p.index;
    queueMicrotask(() => scrollSkillIntoView(index));
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
  const modelSlotList = () => [MODEL_SLOT_DEFAULT, ...pickerModels()];

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
      currentSessionIsolation: loadConfig().session?.isolation ?? "shared",
      liveSessionIsolation: state().meta.sessionIsolation,
      liveSessionBranch: state().meta.branch,
      liveCwd: state().meta.cwd,
      currentCaptureContent: loadConfig().telemetry.otel.captureContent,
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

  const closeExaPrompt = () => {
    setExaPrompt(false);
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
  };

  const closeMcpWizard = () => {
    setMcpWizard(null);
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
  };

  const mcpWizardHint = (wizard: McpWizardState): string => {
    const step = currentWizardStep(wizard);
    if (!step) return "Saving MCP server…";
    const prefix = wizard.mode === "edit" ? `Edit MCP server ${wizard.name}` : "Add MCP server";
    const guidance = step.options ? "↑/↓ to choose · Enter to confirm" : step.hint;
    return `${prefix}: ${guidance} · Esc to cancel`;
  };

  const openMcpPalette = () => {
    if (inputRef) {
      inputRef.value = "";
      inputRef.blur();
    }
    props.controller.clearInput();
    setMcpServers(props.mcpHost.getServers());
    setPalette({ phase: "mcp", menu: "list", index: 0, servers: props.mcpHost.getServers() });
  };

  const reloadMcpConnections = async (previous?: McpPaletteState) => {
    props.controller.setStatusHint("Reloading MCP servers…");
    props.controller.clearInput();
    if (inputRef) inputRef.value = "";

    const result = await props.mcpHost.reload();
    setMcpServers(result.servers);
    props.controller.setStatusHint(
      result.warnings[0] ?? result.statusHint ?? "MCP servers reloaded",
    );

    scrubLeakedPromptInput();
    props.controller.clearInput();
    forceFullRepaint(renderer);

    if (previous) {
      setPalette(mcpPaletteAfterReload(result.servers, previous));
    }
  };

  const finishMcpWizard = async (wizard: McpWizardState) => {
    const serverConfig = wizardToServerConfig(wizard);
    if (!serverConfig) {
      props.controller.setStatusHint("MCP server configuration incomplete");
      return;
    }
    closeMcpWizard();
    const result = await props.mcpHost.saveServer(wizard.name, serverConfig, {
      replace: wizard.originalName,
    });
    setMcpServers(result.servers);
    if (wizardNeedsOAuthAfterSave(wizard)) {
      props.controller.setStatusHint(`Saved ${wizard.name} — opening browser to authenticate…`);
      const authResult = await props.mcpHost.authenticateServer(wizard.name);
      setMcpServers(authResult.servers);
      if (authResult.warnings.length > 0) {
        props.controller.setStatusHint(authResult.warnings[0]!);
        return;
      }
      const server = authResult.servers.find((s) => s.name === wizard.name);
      props.controller.setStatusHint(
        server?.status === "connected"
          ? `MCP ${wizard.name}: connected (${server.toolCount} tools)`
          : (authResult.statusHint ?? `Saved MCP server ${wizard.name}`),
      );
      return;
    }
    props.controller.setStatusHint(result.statusHint ?? `Saved MCP server ${wizard.name}`);
  };

  const handleMcpWizardSubmit = (raw: string) => {
    const wizard = mcpWizard();
    if (!wizard) return;

    const step = currentWizardStep(wizard);
    if (!step) {
      void finishMcpWizard(wizard);
      return;
    }

    const trimmed = step.options ? (step.options[mcpWizardOptionIndex()] ?? "") : raw.trim();
    if (!trimmed && !step.optional) {
      props.controller.setStatusHint("value required — Esc to cancel");
      return;
    }

    const error = validateWizardStep(wizard, step, trimmed);
    if (error) {
      props.controller.setStatusHint(error);
      return;
    }

    const next = applyWizardStep(wizard, step, trimmed);
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();

    if (wizardComplete(next)) {
      void finishMcpWizard(next);
      return;
    }

    setMcpWizard(next);
    props.controller.setStatusHint(mcpWizardHint(next));
  };

  const toggleMcpServerEnabled = async () => {
    const p = palette();
    if (p?.phase !== "mcp" || p.menu !== "detail" || !p.selectedName) return;
    const name = p.selectedName;
    const server = p.servers.find((s) => s.name === name);
    if (!server) return;

    if (server.scope === "project") {
      props.controller.setStatusHint(`Project servers can only be toggled by editing .mcp.json`);
      return;
    }

    const wasDisabled = server.config.disabled === true;
    const newConfig = { ...server.config, disabled: wasDisabled ? undefined : (true as const) };
    const result = await props.mcpHost.saveServer(name, newConfig);
    setMcpServers(result.servers);
    props.controller.setStatusHint(wasDisabled ? `MCP ${name}: enabled` : `MCP ${name}: disabled`);
    setPalette({ ...p, servers: result.servers });
  };

  const confirmMcpDelete = async () => {
    const p = palette();
    if (p?.phase !== "mcp" || p.menu !== "delete" || !p.selectedName) return;
    const name = p.selectedName;
    const result = await props.mcpHost.removeServer(name);
    setMcpServers(result.servers);
    props.controller.setStatusHint(result.statusHint ?? `Removed MCP server ${name}`);
    setPalette({ phase: "mcp", menu: "list", index: 0, servers: result.servers });
  };

  const authenticateMcpServerFromPalette = async () => {
    const p = palette();
    if (p?.phase !== "mcp" || p.menu !== "detail" || !p.selectedName) return;
    const name = p.selectedName;
    const server = p.servers.find((s) => s.name === name);
    if (!server || !mcpDetailCanAuthenticate(server)) return;

    props.controller.setStatusHint(`Opening browser to authenticate ${name}…`);
    if (server.config.type === "http" && server.config.oauth === undefined) {
      await props.mcpHost.enableOAuth(name);
    }
    const result = await props.mcpHost.authenticateServer(name);
    setMcpServers(result.servers);
    if (result.warnings.length > 0) {
      props.controller.setStatusHint(result.warnings[0]!);
    } else {
      const updated = result.servers.find((s) => s.name === name);
      props.controller.setStatusHint(
        updated?.status === "connected"
          ? `MCP ${name}: connected (${updated.toolCount} tools)`
          : (result.statusHint ?? `Authenticated MCP server ${name}`),
      );
    }
    setPalette({ ...p, servers: result.servers });
  };

  const closeConfigPrompt = () => {
    setConfigPrompt(null);
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
  };

  const configFieldHint = (prompt: ConfigPromptState): string => {
    const field = prompt.fields[prompt.fieldIndex];
    if (!field) return "";
    return `Configure ${prompt.displayName}: enter ${field.label} · Esc to cancel`;
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
      `Configure ${opts.displayName}: enter ${opts.fields[0]?.label ?? "value"} · Esc to cancel`,
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

  const handleExaSubmit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      props.controller.setStatusHint("API key required — Esc to cancel");
      return;
    }

    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
    closeExaPrompt();
    props.onConfigureExa(trimmed);
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
    scrubLeakedPromptInput();
    if (inputRef && state().phase !== "approval") inputRef.focus();
  };

  /** Open the skills browser, or report the empty state if none are discoverable. */
  const openSkillsPalette = () => {
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
    const skills = discoverSkills(state().meta.cwd);
    if (skills.length === 0) {
      setPalette(null);
      props.controller.setStatusHint(
        "No skills found — add SKILL.md under .orin/skills/ or ask the agent to create one",
      );
      return;
    }
    setPalette({ phase: "skills", index: 0, skills, menu: "list" });
  };

  /** Prefill `/skill <name> ` so the user can append a task and submit. */
  const prefillSkill = (name: string) => {
    const text = skillPrefill(name);
    setPalette(null);
    if (inputRef) inputRef.value = text;
    props.controller.setInput(text);
  };

  const confirmSessionDelete = () => {
    const sb = sessionsSidebar();
    if (sb.menu !== "delete") return;

    const session = sessionsList()[sb.index];
    if (!session) return;

    const result = props.onDeleteSession(session.sessionId);
    props.controller.setStatusHint(result.message);
    if (!result.ok) {
      setSessionsSidebar({ ...sb, menu: "list" });
      return;
    }

    const sessions = props.onListSessions();
    if (sessions.length === 0) {
      setSessionsSidebar({ index: 0, menu: "list", focused: sb.focused });
      return;
    }

    setSessionsSidebar({
      index: Math.min(sb.index, sessions.length - 1),
      menu: "list",
      focused: sb.focused,
    });
  };

  /** Submit a synthesized user turn (e.g. a `/skill` invocation). No-op while busy. */
  const runUserTurn = async (text: string) => {
    if (submitting() || state().phase !== "input") return;
    if (inputRef) inputRef.value = "";
    props.controller.clearInput();
    setSubmitting(true);
    try {
      await props.onSubmit(text);
    } finally {
      setSubmitting(false);
    }
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
        syncSessionsSidebarIndex();
        return;
      case "focus-sessions":
        focusSessionsSidebar();
        return;
      case "toggle-panels": {
        const next = toggleSidebar(sidebarVisibility(), result.target);
        setSidebarVisibility(next);
        props.controller.setStatusHint(sidebarVisibilityHint(next));
        return;
      }
      case "show-panels": {
        const next = result.visible ? showAllSidebars() : hideAllSidebars();
        setSidebarVisibility(next);
        props.controller.setStatusHint(sidebarVisibilityHint(next));
        return;
      }
      case "skills": {
        if (result.name) {
          const skills = discoverSkills(state().meta.cwd);
          const meta = skills.find((s) => s.name === result.name);
          if (!meta) {
            props.controller.setStatusHint(
              `No skill "${result.name}" — /skills to browse what's available`,
            );
            return;
          }
          const version = meta.version ? `  v${meta.version}` : "";
          props.controller.setStatusHint(
            `${meta.name}  ${skillScopeLabel(meta)}${version}\n${meta.description}\n${meta.path}`,
          );
          return;
        }
        openSkillsPalette();
        return;
      }
      case "skill": {
        void runUserTurn(skillInvocationMessage(result.name, result.task));
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
      case "set-session-isolation":
        props.onSetSessionIsolation(result.isolation);
        props.controller.setStatusHint(result.message);
        return;
      case "set-telemetry-capture":
        props.onSetTelemetryCapture(result.enabled);
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
      case "configure-exa":
        setExaPrompt(true);
        props.controller.setStatusHint(result.message);
        return;
      case "open-mcp":
        openMcpPalette();
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
        focusSessionsSidebar();
        return;
      }

      if (name === "panels") {
        closePalette();
        const next = toggleSidebar(sidebarVisibility(), "all");
        setSidebarVisibility(next);
        props.controller.setStatusHint(sidebarVisibilityHint(next));
        return;
      }

      if (name === "skills") {
        openSkillsPalette();
        return;
      }

      if (name === "mcp") {
        openMcpPalette();
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
      if (item.kind === "mcp") {
        setPalette(null);
        openMcpPalette();
        return;
      }
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
      if (item.kind === "exa") {
        setPalette(null);
        if (inputRef) inputRef.value = "";
        props.controller.clearInput();
        setExaPrompt(true);
        props.controller.setStatusHint(
          "Configure Exa: paste your API key (get one at https://dashboard.exa.ai/api-keys) · Esc to cancel",
        );
        return;
      }
      if (item.kind === "isolation") {
        if (liveSessionIsolation(state()) === "worktree") {
          setPalette({ phase: "settings-serial-info", index: 0 });
          return;
        }
        const currentIdx = ISOLATION_MODES.indexOf(loadConfig().subagent.isolation);
        setPalette({ phase: "settings-isolation", index: Math.max(0, currentIdx) });
        return;
      }
      if (item.kind === "parallel-info") {
        setPalette({ phase: "settings-parallel-info", index: 0 });
        return;
      }
      if (item.kind === "session-isolation") {
        const currentIdx = SESSION_ISOLATION_MODES.indexOf(loadConfig().session?.isolation ?? "shared");
        setPalette({ phase: "settings-session-isolation", index: Math.max(0, currentIdx) });
        return;
      }
      if (item.kind === "telemetry-capture") {
        // Boolean opt-in — flip in place and re-render the menu (new palette
        // object) so the row reflects the persisted value immediately.
        props.onSetTelemetryCapture(!loadConfig().telemetry.otel.captureContent);
        setPalette({ phase: "settings", index: p.index });
        return;
      }
      // model slot
      const list = modelSlotList();
      const current = loadConfig().models.providers?.[roleProviderId()]?.[item.slot]?.trim();
      const currentIdx = current ? list.indexOf(current) : 0;
      setPalette({ phase: "settings-model-slot", index: Math.max(0, currentIdx), slot: item.slot });
      return;
    }

    if (p.phase === "settings-isolation") {
      const mode = ISOLATION_MODES[p.index];
      if (mode) {
        props.onSetIsolation(mode);
        setPalette({ phase: "settings", index: settingsItemIndex("isolation") });
      }
      return;
    }

    if (p.phase === "settings-serial-info" || p.phase === "settings-parallel-info") {
      setPalette({
        phase: "settings",
        index: settingsItemIndex(p.phase === "settings-serial-info" ? "isolation" : "parallel-info"),
      });
      return;
    }

    if (p.phase === "settings-session-isolation") {
      const mode = SESSION_ISOLATION_MODES[p.index];
      if (mode) {
        props.onSetSessionIsolation(mode);
        setPalette({ phase: "settings", index: settingsItemIndex("session-isolation") });
      }
      return;
    }

    if (p.phase === "settings-model-slot") {
      const list = modelSlotList();
      const choice = list[p.index];
      if (choice === undefined) return;
      const model = choice === MODEL_SLOT_DEFAULT ? "" : choice;
      props.onSetModelSlot(p.slot, model, roleProviderId());
      const slotIdx = SETTINGS_ITEMS.findIndex((i) => i.kind === "model-slot" && i.slot === p.slot);
      setPalette({ phase: "settings", index: Math.max(0, slotIdx) });
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

    if (p.phase === "skills") {
      const skill = selectedSkill(p);
      if (!skill) return;
      // List view: Enter opens the detail view. Detail view: Enter prefills
      // `/skill <name> ` so the user can append a task and submit.
      if (p.menu === "list") {
        setPalette({ ...p, menu: "detail" });
        return;
      }
      prefillSkill(skill.name);
      return;
    }

    if (p.phase === "mcp") {
      if (p.menu === "delete") {
        void confirmMcpDelete();
        return;
      }
      if (p.menu === "detail") {
        const server = p.servers.find((s) => s.name === p.selectedName);
        if (!server) return;
        setPalette(null);
        const wizard = beginEditWizard(server.name, server.config);
        setMcpWizard(wizard);
        props.controller.setStatusHint(mcpWizardHint(wizard));
        return;
      }

      const row = selectedMcpListRow(p);
      if (!row) return;
      if (row.kind === "add") {
        setPalette(null);
        const wizard = beginAddWizard();
        setMcpWizard(wizard);
        props.controller.setStatusHint(mcpWizardHint(wizard));
        return;
      }
      if (row.kind === "reload") {
        void reloadMcpConnections(p);
        return;
      }
      setPalette({
        phase: "mcp",
        menu: "detail",
        index: p.index,
        servers: p.servers,
        selectedName: row.server.name,
      });
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
    if (mcpWizard() !== null) {
      handleMcpWizardSubmit(raw);
      return;
    }
    if (e2bPrompt()) {
      handleE2bSubmit(raw);
      return;
    }
    if (exaPrompt()) {
      handleExaSubmit(raw);
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
    if (configPrompt() !== null || mcpWizard() !== null || e2bPrompt() || exaPrompt()) return;

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
        key.preventDefault();
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
      if (exaPrompt()) {
        closeExaPrompt();
        props.controller.setStatusHint("configuration cancelled");
        return;
      }
      if (mcpWizard() !== null) {
        closeMcpWizard();
        props.controller.setStatusHint("MCP configuration cancelled");
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
      // preventDefault keeps the (still-focused) input renderable from also
      // capturing the keystroke — without it pressing "y" to approve would
      // both answer the prompt and type a stray "y" into the input box.
      key.preventDefault();
      if (key.name === "y") {
        props.controller.respondApproval(true);
        return;
      }
      if (key.name === "n") {
        props.controller.respondApproval(false);
        return;
      }
      if (key.name === "escape" && !renderer.hasSelection) {
        props.controller.respondApproval(false);
        return;
      }
      // Scroll a large (scrollbox) approval prompt. Short prompts render as
      // plain text and leave approvalScrollRef unset, so these are no-ops.
      const ref = approvalScrollRef;
      if (ref) {
        const page = Math.max(3, Math.floor(ref.viewport.height / 2));
        switch (key.name) {
          case "up":
            ref.scrollBy({ x: 0, y: -2 });
            bumpApprovalRail();
            return;
          case "down":
            ref.scrollBy({ x: 0, y: 2 });
            bumpApprovalRail();
            return;
          case "pageup":
            ref.scrollBy({ x: 0, y: -page });
            bumpApprovalRail();
            return;
          case "pagedown":
            ref.scrollBy({ x: 0, y: page });
            bumpApprovalRail();
            return;
          case "home":
            ref.scrollTo({ x: 0, y: 0 });
            bumpApprovalRail();
            return;
          case "end":
            ref.scrollTo({ x: 0, y: ref.scrollHeight });
            bumpApprovalRail();
            return;
        }
      }
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

    const wizard = mcpWizard();
    if (wizard !== null) {
      const step = currentWizardStep(wizard);
      if (step?.options) {
        if (key.name === "up") {
          setMcpWizardOptionIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setMcpWizardOptionIndex((i) => Math.min(step.options!.length - 1, i + 1));
          return;
        }
      }
      if (key.name === "escape") {
        closeMcpWizard();
        props.controller.setStatusHint("MCP configuration cancelled");
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

    if (exaPrompt()) {
      if (key.name === "escape") {
        closeExaPrompt();
        props.controller.setStatusHint("configuration cancelled");
      }
      return;
    }

    const p = palette();
    if (p !== null) {
      // Palette selection normally fires via the input's onSubmit, but /mcp blurs
      // the prompt (mouse-report leak fix) so Enter must be handled here instead.
      if ((key.name === "enter" || key.name === "return") && !inputFocused()) {
        handlePaletteSelect();
        return;
      }

      if (p.phase === "skills") {
        if (p.menu === "detail") {
          if (key.name === "left" || key.name === "escape") {
            setPalette({ ...p, menu: "list" });
            return;
          }
          // Enter (prefill) is handled by the input submit path. Swallow the
          // rest so the detail view doesn't scroll or move the list selection.
          if (key.name !== undefined) return;
        } else if (key.name === "right") {
          setPalette({ ...p, menu: "detail" });
          return;
        }
      }

      if (p.phase === "mcp") {
        if (p.menu === "delete") {
          if (key.name === "left" || key.name === "escape") {
            const server = p.servers.find((s) => s.name === p.selectedName);
            setPalette({
              phase: "mcp",
              menu: "detail",
              index: p.index,
              servers: p.servers,
              selectedName: server?.name,
            });
            return;
          }
          if (key.name !== undefined) return;
        } else if (p.menu === "detail") {
          if (key.name === "left" || key.name === "escape") {
            setPalette({ ...p, menu: "list", selectedName: undefined });
            return;
          }
          if (key.name === "right") {
            setPalette({ ...p, menu: "delete" });
            return;
          }
          if (key.name === "a") {
            const server = p.servers.find((s) => s.name === p.selectedName);
            if (server && mcpDetailCanAuthenticate(server)) {
              void authenticateMcpServerFromPalette();
              return;
            }
          }
          if (key.name === "d") {
            void toggleMcpServerEnabled();
            return;
          }
          if (key.name !== undefined) return;
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
                : p.phase === "skills"
                    ? Math.max(0, p.skills.length - 1)
                    : p.phase === "mcp"
                      ? Math.max(0, mcpListRows(p.servers).length - 1)
                    : p.phase === "settings"
                      ? Math.max(0, SETTINGS_ITEMS.length - 1)
                      : p.phase === "settings-isolation"
                        ? Math.max(0, ISOLATION_MODES.length - 1)
                        : p.phase === "settings-session-isolation"
                          ? Math.max(0, SESSION_ISOLATION_MODES.length - 1)
                          : p.phase === "settings-model-slot"
                          ? Math.max(0, modelSlotList().length - 1)
                          : APPROVAL_MODES.length - 1;
        setPalette({ ...p, index: Math.min(maxIdx, p.index + 1) });
        return;
      }
      if (key.name === "escape") {
        // Settings submenus step back to the settings menu, not the command list.
        if (p.phase === "settings-isolation" || p.phase === "settings-session-isolation" || p.phase === "settings-model-slot" || p.phase === "settings-serial-info" || p.phase === "settings-parallel-info") {
          setPalette({ phase: "settings", index: 0 });
          return;
        }
        if (p.phase !== "commands") {
          if (p.phase === "mcp" && (p.menu === "detail" || p.menu === "delete")) {
            setPalette({ phase: "mcp", menu: "list", index: p.index, servers: p.servers });
            return;
          }
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

    if (isTogglePanelsShortcut(key) && palette() === null && !configPrompt() && mcpWizard() === null && !e2bPrompt() && !exaPrompt()) {
      const next = toggleSidebar(sidebarVisibility(), "all");
      setSidebarVisibility(next);
      props.controller.setStatusHint(sidebarVisibilityHint(next));
      return;
    }

    const sb = sessionsSidebar();
    if (isSessionsSidebarFocused()) {
      const sessions = sessionsList();
      if (sb.menu === "delete") {
        if (key.name === "left" || key.name === "escape") {
          swallowSidebarKey(key);
          setSessionsSidebar({ ...sb, menu: "list" });
          props.controller.setStatusHint(sessionsSidebarHint("list", true));
          return;
        }
        if (key.name === "enter" || key.name === "return") {
          swallowSidebarKey(key);
          confirmSessionDelete();
          return;
        }
        if (key.name !== undefined) {
          swallowSidebarKey(key);
          return;
        }
      }

      if (key.name === "up") {
        swallowSidebarKey(key);
        setSessionsSidebar({ ...sb, index: Math.max(0, sb.index - 1) });
        props.controller.setStatusHint(sessionsSidebarHint("list", true));
        return;
      }
      if (key.name === "down") {
        swallowSidebarKey(key);
        const maxIdx = Math.max(0, sessions.length - 1);
        setSessionsSidebar({ ...sb, index: Math.min(maxIdx, sb.index + 1) });
        props.controller.setStatusHint(sessionsSidebarHint("list", true));
        return;
      }
      if (key.name === "right" && sessions.length > 0) {
        swallowSidebarKey(key);
        setSessionsSidebar({ ...sb, menu: "delete" });
        props.controller.setStatusHint(sessionsSidebarHint("delete", true));
        return;
      }
      if (key.name === "enter" || key.name === "return") {
        swallowSidebarKey(key);
        const session = sessions[sb.index];
        if (session) {
          unfocusSessionsSidebar();
          props.onResume(session.sessionId);
        }
        return;
      }
      if (key.name === "escape") {
        swallowSidebarKey(key);
        unfocusSessionsSidebar();
        props.controller.setStatusHint(IDLE_STATUS_HINT);
        return;
      }
      if (key.name === "tab") {
        swallowSidebarKey(key);
        unfocusSessionsSidebar();
        return;
      }
      if (
        key.name === "pageup"
        || key.name === "pagedown"
        || key.name === "home"
        || key.name === "end"
      ) {
        swallowSidebarKey(key);
        return;
      }
    } else if (
      key.name === "tab"
      && sidebarVisibility().left
      && palette() === null
      && !configPrompt()
      && mcpWizard() === null
      && !e2bPrompt()
      && !exaPrompt()
      && state().phase === "input"
      && !submitting()
    ) {
      focusSessionsSidebar();
      return;
    }

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
          key.preventDefault();
          return;
        }
      }
    }
    if (!isSessionsSidebarFocused()) {
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
    }
  });

  return (
    <ToolExpandProvider value={toolExpand}>
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      {/*
        Sidebars flank the full center column (conversation + prompts + input) so
        panel backgrounds run flush to the footer. The inner conversation row clips
        overflow so the scroll rail and long todo lists cannot paint over the
        approval bar.
      */}
      <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        <Show when={sidebarVisibility().left}>
          <SessionsSidebar
            sessions={sessionsList()}
            index={sessionsSidebar().index}
            menu={sessionsSidebar().menu}
            activeSessionId={props.activeSessionId}
            focused={sessionsSidebar().focused}
            formatDate={formatSessionDate}
            scrollRef={(r) => {
              sessionListScrollRef = r;
            }}
          />
        </Show>

        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        <scrollbox
          ref={scrollRef}
          flexGrow={1}
          stickyScroll
          stickyStart="bottom"
          contentOptions={{ flexDirection: "column" }}
          {...hiddenNativeScrollbar}
          // onMouseScroll is the channel ScrollBox fires on a wheel event;
          // on:scroll is an EventEmitter event the box never emits, so the rail
          // thumb would only refresh on resize without this.
          onMouseScroll={bumpScrollRail}
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
          </box>

      <Show when={state().pendingApproval}>
        {(pending) => (
          <box flexShrink={0}>
            <ApprovalBar
              name={pending().name}
              args={pending().args}
              providerInputSchema={pending().providerInputSchema}
              scrollRef={(r) => {
                approvalScrollRef = r;
              }}
              railRevision={approvalRailRevision}
              onScroll={bumpApprovalRail}
            />
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

      <box flexShrink={0} flexDirection="column" paddingTop={1} border={["top"]} borderColor={theme.border}>
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

        <Show when={exaPrompt()}>
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
              Exa setup
            </text>
            <text fg={theme.secondary}>
              Paste your Exa API key (saved to ~/.orin/config.json, enables the web_search tool)
            </text>
          </box>
        </Show>

        <Show when={mcpWizard()}>
          {(wizard) => {
            const step = () => currentWizardStep(wizard());
            return (
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
                  {wizard().mode === "edit" ? `Edit MCP server — ${wizard().name}` : "Add MCP server"}
                </text>
                <Show when={step()}>
                  {(s) => (
                    <>
                      <text fg={theme.fg} attributes={BOLD}>{s().title}</text>
                      <text fg={theme.secondary}>{s().hint}</text>
                      <Show when={s().options}>
                        {(options) => (
                          <box flexDirection="column" marginTop={1}>
                            <For each={options()}>
                              {(option, i) => {
                                const selected = () => mcpWizardOptionIndex() === i();
                                return (
                                  <text
                                    fg={selected() ? theme.accent : theme.fg}
                                    attributes={selected() ? BOLD : 0}
                                  >
                                    {selected() ? "▶ " : "  "}{option}
                                  </text>
                                );
                              }}
                            </For>
                          </box>
                        )}
                      </Show>
                      <Show when={s().id === "authMode"}>
                        <text fg={theme.muted}>oauth opens a browser login; tokens are stored separately from server config</text>
                      </Show>
                      <Show when={s().id === "token"}>
                        <text fg={theme.muted}>Stored as Authorization header on this server entry</text>
                      </Show>
                      <Show when={s().id === "oauthClientId" || s().id === "oauthClientSecret" || s().id === "oauthScopes"}>
                        <text fg={theme.muted}>Optional — skip with Enter if your provider uses dynamic registration</text>
                      </Show>
                    </>
                  )}
                </Show>
                <text fg={theme.muted}>
                  Configuration is saved automatically
                </text>
              </box>
            );
          }}
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
                  <Index each={[...pickerModels()]}>
                    {(model, i) => {
                      const selected = () => (p() as { phase: "model"; index: number }).index === i;
                      const isCurrent = () => model() === state().meta.model;
                      const providerId = () => state().meta.provider ?? activeProviderId();
                      const pricingLabel = () =>
                        formatModelPricingLabel(
                          resolveDisplayModelPricing(
                            model(),
                            providerId(),
                            modelPricing,
                          ),
                        );
                      const contextLabel = () => formatContextWindowLabel(modelContextWindows()[model()]);
                      return (
                        <box id={`model-row-${i}`} flexDirection="row">
                          <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                            {selected() ? "▶ " : "  "}{model()}
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
                  </Index>
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
                <Index each={APPROVAL_MODES}>
                  {(mode, i) => {
                    const selected = () => (p() as { phase: "mode"; index: number }).index === i;
                    const isCurrent = () => mode() === (coerceApprovalMode(state().meta.approval) ?? "normal");
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{APPROVAL_MODE_LABELS[mode()]}
                        </text>
                        <Show when={isCurrent()}>
                          <text fg={theme.secondary}>  (current)</text>
                        </Show>
                      </box>
                    );
                  }}
                </Index>
              </Show>

              <Show when={p().phase === "settings"}>
                <text fg={theme.secondary}>
                  Subagent workspace above. Task model rows below optionally pin a model per role for {roleProviderId()}.
                </text>
                <For each={SETTINGS_ITEMS}>
                  {(item, i) => {
                    const selected = () => (p() as { phase: "settings"; index: number }).index === i();
                    const cfg = () => loadConfig();
                    const sessionMode = () => liveSessionIsolation(state());
                    const label = () =>
                      item.kind === "mcp"
                        ? "MCP servers"
                        : item.kind === "e2b"
                        ? "E2B API key"
                        : item.kind === "exa"
                          ? "Exa API key"
                          : item.kind === "isolation"
                            ? "Serial subagents (task)"
                            : item.kind === "session-isolation"
                              ? "Parent workspace"
                              : item.kind === "parallel-info"
                                ? "Parallel subagents"
                                : item.kind === "telemetry-capture"
                                  ? "Telemetry content capture"
                                  : item.label;
                    const value = () =>
                      item.kind === "mcp"
                        ? `${mcpServers().length} configured`
                        : item.kind === "e2b"
                        ? (hasE2BApiKey() ? "configured" : "not configured")
                        : item.kind === "exa"
                          ? (hasExaApiKey() ? "configured" : "not configured")
                          : item.kind === "isolation"
                            ? effectiveSerialSubagentMenuValue(sessionMode(), cfg().subagent.isolation)
                            : item.kind === "session-isolation"
                              ? parentWorkspaceMenuValue(
                                  sessionMode(),
                                  state().meta.branch,
                                  state().meta.cwd,
                                )
                              : item.kind === "parallel-info"
                                ? PARALLEL_SUBAGENT_MENU_VALUE
                                : item.kind === "telemetry-capture"
                                  ? (cfg().telemetry.otel.captureContent ? "on" : "off")
                                  : (() => {
                                      const pin = cfg().models.providers?.[roleProviderId()]?.[item.slot]?.trim();
                                      return pin || resolveProviderSlot(roleProviderId(), item.slot);
                                    })();
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

              <Show when={p().phase === "settings-session-isolation"}>
                <text fg={theme.secondary}>Parent agent — where your edits land</text>
                <Index each={SESSION_ISOLATION_MODES}>
                  {(mode, i) => {
                    const selected = () =>
                      (p() as { phase: "settings-session-isolation"; index: number }).index === i;
                    const isCurrent = () => mode() === (loadConfig().session?.isolation ?? "shared");
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{SESSION_ISOLATION_LABELS[mode()]}
                        </text>
                        <Show when={isCurrent()}>
                          <text fg={theme.secondary}>  (current)</text>
                        </Show>
                      </box>
                    );
                  }}
                </Index>
              </Show>

              <Show when={p().phase === "settings-isolation"}>
                <text fg={theme.secondary}>{serialSubagentPaletteHeader("shared")}</text>
                <Index each={ISOLATION_MODES}>
                  {(mode, i) => {
                    const selected = () => (p() as { phase: "settings-isolation"; index: number }).index === i;
                    const isCurrent = () => mode() === loadConfig().subagent.isolation;
                    return (
                      <box flexDirection="row">
                        <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                          {selected() ? "▶ " : "  "}{ISOLATION_LABELS[mode()]}
                        </text>
                        <Show when={isCurrent()}>
                          <text fg={theme.secondary}>  (current)</text>
                        </Show>
                      </box>
                    );
                  }}
                </Index>
              </Show>

              <Show when={p().phase === "settings-serial-info"}>
                <text fg={theme.secondary}>{serialSubagentPaletteHeader("worktree")}</text>
                <text fg={theme.fg}>  Enter to return</text>
              </Show>

              <Show when={p().phase === "settings-parallel-info"}>
                <text fg={theme.secondary}>{PARALLEL_SUBAGENT_INFO}</text>
                <text fg={theme.fg}>  Enter to return</text>
              </Show>

              <Show when={p().phase === "settings-model-slot"}>
                <text fg={theme.secondary}>
                  {(p() as { phase: "settings-model-slot"; slot: ModelSlot }).slot} — pick a model for {roleProviderId()}, or default to use the provider default
                </text>
                <scrollbox
                  ref={modelListScrollRef}
                  height={Math.min(modelSlotList().length, MODEL_LIST_MAX_VISIBLE)}
                  scrollY
                  contentOptions={{ flexDirection: "column" }}
                >
                  <Index each={modelSlotList()}>
                    {(model, i) => {
                      const sp = () => p() as { phase: "settings-model-slot"; index: number; slot: ModelSlot };
                      const selected = () => sp().index === i;
                      const providerId = () => roleProviderId();
                      const override = () => loadConfig().models.providers?.[providerId()]?.[sp().slot]?.trim() ?? "";
                      const isCurrent = () =>
                        model() === MODEL_SLOT_DEFAULT ? override() === "" : model() === override();
                      const pricingLabel = () =>
                        model() === MODEL_SLOT_DEFAULT
                          ? ""
                          : formatModelPricingLabel(
                              resolveDisplayModelPricing(model(), providerId(), modelPricing),
                            );
                      const contextLabel = () =>
                        model() === MODEL_SLOT_DEFAULT
                          ? ""
                          : formatContextWindowLabel(modelContextWindows()[model()]);
                      return (
                        <box id={`model-row-${i}`} flexDirection="row">
                          <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                            {selected() ? "▶ " : "  "}{model()}
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
                  </Index>
                </scrollbox>
              </Show>

              <Show when={p().phase === "mcp"}>
                <Show
                  when={(p() as McpPaletteState).menu === "list"}
                  fallback={
                    <Show
                      when={(p() as McpPaletteState).menu === "detail"}
                      fallback={
                        <Show when={(p() as McpPaletteState).selectedName}>
                          {(name) => (
                            <box flexDirection="column">
                              <text fg={theme.toolError} attributes={BOLD}>delete MCP server</text>
                              <text fg={theme.fg} attributes={BOLD}>{name()}</text>
                              <text fg={theme.secondary}>  This removes the server and disconnects it.</text>
                            </box>
                          )}
                        </Show>
                      }
                    >
                      <Show when={(p() as McpPaletteState).selectedName}>
                        {(name) => {
                          const server = () =>
                            (p() as McpPaletteState).servers.find((s) => s.name === name());
                          return (
                            <Show when={server()}>
                              {(s) => (
                                <box flexDirection="column">
                                  <Index each={mcpServerDetailLines(s())}>
                                    {(line) => <text fg={theme.secondary}>{line()}</text>}
                                  </Index>
                                </box>
                              )}
                            </Show>
                          );
                        }}
                      </Show>
                    </Show>
                  }
                >
                  <scrollbox
                    height={Math.min(mcpPaletteRows().length, MCP_LIST_MAX_VISIBLE)}
                    scrollY
                    contentOptions={{ flexDirection: "column" }}
                  >
                    <For each={mcpPaletteRows()}>
                      {(row, i) => {
                        const selected = () => (p() as McpPaletteState).index === i();
                        return (
                          <box flexDirection="row">
                            <text fg={selected() ? theme.accent : theme.fg} attributes={selected() ? BOLD : 0}>
                              {selected() ? "▶ " : "  "}{mcpListRowLabel(row)}
                            </text>
                          </box>
                        );
                      }}
                    </For>
                  </scrollbox>
                </Show>
              </Show>

              <Show when={p().phase === "skills"}>
                <Show
                  when={(p() as SkillsPaletteState).menu === "list"}
                  fallback={
                    <Show when={selectedSkill(p() as SkillsPaletteState)}>
                      {(skill) => {
                        const version = () => (skill().version ? `  v${skill().version}` : "");
                        return (
                          <box flexDirection="column">
                            <box flexDirection="row">
                              <text fg={theme.fg} attributes={BOLD}>{skill().name}</text>
                              <text fg={theme.secondary}>  {skillScopeLabel(skill())}{version()}</text>
                            </box>
                            <text fg={theme.secondary}>  {skill().description}</text>
                            <text fg={theme.muted}>  {skill().path}</text>
                          </box>
                        );
                      }}
                    </Show>
                  }
                >
                  <scrollbox
                    ref={skillsListScrollRef}
                    height={SKILLS_LIST_MAX_VISIBLE}
                    scrollY
                    contentOptions={{ flexDirection: "column" }}
                  >
                    <For each={(p() as SkillsPaletteState).skills}>
                      {(skill, i) => {
                        const sp = () => p() as SkillsPaletteState;
                        const selected = () => sp().index === i();
                        const version = () => (skill.version ? `  v${skill.version}` : "");
                        const nameColWidth = () =>
                          Math.max(...sp().skills.map((s) => s.name.length)) + 4;
                        return (
                          <box id={`skill-row-${i()}`} flexDirection="row">
                            <text
                              fg={selected() ? theme.accent : theme.fg}
                              attributes={selected() ? BOLD : 0}
                              minWidth={nameColWidth()}
                              flexShrink={0}
                              wrapMode="none"
                            >
                              {selected() ? "▶ " : "  "}{skill.name}
                            </text>
                            <text fg={theme.secondary} flexGrow={1} wrapMode="word">
                              {skillScopeLabel(skill)}{version()}  {skill.description}
                            </text>
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
                    : p().phase === "skills"
                        ? skillsPaletteHint((p() as SkillsPaletteState).menu)
                        : p().phase === "mcp"
                          ? mcpPaletteHint(
                              (p() as McpPaletteState).menu,
                              (p() as McpPaletteState).selectedName
                                ? (p() as McpPaletteState).servers.find(
                                    (s) => s.name === (p() as McpPaletteState).selectedName,
                                  )
                                : undefined,
                            )
                        : "↑↓ navigate · Enter select · Esc back"}
                </text>
              </box>
            </box>
          )}
        </Show>

        <box flexDirection="row">
          <text fg={state().phase === "input" && !submitting() ? theme.accent : theme.secondary} attributes={BOLD}>› </text>
          <input
            ref={inputRef}
            flexGrow={1}
            focused={inputFocused()}
            textColor={theme.fg}
            focusedTextColor={theme.fg}
            backgroundColor={theme.bg}
            focusedBackgroundColor={theme.bg}
            onInput={handleInput}
            onSubmit={() => void handleSubmit(inputRef?.value ?? "")}
          />
        </box>
        <box flexDirection="row">
          <Show when={state().phase === "running"}>
            <text fg={theme.toolRunning}>{spinnerFrame()} </text>
            <Show when={runningElapsedLabel()}>
              <text fg={theme.muted}>{runningElapsedLabel()} · </text>
            </Show>
          </Show>
          <text fg={theme.muted}>{footerHint()}</text>
        </box>
      </box>
        </box>

        <Show when={sidebarVisibility().right}>
          <InfoSidebar
            model={state().meta.model}
            approval={state().meta.approval}
            cwd={state().meta.cwd}
            branch={state().meta.branch}
            sessionIsolation={state().meta.sessionIsolation}
            provider={state().meta.provider}
            sandbox={state().meta.sandbox}
            costUsd={state().meta.costUsd}
            tokenTotals={state().meta.tokenTotals}
            contextTokens={state().meta.contextTokens}
            contextWindow={state().meta.contextWindow}
            faux={state().meta.faux}
            todos={state().todos}
            phase={state().phase}
          />
        </Show>
      </box>
    </box>
    </ToolExpandProvider>
  );
}
