import type { ScrollBoxRenderable } from "@opentui/core";
import { createTextAttributes } from "@opentui/core";
import { For, Show } from "solid-js";
import type { SessionSummary } from "../session/log.js";
import { formatSessionCost } from "./views.js";
import { theme } from "./theme.js";
import { SESSION_SIDEBAR_WIDTH } from "./sidebar-state.js";

const BOLD = createTextAttributes({ bold: true });

export type SessionsSidebarMenu = "list" | "delete";

export function sessionsSidebarHint(menu: SessionsSidebarMenu, focused: boolean): string {
  if (!focused) return "Tab sessions · ↑↓ scroll";
  return menu === "delete"
    ? "Enter delete · ← or Esc cancel"
    : "↑↓ navigate · → delete · Enter resume · Esc unfocus";
}

export function SessionsSidebar(props: {
  sessions: SessionSummary[];
  index: number;
  menu: SessionsSidebarMenu;
  activeSessionId: string;
  focused: boolean;
  formatDate: (ts: string) => string;
  scrollRef?: (ref: ScrollBoxRenderable | undefined) => void;
}) {
  const selected = () => props.sessions[props.index];

  return (
    <box
      flexShrink={0}
      width={SESSION_SIDEBAR_WIDTH}
      flexDirection="column"
      marginRight={1}
      paddingRight={1}
      border={["right"]}
      borderColor={props.focused ? theme.accent : theme.border}
      backgroundColor={theme.codeBg}
    >
      <text selectable={false} fg={theme.muted} attributes={BOLD}>
        sessions
      </text>

      <Show
        when={props.sessions.length > 0}
        fallback={<text selectable={false} fg={theme.secondary}>none yet</text>}
      >
        <Show
          when={props.menu === "list"}
          fallback={
            <Show when={selected()}>
              {(session) => {
                const date = () => props.formatDate(session().lastTs || session().createdAt);
                const turns = () => `${session().turns} turn${session().turns !== 1 ? "s" : ""}`;
                const active = () => session().sessionId === props.activeSessionId;
                return (
                  <box flexDirection="column" marginTop={0}>
                    <text fg={theme.toolError} attributes={BOLD}>delete</text>
                    <text fg={theme.fg} attributes={BOLD}>
                      {date()}  {session().sessionId}
                    </text>
                    <text fg={theme.secondary} wrapMode="word">
                      {turns()}  {formatSessionCost(session().costUsd)}
                    </text>
                    <text fg={theme.secondary} wrapMode="word">{session().cwd}</text>
                    <Show when={active()}>
                      <text fg={theme.secondary}>active — cannot delete</text>
                    </Show>
                  </box>
                );
              }}
            </Show>
          }
        >
          <scrollbox
            ref={props.scrollRef}
            flexGrow={1}
            minHeight={0}
            scrollY
            contentOptions={{ flexDirection: "column" }}
          >
            <For each={props.sessions}>
              {(session, i) => {
                const isSelected = () => props.index === i();
                const date = () => props.formatDate(session.lastTs || session.createdAt);
                const turns = () => `${session.turns} turn${session.turns !== 1 ? "s" : ""}`;
                const active = () => session.sessionId === props.activeSessionId;
                return (
                  <box id={`session-row-${i()}`} flexDirection="column" marginTop={i() === 0 ? 0 : 1}>
                    <text
                      fg={isSelected() ? theme.accent : theme.fg}
                      attributes={isSelected() ? BOLD : 0}
                      wrapMode="word"
                    >
                      {isSelected() ? "▶ " : "  "}{date()}
                    </text>
                    <text fg={theme.secondary} wrapMode="word">
                      {session.sessionId}
                    </text>
                    <text fg={theme.muted} wrapMode="word">
                      {turns()}  {formatSessionCost(session.costUsd)}
                    </text>
                    <Show when={active()}>
                      <text fg={theme.muted}>active</text>
                    </Show>
                  </box>
                );
              }}
            </For>
          </scrollbox>
        </Show>
      </Show>
    </box>
  );
}
