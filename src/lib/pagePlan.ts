/** One page of the output PDF (mirrors the Rust `PlanEntry`). */
export type PlanEntry =
  | { kind: "page"; src: number; page: number; rotate: number }
  | { kind: "blank" };

/** Wire format for `apply_page_plan`: triples (src, page, rotate); src -1 = blank. */
export function encodePlan(entries: readonly PlanEntry[]): Int32Array {
  const out = new Int32Array(entries.length * 3);
  entries.forEach((e, i) => {
    out.set(e.kind === "blank" ? [-1, 0, 0] : [e.src, e.page, e.rotate], i * 3);
  });
  return out;
}

export type RangeParse = { ok: true; pages: number[] } | { ok: false; error: string };

/** Parse "1-3, 7, 10-" (also "-4") into sorted unique 1-based pages within 1..total. */
export function parsePageRanges(text: string, total: number): RangeParse {
  const pages = new Set<number>();
  for (const raw of text.split(",")) {
    const token = raw.replace(/\s+/g, "");
    if (token === "") continue;
    const single = /^(\d+)$/.exec(token);
    const range = /^(\d*)-(\d*)$/.exec(token);
    let start: number;
    let end: number;
    if (single) {
      start = end = Number(single[1]);
    } else if (range && (range[1] !== "" || range[2] !== "")) {
      start = range[1] === "" ? 1 : Number(range[1]);
      end = range[2] === "" ? total : Number(range[2]);
    } else {
      return { ok: false, error: `Cannot read "${raw.trim()}"` };
    }
    if (start < 1 || end < 1) return { ok: false, error: "Page numbers start at 1" };
    if (start > total) return { ok: false, error: `Page ${start} does not exist (the document has ${total} pages)` };
    if (end > total) return { ok: false, error: `Page ${end} does not exist (the document has ${total} pages)` };
    if (start > end) return { ok: false, error: `Range ${start}-${end} is backwards` };
    for (let p = start; p <= end; p++) pages.add(p);
  }
  return { ok: true, pages: [...pages].sort((a, b) => a - b) };
}

/** Canonical text for a page set: [1,2,3,7] -> "1-3, 7". */
export function formatPageRanges(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}-${sorted[i]}`);
  }
  return parts.join(", ");
}
