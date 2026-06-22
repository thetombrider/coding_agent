/**
 * Hard cap on bytes captured from a single shell command. Beyond this the
 * workspace stops forwarding output and terminates the child (see
 * WorkspaceExecOptions.maxBuffer), bounding both memory and the context growth
 * that was exhausting explore subagents (#146, #183).
 */
export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;

/** Marker appended to command output that was cut short by the byte cap. */
export function truncationNote(bytes: number): string {
  return (
    `\n\n[output truncated at ${bytes} bytes — the command produced more. `
    + "Narrow it (add filters, a path, or pipe through head) to see the rest.]"
  );
}
