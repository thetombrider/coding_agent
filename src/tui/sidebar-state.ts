export type SidebarVisibility = {
  left: boolean;
  right: boolean;
};

export const SESSION_SIDEBAR_WIDTH = 28;
export const INFO_SIDEBAR_WIDTH = 30;

export const DEFAULT_SIDEBAR_VISIBILITY: SidebarVisibility = {
  left: true,
  right: true,
};

export type PanelTarget = "left" | "right" | "all";

/** Toggle one or both sidebars. */
export function toggleSidebar(
  current: SidebarVisibility,
  target: PanelTarget,
): SidebarVisibility {
  switch (target) {
    case "left":
      return { ...current, left: !current.left };
    case "right":
      return { ...current, right: !current.right };
    case "all":
      return { left: !current.left, right: !current.right };
  }
}

/** Show both sidebars. */
export function showAllSidebars(): SidebarVisibility {
  return { left: true, right: true };
}

/** Hide both sidebars. */
export function hideAllSidebars(): SidebarVisibility {
  return { left: false, right: false };
}

/** Human-readable summary for status hints. */
export function sidebarVisibilityHint(visibility: SidebarVisibility): string {
  const left = visibility.left ? "on" : "off";
  const right = visibility.right ? "on" : "off";
  return `panels: sessions ${left} · info ${right}`;
}
