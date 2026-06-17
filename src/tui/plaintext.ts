import type { SessionState, ToolEntry, Turn } from "./controller.js";
import { toolSummary } from "./views.js";

export function toolEntryToPlainText(entry: ToolEntry): string {
  const header = `${entry.name}${toolSummary(entry.name, entry.args) ? `  ${toolSummary(entry.name, entry.args)}` : ""}`;
  if (!entry.output) return header;
  return `${header}\n${entry.output}`;
}

export function turnToPlainText(turn: Turn): string {
  const parts: string[] = [];
  if (turn.userText) parts.push(`you: ${turn.userText}`);
  if (turn.reasoningText) parts.push(`thinking:\n${turn.reasoningText}`);
  for (const tool of turn.tools) {
    parts.push(toolEntryToPlainText(tool));
  }
  if (turn.assistantText) parts.push(turn.assistantText);
  return parts.join("\n\n");
}

export function liveTurnFromState(state: SessionState): Turn | null {
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

export function allTurnsFromState(state: SessionState): Turn[] {
  const turns = [...state.completedTurns];
  const live = liveTurnFromState(state);
  if (live) turns.push(live);
  return turns;
}

export function sessionToPlainText(state: SessionState): string {
  return allTurnsFromState(state)
    .map(turnToPlainText)
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function pickFocusedCopyText(
  state: SessionState,
  hoveredToolOutput?: string,
): string | null {
  if (hoveredToolOutput) return hoveredToolOutput;

  const live = liveTurnFromState(state);
  if (live?.assistantText) return live.assistantText;
  if (live?.reasoningText) return live.reasoningText;

  for (let t = state.completedTurns.length - 1; t >= 0; t--) {
    const turn = state.completedTurns[t]!;
    if (turn.assistantText) return turn.assistantText;
    if (turn.reasoningText) return turn.reasoningText;
  }

  const turns = allTurnsFromState(state);
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t]!;
    for (let i = turn.tools.length - 1; i >= 0; i--) {
      const tool = turn.tools[i]!;
      if (tool.output) return toolEntryToPlainText(tool);
    }
  }

  return null;
}
