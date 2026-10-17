export type StdFont = "Helvetica" | "Helvetica-Bold" | "Times-Roman" | "Courier";
export type Anchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface TextStampSpec {
  template: string;
  font: StdFont;
  size: number;
  color: [number, number, number];
  opacity: number;
  anchor: Anchor;
  marginX: number;
  marginY: number;
  /** Visible-space baseline origin [x, y] in points; overrides anchor and margins. */
  at?: [number, number];
  /** 1-based page this text goes on, regardless of `pages`. */
  page?: number;
}

export interface ImageStampSpec {
  image:
    | { kind: "rgba"; width: number; height: number; pixels: Uint8Array }
    | { kind: "jpeg"; bytes: Uint8Array };
  page: number;
  rect: [number, number, number, number];
  opacity: number;
}

export interface StampJobSpec {
  pages: number[] | "all";
  texts: TextStampSpec[];
  images: ImageStampSpec[];
  numberStart: number;
  bates?: { prefix: string; suffix: string; start: number; digits: number };
}

/**
 * Substitute the JS-side tokens {date} and {filename}; {n}, {total}, {bates} are left for Rust.
 * Braces inside the substituted values are doubled, which the engine prints as literal braces,
 * so a file named "report {n}.pdf" is not renumbered.
 */
export function substituteJsTokens(template: string, ctx: { date: string; filename: string }): string {
  return template.replace(/\{(date|filename)\}/g, (_, key: "date" | "filename") => ctx[key].replace(/[{}]/g, "$&$&"));
}

/**
 * JS mirror of the engine's token pass: `{{` and `}}` become literal braces, `{n}` and `{total}`
 * are replaced, any other brace is kept as is. Used for on-screen previews only.
 */
export function resolveEngineTokens(template: string, n: number, total: number): string {
  return template.replace(/\{\{|\}\}|\{n\}|\{total\}/g, (m) =>
    m === "{{" ? "{" : m === "}}" ? "}" : m === "{n}" ? String(n) : String(total),
  );
}

/** Shape sent to the WASM binding: a plain object copy so optional `bates` is simply absent. */
export function toWasmJob(job: StampJobSpec): StampJobSpec {
  const { bates, ...rest } = job;
  return bates ? { ...rest, bates } : rest;
}
