import { describe, expect, it } from "vitest";
import { testRender } from "@opentui/solid";
import { ApprovalBar } from "./views.js";
import { theme } from "./theme.js";

function approvalLayout() {
  return (
    <box flexDirection="column" width="100%" height={12} backgroundColor={theme.bg}>
      <box flexGrow={1} flexShrink={1} />
      <ApprovalBar name="edit" args={{ path: "src/agent/events.ts" }} />
      <box flexShrink={0} height={2} border={["top"]} borderColor={theme.border}>
        <text fg={theme.fg}>input</text>
      </box>
    </box>
  );
}

function findApprovalTextLine(frame: string): { index: number; line: string } {
  const lines = frame.split("\n");
  const index = lines.findIndex((line) => line.includes("allow edit?"));
  if (index < 0) throw new Error(`approval text not found in frame:\n${frame}`);
  return { index, line: lines[index]! };
}

describe("ApprovalBar layout", () => {
  it("keeps the border on separate rows under flex pressure", async () => {
    const setup = await testRender(approvalLayout, { width: 80, height: 12 });
    await setup.renderOnce();
    await setup.flush();

    const frame = setup.captureCharFrame();
    const { index, line } = findApprovalTextLine(frame);
    const lines = frame.split("\n");
    const nearby = lines.slice(Math.max(0, index - 3), index + 4);

    // Text sits between side borders, not collapsed with top/bottom corners.
    expect(line).toMatch(/^│.*│$/);
    expect(line).not.toMatch(/╭|╮|╰|╯/);

    // Rounded border rows bracket the padded content block.
    expect(nearby.some((row) => row.includes("╭") && row.includes("╮"))).toBe(true);
    expect(nearby.some((row) => row.includes("╰") && row.includes("╯"))).toBe(true);
  });
});
