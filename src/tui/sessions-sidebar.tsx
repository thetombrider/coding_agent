import type { ScrollBoxRenderable } from "@opentui/core";
import { createTextAttributes } from "@opentui/core";
import { For, Show } from "solid-js";
import type { SessionSummary } from "../session/log.js";
import { formatSessionCost } from "./views.js";
import { hiddenNativeScrollbar, theme } from "./theme.js";
import { SESSION_SIDEBAR_WIDTH } from "./sidebar-state.js";
import { SidebarRow, SidebarShell } from "./sidebar-chrome.js";

const BOLD = createTextAttributes({ bold: true });

export type SessionsSidebarMenu = "list" | "delete";

export function sessionsSidebarHint(menu: SessionsSidebarMenu, focused: boolean): string {
  if (!focused) return "Tab or /sessions · browse sessions";
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
    <SidebarShell
      title="sessions"
      width={SESSION_SIDEBAR_WIDTH}
      edge="left"
      focused={props.focused}
    >
      <Show
        when={props.sessions.length > 0}
        fallback={<SidebarRow tone="muted">none yet</SidebarRow>}
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
                  <box flexDirection="column">
                    <text fg={theme.toolError} attributes={BOLD}>delete session</text>
                    <SidebarRow tone="fg">{date()}</SidebarRow>
                    <SidebarRow>{session().sessionId}</SidebarRow>
                    <SidebarRow tone="muted">
                      {turns()} · {formatSessionCost(session().costUsd)}
                    </SidebarRow>
                    <Show when={active()}>
                      <SidebarRow tone="muted">active — cannot delete</SidebarRow>
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
            {...hiddenNativeScrollbar}
          >
            <For each={props.sessions}>
              {(session, i) => {
                const isSelected = () => props.index === i();
                const date = () => props.formatDate(session.lastTs || session.createdAt);
                const turns = () => `${session.turns}t`;
                const active = () => session.sessionId === props.activeSessionId;
                return (
                  <box
                    id={`session-row-${i()}`}
                    flexDirection="column"
                    marginTop={i() === 0 ? 0 : 1}
                    paddingLeft={isSelected() ? 0 : 1}
                  >
                    <text
                      fg={isSelected() ? theme.accent : theme.fg}
                      attributes={isSelected() ? BOLD : 0}
                      wrapMode="word"
                    >
                      {isSelected() ? "▸ " : "  "}{date()}
                    </text>
                    <text
                      fg={isSelected() ? theme.secondary : theme.muted}
                      wrapMode="word"
                    >
                      {session.sessionId}
                    </text>
                    <text fg={theme.muted} wrapMode="word">
                      {turns()} · {formatSessionCost(session.costUsd)}
                      {active() ? " · active" : ""}
                    </text>
                  </box>
                );
              }}
            </For>
          </scrollbox>
        </Show>
      </Show>
    </SidebarShell>
  );
}
