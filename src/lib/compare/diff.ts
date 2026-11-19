import type { Op, Token } from "./types";

export interface DiffBudget {
  maxEdits: number;
}

interface Snake {
  /** Snake start and end in the sub-problem's local coordinates. */
  xs: number;
  ys: number;
  xe: number;
  ye: number;
}

/**
 * Myers O(ND) diff, linear space (middle snake, divide and conquer), on interned token ids.
 * Returns coalesced ops, or "over-budget" when the edit distance exceeds `budget.maxEdits`.
 */
export function diffTokens(a: Token[], b: Token[], budget: DiffBudget): Op[] | "over-budget" {
  const ids = new Map<string, number>();
  const intern = (t: Token) => {
    let id = ids.get(t.text);
    if (id === undefined) {
      id = ids.size;
      ids.set(t.text, id);
    }
    return id;
  };
  const A = Int32Array.from(a, intern);
  const B = Int32Array.from(b, intern);

  const raw: Op[] = [];
  const push = (kind: Op["kind"], aStart: number, aEnd: number, bStart: number, bEnd: number) => {
    if (kind === "equal" ? aEnd === aStart : aEnd === aStart && bEnd === bStart) return;
    const last = raw[raw.length - 1];
    if (last && last.kind === kind && last.aEnd === aStart && last.bEnd === bStart) {
      last.aEnd = aEnd;
      last.bEnd = bEnd;
    } else raw.push({ kind, aStart, aEnd, bStart, bEnd });
  };

  /** Returns the snake plus total edits D of the sub-problem, or null when the cap is hit. */
  function middleSnake(aLo: number, aHi: number, bLo: number, bHi: number, capD: number): (Snake & { d: number }) | null {
    const N = aHi - aLo;
    const M = bHi - bLo;
    const delta = N - M;
    const odd = (delta & 1) !== 0;
    const max = Math.min(Math.ceil((N + M) / 2), Math.ceil(capD / 2));
    const off = max + 1;
    const vf = new Int32Array(2 * max + 3);
    const vb = new Int32Array(2 * max + 3);
    for (let d = 0; d <= max; d++) {
      for (let k = -d; k <= d; k += 2) {
        const i = off + k;
        let x = k === -d || (k !== d && vf[i - 1] < vf[i + 1]) ? vf[i + 1] : vf[i - 1] + 1;
        let y = x - k;
        const xs = x;
        const ys = y;
        while (x < N && y < M && A[aLo + x] === B[bLo + y]) {
          x++;
          y++;
        }
        vf[i] = x;
        if (odd && k >= delta - (d - 1) && k <= delta + (d - 1) && vf[i] + vb[off + delta - k] >= N) {
          return { xs, ys, xe: x, ye: y, d: 2 * d - 1 };
        }
      }
      for (let k = -d; k <= d; k += 2) {
        const i = off + k;
        let x = k === -d || (k !== d && vb[i - 1] < vb[i + 1]) ? vb[i + 1] : vb[i - 1] + 1;
        let y = x - k;
        const xs = x;
        const ys = y;
        while (x < N && y < M && A[aHi - 1 - x] === B[bHi - 1 - y]) {
          x++;
          y++;
        }
        vb[i] = x;
        if (!odd && k >= delta - d && k <= delta + d && vf[off + delta - k] + vb[i] >= N) {
          return { xs: N - x, ys: M - y, xe: N - xs, ye: M - ys, d: 2 * d };
        }
      }
    }
    return null;
  }

  function solve(aLo: number, aHi: number, bLo: number, bHi: number, capD: number): boolean {
    let pre = 0;
    while (aLo + pre < aHi && bLo + pre < bHi && A[aLo + pre] === B[bLo + pre]) pre++;
    push("equal", aLo, aLo + pre, bLo, bLo + pre);
    aLo += pre;
    bLo += pre;
    let suf = 0;
    while (aHi - suf > aLo && bHi - suf > bLo && A[aHi - 1 - suf] === B[bHi - 1 - suf]) suf++;
    const aEnd = aHi;
    const bEnd = bHi;
    aHi -= suf;
    bHi -= suf;

    if (aLo === aHi || bLo === bHi) {
      if (aHi - aLo + (bHi - bLo) > capD) return false;
      push("remove", aLo, aHi, bLo, bLo);
      push("add", aHi, aHi, bLo, bHi);
    } else {
      const s = middleSnake(aLo, aHi, bLo, bHi, capD);
      if (!s || s.d > capD) return false;
      if (!solve(aLo, aLo + s.xs, bLo, bLo + s.ys, Infinity)) return false;
      push("equal", aLo + s.xs, aLo + s.xe, bLo + s.ys, bLo + s.ye);
      if (!solve(aLo + s.xe, aHi, bLo + s.ye, bHi, Infinity)) return false;
    }
    push("equal", aHi, aEnd, bHi, bEnd);
    return true;
  }

  if (!solve(0, A.length, 0, B.length, budget.maxEdits)) return "over-budget";
  return normalize(raw);
}

/** Each run of non-equal ops between two equals becomes one remove followed by one add. */
function normalize(raw: Op[]): Op[] {
  const out: Op[] = [];
  let i = 0;
  while (i < raw.length) {
    const op = raw[i];
    if (op.kind === "equal") {
      out.push(op);
      i++;
      continue;
    }
    const first = raw[i];
    let last = first;
    while (i < raw.length && raw[i].kind !== "equal") last = raw[i++];
    const aStart = first.aStart;
    const aEnd = last.aEnd;
    const bStart = first.bStart;
    const bEnd = last.bEnd;
    if (aEnd > aStart) out.push({ kind: "remove", aStart, aEnd, bStart, bEnd: bStart });
    if (bEnd > bStart) out.push({ kind: "add", aStart: aEnd, aEnd: aEnd, bStart, bEnd });
  }
  return out;
}
