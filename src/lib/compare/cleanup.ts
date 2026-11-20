import type { Op, Token } from "./types";

/** Shared runs shorter than this are not kept when an edit region is re-aligned (they read as noise). */
export const MIN_ANCHOR = 3;
/**
 * Work allowed for re-aligning (token visits and candidate matches, summed over every region and
 * recursion step of one comparison). A region that would pass it keeps the minimal diff's ops.
 */
export const REALIGN_WORK = 4_000_000;

/** What is left of the re-align work for one comparison (share one across per-page calls). */
export interface WorkBudget {
  left: number;
}

interface Block {
  eq: boolean;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

const size = (k: Block) => Math.max(k.a1 - k.a0, k.b1 - k.b0);

/** Ops to alternating equal / edit blocks (consecutive edits merged, empty ops dropped). */
function toBlocks(ops: Op[]): Block[] {
  const out: Block[] = [];
  for (const o of ops) {
    const eq = o.kind === "equal";
    if (o.aEnd === o.aStart && o.bEnd === o.bStart) continue;
    const last = out[out.length - 1];
    if (last && last.eq === eq && last.a1 === o.aStart && last.b1 === o.bStart) {
      last.a1 = o.aEnd;
      last.b1 = o.bEnd;
    } else out.push({ eq, a0: o.aStart, a1: o.aEnd, b0: o.bStart, b1: o.bEnd });
  }
  return out;
}

/**
 * diff-match-patch `cleanupSemantic`, on tokens: an equality between two edits that is no longer
 * than the edit on either side of it is folded into one edit with them. Repeats until stable.
 */
function foldSmallEqualities(blocks: Block[]): Block[] {
  // One pass with a stack: each new edit may fold the equality before it, and the merged edit may
  // then fold the equality before that one (linear overall).
  const out: Block[] = [];
  for (const k of blocks) {
    let cur = { ...k };
    while (!cur.eq && out.length >= 2) {
      const e = out[out.length - 1];
      const p = out[out.length - 2];
      const len = e.a1 - e.a0;
      if (!(e.eq && !p.eq && len <= size(p) && len <= size(cur))) break;
      out.length -= 2;
      cur = { eq: false, a0: p.a0, a1: cur.a1, b0: p.b0, b1: cur.b1 };
    }
    out.push(cur);
  }
  return out;
}

/** Longest run of equal tokens in a[a0, a1) and b[b0, b1) (difflib's find_longest_match). */
function longestMatch(a: Token[], b: Token[], a0: number, a1: number, b0: number, b1: number, budget: WorkBudget): { i: number; j: number; k: number } | null {
  budget.left -= a1 - a0 + (b1 - b0);
  if (budget.left < 0) return null;
  const where = new Map<string, number[]>();
  for (let j = b0; j < b1; j++) {
    const list = where.get(b[j].text);
    if (list) list.push(j);
    else where.set(b[j].text, [j]);
  }
  let best = { i: a0, j: b0, k: 0 };
  let runs = new Map<number, number>();
  for (let i = a0; i < a1; i++) {
    const next = new Map<number, number>();
    const js = where.get(a[i].text) ?? [];
    budget.left -= js.length;
    if (budget.left < 0) return null;
    for (const j of js) {
      const k = (runs.get(j - 1) ?? 0) + 1;
      next.set(j, k);
      if (k > best.k) best = { i: i - k + 1, j: j - k + 1, k };
    }
    runs = next;
  }
  return best;
}

/**
 * Re-align one edit region by its longest shared runs (at least MIN_ANCHOR tokens), longest first,
 * recursing on both sides: a moved paragraph is then matched where it is whole instead of by
 * scattered common words. Blocks come out in document order.
 */
function realignRegion(a: Token[], b: Token[], region: Block, budget: WorkBudget): Block[] | null {
  if (budget.left <= 0) return null;
  const out: Block[] = [];
  const stack: Block[] = [region];
  while (stack.length) {
    const r = stack.pop()!;
    if (r.a1 === r.a0 && r.b1 === r.b0) continue;
    if (r.eq) {
      out.push(r);
      continue;
    }
    const m = r.a1 > r.a0 && r.b1 > r.b0 ? longestMatch(a, b, r.a0, r.a1, r.b0, r.b1, budget) : { i: 0, j: 0, k: 0 };
    if (!m) return null; // out of work: the caller keeps the minimal diff for this region
    if (m.k < MIN_ANCHOR) {
      out.push(r);
      continue;
    }
    stack.push({ eq: false, a0: m.i + m.k, a1: r.a1, b0: m.j + m.k, b1: r.b1 });
    stack.push({ eq: true, a0: m.i, a1: m.i + m.k, b0: m.j, b1: m.j + m.k });
    stack.push({ eq: false, a0: r.a0, a1: m.i, b0: r.b0, b1: m.j });
  }
  return out;
}

/**
 * Make a minimal token diff read like a person would describe it:
 * 1. fold short equalities between edits into them (no "word confetti"),
 * 2. re-align each resulting edit region by its longest shared runs (moved text stays whole),
 * 3. split a pure addition or removal at page boundaries (`pageA`/`pageB` give a token's page),
 *    so each item names one page; empty equal ops separate the parts.
 * The result is still a valid edit script from `a` to `b`. Apply it per page in per-page mode so
 * nothing is folded across a page boundary.
 */
export function cleanupOps(
  ops: Op[],
  a: Token[],
  b: Token[],
  pageA: (i: number) => number = (i) => a[i].page,
  pageB: (j: number) => number = (j) => b[j].page,
  budget: WorkBudget = { left: REALIGN_WORK },
): Op[] {
  const original = toBlocks(ops);
  const folded = foldSmallEqualities(original);
  const blocks: Block[] = [];
  let o = 0;
  for (const k of folded) {
    // The minimal diff's blocks inside this one (folded blocks are unions of consecutive ones).
    const inside: Block[] = [];
    while (o < original.length && original[o].a1 <= k.a1 && original[o].b1 <= k.b1) inside.push(original[o++]);
    // Out of re-align work: keep the minimal diff's own blocks for this region.
    const parts = k.eq ? [k] : realignRegion(a, b, k, budget) ?? inside;
    for (const part of parts) {
      const last = blocks[blocks.length - 1];
      if (last && last.eq === part.eq && last.a1 === part.a0 && last.b1 === part.b0) {
        last.a1 = part.a1;
        last.b1 = part.b1;
      } else blocks.push({ ...part });
    }
  }
  const out: Op[] = [];
  const edit = (a0: number, a1: number, b0: number, b1: number) => {
    if (a1 > a0) out.push({ kind: "remove", aStart: a0, aEnd: a1, bStart: b0, bEnd: b0 });
    if (b1 > b0) out.push({ kind: "add", aStart: a1, aEnd: a1, bStart: b0, bEnd: b1 });
  };
  for (const k of blocks) {
    if (k.eq) {
      out.push({ kind: "equal", aStart: k.a0, aEnd: k.a1, bStart: k.b0, bEnd: k.b1 });
      continue;
    }
    const pure = k.a1 === k.a0 || k.b1 === k.b0;
    if (!pure) {
      edit(k.a0, k.a1, k.b0, k.b1);
      continue;
    }
    // Pure addition or removal: one part per page.
    const onA = k.a1 > k.a0;
    const [s, e] = onA ? [k.a0, k.a1] : [k.b0, k.b1];
    const pageOf = onA ? pageA : pageB;
    let start = s;
    for (let t = s + 1; t <= e; t++) {
      if (t < e && pageOf(t) === pageOf(start)) continue;
      if (start > s) {
        const at = onA ? { a: start, b: k.b0 } : { a: k.a0, b: start };
        out.push({ kind: "equal", aStart: at.a, aEnd: at.a, bStart: at.b, bEnd: at.b });
      }
      if (onA) edit(start, t, k.b0, k.b0);
      else edit(k.a0, k.a0, start, t);
      start = t;
    }
  }
  return out;
}
