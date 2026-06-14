import { Box, Text } from "ink";

function diffColor(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return "gray";
  if (line.startsWith("@@")) return "cyan";
  if (line.startsWith("+")) return "green";
  if (line.startsWith("-")) return "red";
  return undefined;
}

export function DiffView({ patch }: { patch: string }) {
  const lines = patch.split("\n").filter((line, i, arr) => {
    if (i === arr.length - 1 && line === "") return false;
    return true;
  });

  return (
    <Box flexDirection="column" marginLeft={2}>
      {lines.map((line, i) => (
        <Text key={i} color={diffColor(line)}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
