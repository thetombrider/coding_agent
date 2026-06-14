import { createSignal, onCleanup } from "solid-js";

/** Braille spinner frames, advanced on a global clock. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const [frame, setFrame] = createSignal(0);

/** Current spinner glyph. Reactive — read inside a tracking scope. */
export const spinnerFrame = (): string => FRAMES[frame() % FRAMES.length]!;

/**
 * Drive the global spinner clock for the lifetime of the calling component.
 * Call once (e.g. from the root App); every `spinnerFrame()` reader ticks in sync.
 */
export function useSpinnerClock(intervalMs = 80): void {
  const id = setInterval(() => setFrame((i) => (i + 1) % FRAMES.length), intervalMs);
  onCleanup(() => clearInterval(id));
}
