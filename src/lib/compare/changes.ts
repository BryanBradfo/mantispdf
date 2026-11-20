import type { Change, Op, PageSpan, Token } from "./types";

const PREVIEW_MAX = 80;

function preview(tokens: Token[], start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) {
    out += (out ? " " : "") + tokens[i].text;
    if (out.length > PREVIEW_MAX) return out.slice(0, PREVIEW_MAX - 1) + "…";
  }
  return out;
}

function pages(tokens: Token[], start: number, end: number): PageSpan | null {
  return end > start ? { first: tokens[start].page, last: tokens[end - 1].page } : null;
}

/** Turn ops into changes: a remove directly followed by an add is one "changed". Equal ops are skipped. */
export function groupChanges(ops: Op[], a: Token[], b: Token[]): Change[] {
  const changes: Change[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === "equal") continue;
    let j = i;
    while (j + 1 < ops.length && ops[j + 1].kind !== "equal") j++;
    const last = ops[j];
    const aStart = op.aStart;
    const aEnd = last.aEnd;
    const bStart = op.bStart;
    const bEnd = last.bEnd;
    i = j;
    const kind = aEnd > aStart && bEnd > bStart ? "changed" : aEnd > aStart ? "removed" : "added";
    changes.push({
      kind,
      a: { start: aStart, end: aEnd },
      b: { start: bStart, end: bEnd },
      aPages: pages(a, aStart, aEnd),
      bPages: pages(b, bStart, bEnd),
      aText: preview(a, aStart, aEnd),
      bText: preview(b, bStart, bEnd),
    });
  }
  return changes;
}
