/** A word with its page box. Page index is 0-based; box is in the visible page space (rotation applied, CropBox origin removed), points, origin bottom-left. */
export interface Word {
  text: string;
  page: number;
  box: { x: number; y: number; w: number; h: number };
}

/** A normalized word. `index` is the position in the flat source word list (empty words are dropped). */
export interface Token {
  text: string;
  index: number;
  page: number;
}

export type OpKind = "equal" | "remove" | "add";

/** Half-open ranges: a[aStart, aEnd) and b[bStart, bEnd). */
export interface Op {
  kind: OpKind;
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export interface TokenRange {
  start: number;
  end: number;
}

export interface PageSpan {
  first: number;
  last: number;
}

export type ChangeKind = "added" | "removed" | "changed";

/** Token ranges index the Token arrays (`aIndex` / `bIndex` of a result map them to flat word indices). */
export interface Change {
  kind: ChangeKind;
  a: TokenRange;
  b: TokenRange;
  aPages: PageSpan | null;
  bPages: PageSpan | null;
  aText: string;
  bText: string;
}

export interface CompareLimits {
  /** Both documents together above this many tokens: per-page diff. */
  maxTokens: number;
  /** Edit distance above this: per-page diff. */
  maxEdits: number;
}

export const DEFAULT_LIMITS: CompareLimits = { maxTokens: 200_000, maxEdits: 20_000 };

export interface CompareStats {
  aTokens: number;
  bTokens: number;
  added: number;
  removed: number;
  changed: number;
  /** Tokens removed plus tokens added. */
  edits: number;
}

export interface CompareResult {
  changes: Change[];
  mode: "document" | "per-page";
  stats: CompareStats;
  /** Token index -> flat word index, per side. */
  aIndex: number[];
  bIndex: number[];
}
