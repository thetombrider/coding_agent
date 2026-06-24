import type { Message } from "../types.js";
import type { ToolEntry, Turn, TurnBlock } from "./controller.js";

function textFromMessage(msg: Message): string {
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

interface TurnBuilder {
  userText: string;
  assistantText: string;
  reasoningText: string;
  tools: ToolEntry[];
  toolById: Map<string, ToolEntry>;
  blocks: TurnBlock[];
}

function startTurn(userText: string): TurnBuilder {
  return { userText, assistantText: "", reasoningText: "", tools: [], toolById: new Map(), blocks: [] };
}

function finishTurn(builder: TurnBuilder): Turn {
  return {
    userText: builder.userText,
    assistantText: builder.assistantText,
    reasoningText: builder.reasoningText || undefined,
    tools: builder.tools,
    blocks: builder.blocks,
  };
}

/** Convert a flat message list into displayable turns for the controller. */
export function messagesToTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let current: TurnBuilder | null = null;

  const finalizeCurrent = () => {
    if (!current) return;
    turns.push(finishTurn(current));
    current = null;
  };

  for (const msg of messages) {
    if (msg.role === "user") {
      finalizeCurrent();
      current = startTurn(textFromMessage(msg));
      continue;
    }

    if (!current) continue;

    if (msg.role === "assistant") {
      let pendingReasoning = "";
      for (const block of msg.content) {
        if (block.type === "reasoning") {
          pendingReasoning += block.text;
        } else if (block.type === "text") {
          current.assistantText += block.text;
        } else if (block.type === "toolCall" && !current.toolById.has(block.id)) {
          if (pendingReasoning) {
            current.reasoningText += pendingReasoning;
            current.blocks.push({ type: "reasoning", id: `replay-${current.blocks.length}`, text: pendingReasoning });
            pendingReasoning = "";
          }
          const entry: ToolEntry = {
            id: block.id,
            name: block.name,
            args: block.arguments,
            status: "done",
          };
          current.tools.push(entry);
          current.toolById.set(block.id, entry);
          current.blocks.push({ type: "tool", entry });
        }
      }
      if (pendingReasoning) {
        current.reasoningText += pendingReasoning;
        current.blocks.push({ type: "reasoning", id: `replay-${current.blocks.length}`, text: pendingReasoning });
      }
      continue;
    }

    if (msg.role === "tool") {
      for (const block of msg.content) {
        if (block.type !== "toolResult") continue;
        const existing = current.toolById.get(block.toolCallId);
        if (existing) {
          existing.output = block.output;
          existing.status = block.isError ? "error" : "done";
          continue;
        }
        const entry: ToolEntry = {
          id: block.toolCallId,
          name: "tool",
          args: {},
          status: block.isError ? "error" : "done",
          output: block.output,
        };
        current.tools.push(entry);
        current.toolById.set(block.toolCallId, entry);
      }
    }
  }

  finalizeCurrent();
  return turns;
}
