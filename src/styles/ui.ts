/** Shared UI class strings on the black and white tokens (buttons, inputs, panels, notices, focus ring). */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
const buttonShape =
  "inline-flex items-center justify-center rounded-none font-display text-sm font-medium uppercase tracking-wider transition-opacity disabled:pointer-events-none disabled:opacity-40";
const button = `${buttonShape} h-10 px-5`;
export const primaryButton = `${button} bg-ink text-paper hover:opacity-85 ${focusRing}`;
/** The primary button one size up (drop zones). `onInk`: paper face, for when its container turns ink. */
export const primaryButtonLarge = (onInk = false) =>
  `${buttonShape} h-12 px-8 ${onInk ? "bg-paper text-ink" : "bg-ink text-paper"} hover:opacity-85 ${focusRing}`;
export const secondaryButton = `${button} border border-line-strong bg-transparent text-ink hover:border-ink ${focusRing}`;
export const dangerButton = `${button} border border-danger bg-transparent text-danger hover:bg-danger hover:text-paper ${focusRing}`;
export const inputClass = `mt-1 w-full rounded-none border border-line-strong bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:border-ink ${focusRing}`;
export const panelClass = `mt-8 rounded-none border border-line bg-surface p-6 ${focusRing}`;
export const noticeClass = `rounded-none border border-line-strong bg-surface px-4 py-3 text-sm text-ink ${focusRing}`;
/** Compact button for dense side panels (properties, marks): same Oswald uppercase voice as the other buttons. */
export const smallButton = `flex items-center justify-center gap-1 rounded-none border border-line-strong px-2 py-1.5 font-display text-xs font-medium uppercase tracking-wider text-ink hover:border-ink disabled:pointer-events-none disabled:opacity-40 ${focusRing}`;
/** Mono uppercase micro-label for counts, sizes, steps and file meta. */
export const monoLabel = "font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2";
/** A selected thumbnail or card: 2 px ink outline (pair it with a `Check` badge and aria state). */
export const selectedOutline = "outline outline-2 outline-ink";
/** Toggle chip (format, scale, language, layout): hairline when off, filled ink when on. Pair with aria-pressed. */
export const chipClass = (on: boolean) =>
  `inline-flex h-9 items-center justify-center rounded-none border px-4 text-sm transition-opacity disabled:pointer-events-none disabled:opacity-40 ${focusRing} ${
    on ? "border-ink bg-ink text-paper" : "border-line-strong bg-transparent text-ink hover:border-ink"
  }`;
/** An icon button filling a cell of a card's bottom action bar (merge, organize, images to PDF). */
// The ring is drawn inset: an outset ring is covered by the next cell and clipped by overflow-hidden cards.
export const cellButton = `flex flex-1 items-center justify-center text-ink-2 hover:bg-ink hover:text-paper disabled:pointer-events-none disabled:opacity-30 ${focusRing} focus-visible:ring-inset focus-visible:!ring-offset-0`;
/** Square checkbox / radio drawn in ink. */
export const checkClass = `h-4 w-4 shrink-0 rounded-none accent-ink ${focusRing}`;
/** Text link inside copy. */
export const linkClass = `font-medium text-ink underline decoration-1 underline-offset-4 hover:opacity-70 ${focusRing}`;
/** File name and page count line ("report.pdf, 4 pages"): mono like the labels, but keeps the name's case. */
export const fileMeta = "font-mono text-xs tracking-[0.02em] text-ink-2";
