/** Shared UI class strings on the black and white tokens (buttons, inputs, panels, notices, focus ring). */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
const button =
  "inline-flex h-10 items-center justify-center rounded-none px-5 font-display text-sm font-medium uppercase tracking-wider transition-opacity disabled:pointer-events-none disabled:opacity-40";
export const primaryButton = `${button} bg-ink text-paper hover:opacity-85 ${focusRing}`;
export const secondaryButton = `${button} border border-line-strong bg-transparent text-ink hover:border-ink ${focusRing}`;
export const dangerButton = `${button} border border-danger bg-transparent text-danger hover:bg-danger hover:text-paper ${focusRing}`;
export const inputClass = `mt-1 w-full rounded-none border border-line-strong bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:border-ink ${focusRing}`;
export const panelClass = `mt-8 rounded-none border border-line bg-surface p-6 ${focusRing}`;
export const noticeClass = `rounded-none border border-line-strong bg-surface px-4 py-3 text-sm text-ink ${focusRing}`;
