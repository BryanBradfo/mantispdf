import { groupChanges } from "./changes";
import { diffTokens } from "./diff";
import { tokenize } from "./tokens";
import { DEFAULT_LIMITS, type Change, type CompareLimits, type CompareResult, type Op, type Token, type Word } from "./types";

/** Tokenize page by page: the per-page token ranges come from the input structure, not from Word.page. */
function tokenizePages(pages: Word[][]): { tokens: Token[]; ranges: Array<[number, number]> } {
  const tokens: Token[] = [];
  const ranges: Array<[number, number]> = [];
  let base = 0;
  for (const words of pages) {
    const start = tokens.length;
    tokens.push(...tokenize(words, base));
    ranges.push([start, tokens.length]);
    base += words.length;
  }
  return { tokens, ranges };
}

function shift(ops: Op[], da: number, db: number): Op[] {
  return ops.map((o) => ({ kind: o.kind, aStart: o.aStart + da, aEnd: o.aEnd + da, bStart: o.bStart + db, bEnd: o.bEnd + db }));
}

/** Synchronous comparison (used by tests and by the worker). `aWords[i]` is page i's words. */
export function compareDocuments(aWords: Word[][], bWords: Word[][], limits: CompareLimits = DEFAULT_LIMITS): CompareResult {
  const { tokens: a, ranges: as } = tokenizePages(aWords);
  const { tokens: b, ranges: bs } = tokenizePages(bWords);

  let mode: CompareResult["mode"] = "document";
  let changes: Change[] = [];
  const whole = a.length + b.length > limits.maxTokens ? "over-budget" : diffTokens(a, b, { maxEdits: limits.maxEdits });
  if (whole !== "over-budget") {
    changes = groupChanges(whole, a, b);
  } else {
    mode = "per-page";
    const pageCount = Math.max(aWords.length, bWords.length);
    for (let i = 0; i < pageCount; i++) {
      const [a0, a1] = as[i] ?? [a.length, a.length];
      const [b0, b1] = bs[i] ?? [b.length, b.length];
      const ta = a.slice(a0, a1);
      const tb = b.slice(b0, b1);
      let ops = diffTokens(ta, tb, { maxEdits: limits.maxEdits });
      if (ops === "over-budget") {
        // One page too different to diff: report it as wholly replaced.
        ops = [
          { kind: "remove", aStart: 0, aEnd: ta.length, bStart: 0, bEnd: 0 },
          { kind: "add", aStart: ta.length, aEnd: ta.length, bStart: 0, bEnd: tb.length },
        ].filter((o) => o.aEnd > o.aStart || o.bEnd > o.bStart) as Op[];
      }
      changes.push(...groupChanges(shift(ops, a0, b0), a, b));
    }
  }

  let added = 0;
  let removed = 0;
  let changed = 0;
  let edits = 0;
  for (const c of changes) {
    if (c.kind === "added") added++;
    else if (c.kind === "removed") removed++;
    else changed++;
    edits += c.a.end - c.a.start + (c.b.end - c.b.start);
  }
  return {
    changes,
    mode,
    stats: { aTokens: a.length, bTokens: b.length, added, removed, changed, edits },
    aIndex: a.map((t) => t.index),
    bIndex: b.map((t) => t.index),
  };
}
