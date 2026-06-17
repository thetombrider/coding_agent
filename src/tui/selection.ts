type SelectionSource = {
  hasSelection: boolean;
  getSelection: () => { getSelectedText: () => string } | null;
};

/** Return trimmed selected text from the OpenTUI renderer, if any. */
export function readRendererSelection(renderer: SelectionSource): string | null {
  if (!renderer.hasSelection) return null;
  const text = renderer.getSelection()?.getSelectedText() ?? "";
  const trimmed = text.trim();
  return trimmed.length > 0 ? text : null;
}
