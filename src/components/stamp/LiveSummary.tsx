import { useDebouncedValue } from "../../hooks/useDebouncedValue";

/** Pause after the last change before a screen reader hears the new summary. */
const SPEAK_DELAY_MS = 600;

/**
 * A settings summary: shown as it changes, but announced to screen readers only once typing has
 * paused, so every keystroke in a field does not interrupt with a new announcement.
 */
export default function LiveSummary({ text, className }: { text: string; className?: string }) {
  const spoken = useDebouncedValue(text, SPEAK_DELAY_MS);
  return (
    <>
      <p className={className} data-testid="settings-summary">{text}</p>
      <p className="sr-only" aria-live="polite">{spoken}</p>
    </>
  );
}
