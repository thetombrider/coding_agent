import { createContext, createSignal, useContext, type ParentProps } from "solid-js";
import { formatHoverExpandFooter } from "./tool-output.js";

interface ToolTarget {
  label: string;
  getOutput: () => string | undefined;
  isExpanded: () => boolean;
}

export interface ToolExpandContextValue {
  registerToggle: (id: string, toggle: (() => void) | null) => void;
  registerCopyTarget: (id: string, target: ToolTarget | null) => void;
  setHovered: (id: string) => void;
  toggleHovered: () => void;
  getHoveredOutput: () => string | undefined;
  getHoveredExpandedOutput: () => string | undefined;
  getHoverFooterHint: () => string | null;
  isExpanded: (id: string) => boolean;
  setExpanded: (id: string, expanded: boolean) => void;
}

const ToolExpandContext = createContext<ToolExpandContextValue>();

export function createToolExpandState(): ToolExpandContextValue {
  const toggles = new Map<string, () => void>();
  const targets = new Map<string, ToolTarget>();
  const expandedStates = new Map<string, boolean>();
  const [hoveredId, setHoveredId] = createSignal<string | null>(null);
  const [footerRevision, setFooterRevision] = createSignal(0);

  return {
    registerToggle(id, toggle) {
      if (toggle) toggles.set(id, toggle);
      else toggles.delete(id);
    },
    registerCopyTarget(id, target) {
      if (target) targets.set(id, target);
      else targets.delete(id);
    },
    setHovered(id) {
      setHoveredId(id);
    },
    toggleHovered() {
      const id = hoveredId();
      if (id && toggles.has(id)) {
        toggles.get(id)?.();
        return;
      }
      const last = [...toggles.keys()].at(-1);
      if (last) toggles.get(last)?.();
    },
    getHoveredOutput() {
      const id = hoveredId();
      if (!id) return undefined;
      return targets.get(id)?.getOutput();
    },
    getHoveredExpandedOutput() {
      const id = hoveredId();
      if (!id) return undefined;
      const target = targets.get(id);
      if (!target?.isExpanded()) return undefined;
      return target.getOutput();
    },
    getHoverFooterHint() {
      footerRevision();
      const id = hoveredId();
      if (!id) return null;
      const target = targets.get(id);
      if (!target) return null;
      const expanded = expandedStates.get(id) ?? target.isExpanded();
      return formatHoverExpandFooter(
        target.label,
        target.getOutput(),
        expanded,
      );
    },
    isExpanded(id) {
      return expandedStates.get(id) ?? false;
    },
    setExpanded(id, expanded) {
      expandedStates.set(id, expanded);
      setFooterRevision((n) => n + 1);
    },
  };
}

export function ToolExpandProvider(props: ParentProps<{ value: ToolExpandContextValue }>) {
  return (
    <ToolExpandContext.Provider value={props.value}>
      {props.children}
    </ToolExpandContext.Provider>
  );
}

export function useToolExpand(): ToolExpandContextValue | undefined {
  return useContext(ToolExpandContext);
}
