/** Shell-quote a string for safe interpolation in sh -c commands. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
