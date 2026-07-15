import { createTextAttributes } from "@opentui/core";
import type { JSX } from "solid-js";
import { theme } from "./theme.js";

const BOLD = createTextAttributes({ bold: true });

/** Shared chrome for persistent left/right panels — full-height column, panel fill. */
export function SidebarShell(props: {
  title: string;
  width: number;
  edge: "left" | "right";
  focused?: boolean;
  children: JSX.Element;
}) {
  return (
    <box
      flexShrink={0}
      width={props.width}
      flexDirection="column"
      minHeight={0}
      paddingLeft={1}
      paddingRight={1}
      border={props.edge === "left" ? ["right"] : ["left"]}
      borderColor={props.focused ? theme.accent : theme.border}
      backgroundColor={theme.codeBg}
    >
      <text selectable={false} fg={theme.muted} attributes={BOLD}>
        {props.title}
      </text>
      <box flexDirection="column" flexGrow={1} minHeight={0} marginTop={0}>
        {props.children}
      </box>
    </box>
  );
}

/** Muted label for a sidebar metadata row. */
export function SidebarLabel(props: { children: JSX.Element }) {
  return (
    <text selectable={false} fg={theme.muted} attributes={BOLD}>
      {props.children}
    </text>
  );
}

/** Body copy row inside a sidebar. */
export function SidebarRow(props: { tone?: "fg" | "secondary" | "muted"; children: JSX.Element }) {
  const fg = () => {
    switch (props.tone ?? "secondary") {
      case "fg":
        return theme.fg;
      case "muted":
        return theme.muted;
      default:
        return theme.secondary;
    }
  };
  return (
    <text selectable={false} fg={fg()} wrapMode="word">
      {props.children}
    </text>
  );
}
