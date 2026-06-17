import { createContext, useContext, type ParentProps } from "solid-js";

export interface ToolExpandContextValue {
  registerToggle: (id: string, toggle: (() => void) | null) => void;
  setHovered: (id: string) => void;
  toggleHovered: () => void;
}

const ToolExpandContext = createContext<ToolExpandContextValue>();

export function createToolExpandState(): ToolExpandContextValue {
  const toggles = new Map<string, () => void>();
  let hoveredId: string | null = null;

  return {
    registerToggle(id, toggle) {
      if (toggle) toggles.set(id, toggle);
      else toggles.delete(id);
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
