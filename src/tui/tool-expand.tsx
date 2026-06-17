import { createContext, useContext, type ParentProps } from "solid-js";

interface ToolTarget {
  getOutput: () => string | undefined;
  isExpanded: () => boolean;
}

export interface ToolExpandContextValue {
  registerToggle: (id: string, toggle: (() => void) | null) => void;
  registerCopyTarget: (
    id: string,
    target: { getOutput: () => string | undefined; isExpanded: () => boolean } | null,
  ) => void;
  setHovered: (id: string) => void;
  toggleHovered: () => void;
  getHoveredOutput: () => string | undefined;
  getHoveredExpandedOutput: () => string | undefined;
}

const ToolExpandContext = createContext<ToolExpandContextValue>();

export function createToolExpandState(): ToolExpandContextValue {
  const toggles = new Map<string, () => void>();
  const targets = new Map<string, ToolTarget>();
  let hoveredId: string | null = null;

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
      hoveredId = id;
    },
    toggleHovered() {
      if (hoveredId && toggles.has(hoveredId)) {
        toggles.get(hoveredId)?.();
        return;
      }
      const last = [...toggles.keys()].at(-1);
      if (last) toggles.get(last)?.();
    },
    getHoveredOutput() {
      if (!hoveredId) return undefined;
      return targets.get(hoveredId)?.getOutput();
    },
    getHoveredExpandedOutput() {
      if (!hoveredId) return undefined;
      const target = targets.get(hoveredId);
      if (!target?.isExpanded()) return undefined;
      return target.getOutput();
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
