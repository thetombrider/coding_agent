import type { Message } from "../types.js";

/** Marker so multiple `before_prompt` handlers can merge into one leading injection. */
export const INJECTION_MARKER = "<!-- orin:injected -->";

function isInjectionMessage(message: Message | undefined): message is Message {
  if (!message || message.role !== "user") return false;
  const first = message.content[0];
  return first?.type === "text" && first.text.includes(INJECTION_MARKER);
}

/** Prepend or append to the shared leading injection message (composable across handlers). */
export function injectLeadingContext(messages: Message[], block: string): Message[] {
  const text = block.trim();
  if (!text) return messages;

  if (isInjectionMessage(messages[0])) {
    const first = messages[0].content[0];
    if (first.type !== "text") return messages;
    return [
      {
        role: "user",
        content: [{ type: "text", text: `${first.text}\n\n${text}` }],
      },
      ...messages.slice(1),
    ];
  }

  return [
    {
      role: "user",
      content: [{ type: "text", text: `${INJECTION_MARKER}\n${text}` }],
    },
    ...messages,
  ];
}

export function buildPromptInjectionBlocks(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}
