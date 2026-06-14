import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function confirmTool(name: string, args: unknown): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const preview = JSON.stringify(args).slice(0, 200);
    const answer = await rl.question(
      `Allow ${name}(${preview}${preview.length >= 200 ? "…" : ""})? [y/N] `,
    );
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
