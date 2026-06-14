import { Box, Text } from "ink";
import { theme } from "./theme.js";

function diffColor(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return theme.diffMeta;
  if (line.startsWith("@@")) return theme.muted;
  if (line.startsWith("+")) return theme.diffAdd;
  if (line.startsWith("-")) return theme.diffDel;
  return theme.diffContext;
}

export function DiffView({ patch }: { patch: string }) {
  const lines = patch.split("\n").filter((line, i, arr) => {
    if (i === arr.length - 1 && line === "") return false;
    return true;
  });

  return (
    <Box flexDirection="column" marginLeft={2} marginY={0} paddingX={1} backgroundColor={theme.codeBg}>
      {lines.map((line, i) => (
        <Text key={i} bold={line.startsWith("+") || line.startsWith("-")} color={diffColor(line)}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
