import { describe, it, expect } from "vitest";
import { tokenize } from "./tokens";
import { diffTokens } from "./diff";
import { groupChanges } from "./changes";
import { compareDocuments } from "./compare";
import { CompareClient } from "./client";
import { handleCompareMessage } from "../../workers/compare.worker";
import type { CompareRequest } from "./protocol";
import type { Op, Token, Word } from "./types";

const box = { x: 0, y: 0, w: 1, h: 1 };
const words = (s: string, page = 0): Word[] => s.split(" ").filter((t) => t !== "").map((text) => ({ text, page, box }));
const toks = (s: string, page = 0) => tokenize(words(s, page));
const BIG = { maxEdits: 1e9 };

function editCount(ops: Op[]) {
  return ops.reduce((n, o) => (o.kind === "equal" ? n : n + (o.aEnd - o.aStart) + (o.bEnd - o.bStart)), 0);
}
/** Apply ops: rebuilds b from a, proving the script is valid. */
function replay(ops: Op[], a: Token[], b: Token[]) {
  const out: string[] = [];
  for (const o of ops) {
    if (o.kind === "equal") {
      for (let i = 0; i < o.aEnd - o.aStart; i++) {
        expect(a[o.aStart + i].text).toBe(b[o.bStart + i].text);
        out.push(a[o.aStart + i].text);
      }
    } else if (o.kind === "add") for (let i = o.bStart; i < o.bEnd; i++) out.push(b[i].text);
  }
  expect(out).toEqual(b.map((t) => t.text));
}
function lcsEdits(a: string[], b: string[]) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return a.length + b.length - 2 * dp[a.length][b.length];
}
function diff(a: string, b: string) {
  const ta = toks(a);
  const tb = toks(b);
  const ops = diffTokens(ta, tb, BIG);
  if (ops === "over-budget") throw new Error("unexpected");
  replay(ops, ta, tb);
  return { ops, ta, tb };
}

describe("tokenize", () => {
  it("applies NFKC and maps NBSP/thin spaces", () => {
    const t = tokenize(words("ﬁn   x"));
    expect(t.map((x) => x.text)).toEqual(["fin", "x"]);
  });
  it("trims, drops empties and keeps source indices", () => {
    const w: Word[] = ["a", " ", " ", " b "].map((text, i) => ({ text, page: i, box }));
    expect(tokenize(w)).toEqual([
      { text: "a", index: 0, page: 0 },
      { text: "b", index: 3, page: 3 },
    ]);
  });
  it("keeps punctuation and French apostrophes inside tokens, case-sensitive", () => {
    expect(toks("l’homme, Bonjour !").map((t) => t.text)).toEqual(["l’homme,", "Bonjour", "!"]);
    expect(diff("Bonjour", "bonjour").ops.map((o) => o.kind)).toEqual(["remove", "add"]);
  });
});

describe("diffTokens", () => {
  it("empty and identical", () => {
    expect(diffTokens([], [], BIG)).toEqual([]);
    expect(diff("a b c", "a b c").ops).toEqual([{ kind: "equal", aStart: 0, aEnd: 3, bStart: 0, bEnd: 3 }]);
    expect(diff("", "a b").ops).toEqual([{ kind: "add", aStart: 0, aEnd: 0, bStart: 0, bEnd: 2 }]);
    expect(diff("a b", "").ops).toEqual([{ kind: "remove", aStart: 0, aEnd: 2, bStart: 0, bEnd: 0 }]);
  });
  it("insert, delete, replace", () => {
    expect(diff("a b c", "a x b c").ops.map((o) => o.kind)).toEqual(["equal", "add", "equal"]);
    expect(diff("a x b c", "a b c").ops.map((o) => o.kind)).toEqual(["equal", "remove", "equal"]);
    expect(diff("a x c", "a y c").ops.map((o) => o.kind)).toEqual(["equal", "remove", "add", "equal"]);
  });
  it("interleaved edits", () => {
    const { ops } = diff("a b c d e f g", "a X c d Y f Z");
    expect(editCount(ops)).toBe(lcsEdits("a b c d e f g".split(" "), "a X c d Y f Z".split(" ")));
  });
  it("repeated words stay minimal", () => {
    expect(editCount(diff("the the the", "the the").ops)).toBe(1);
    const { ops, ta, tb } = diff("the the the cat", "the the the the cat");
    expect(editCount(ops)).toBe(1);
    const c = groupChanges(ops, ta, tb);
    expect(c).toHaveLength(1);
    expect(c[0].kind).toBe("added");
  });
  it("reordered paragraphs: minimal diff, highlights on moved block", () => {
    const p1 = "alpha beta gamma delta";
    const p2 = "one two three four five six";
    const { ops, ta, tb } = diff(`${p1} ${p2} tail`, `${p2} ${p1} tail`);
    expect(editCount(ops)).toBe(lcsEdits(ta.map((t) => t.text), tb.map((t) => t.text)));
    expect(editCount(ops)).toBe(8); // moves the shorter block: 4 removed + 4 added
    const changes = groupChanges(ops, ta, tb);
    const removedText = changes.map((c) => c.aText).filter(Boolean).join(" ");
    expect(removedText).toBe(p1);
  });
  it("matches optimal edit distance on random inputs", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 300; n++) {
      const gen = () => Array.from({ length: Math.floor(rnd() * 14) }, () => "abcd"[Math.floor(rnd() * 4)]).join(" ");
      const a = gen();
      const b = gen();
      const { ops, ta, tb } = diff(a, b);
      expect(editCount(ops)).toBe(lcsEdits(ta.map((t) => t.text), tb.map((t) => t.text)));
    }
  });
  it("returns over-budget past maxEdits, ok at the limit", () => {
    const ta = toks("a b c d e f");
    const tb = toks("g h i j k l");
    expect(diffTokens(ta, tb, { maxEdits: 11 })).toBe("over-budget");
    expect(diffTokens(ta, tb, { maxEdits: 12 })).not.toBe("over-budget");
    expect(diffTokens(toks("a b c d"), toks("a x c y"), { maxEdits: 3 })).toBe("over-budget");
    expect(diffTokens(toks("a b c d"), toks("a x c y"), { maxEdits: 4 })).not.toBe("over-budget");
  });
  it("handles large mostly-equal input quickly", () => {
    const base = Array.from({ length: 100_000 }, (_, i) => `w${i}`);
    const mod = base.slice();
    mod[50_000] = "CHANGED";
    mod.splice(70_000, 0, "NEW");
    const t0 = performance.now();
    const ops = diffTokens(toks(base.join(" ")), toks(mod.join(" ")), { maxEdits: 20_000 });
    expect(ops).not.toBe("over-budget");
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});

describe("groupChanges", () => {
  it("classifies added, removed and changed with pages and previews", () => {
    const a = tokenize([...words("keep old gone end", 0), ...words("tail", 1)]);
    const b = tokenize([...words("keep new end", 0), ...words("tail extra", 1)]);
    const ops = diffTokens(a, b, BIG) as Op[];
    const c = groupChanges(ops, a, b);
    expect(c.map((x) => x.kind)).toEqual(["changed", "added"]);
    expect(c[0]).toMatchObject({ aText: "old gone", bText: "new", aPages: { first: 0, last: 0 } });
    expect(c[1]).toMatchObject({ kind: "added", aPages: null, bPages: { first: 1, last: 1 }, aText: "", bText: "extra" });
    const r = groupChanges(diffTokens(toks("a b c"), toks("a c"), BIG) as Op[], toks("a b c"), toks("a c"));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "removed", bPages: null, aText: "b" });
  });
  it("truncates previews to about 80 chars and spans pages", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const a = tokenize([...words(long, 0), ...words(long, 1)]);
    const b: Token[] = [];
    const c = groupChanges(diffTokens(a, b, BIG) as Op[], a, b);
    expect(c[0].aText.length).toBeLessThanOrEqual(80);
    expect(c[0].aText.endsWith("…")).toBe(true);
    expect(c[0].aPages).toEqual({ first: 0, last: 1 });
  });
});

describe("compareDocuments", () => {
  it("document mode with stats and index maps", () => {
    const r = compareDocuments([words("a b c", 0), words("d e", 1)], [words("a x c", 0), words("d e f", 1)]);
    expect(r.mode).toBe("document");
    expect(r.stats).toMatchObject({ aTokens: 5, bTokens: 6, added: 1, changed: 1, removed: 0, edits: 3 });
    expect(r.aIndex).toEqual([0, 1, 2, 3, 4]);
  });
  it("identical documents have no changes; empty text is safe", () => {
    expect(compareDocuments([words("a b")], [words("a b")]).changes).toEqual([]);
    expect(compareDocuments([[]], [[]]).changes).toEqual([]);
    expect(compareDocuments([], [words("x")]).changes).toHaveLength(1);
  });
  it("switches to per-page past the token budget, not detecting page moves", () => {
    const a = [words("a b", 0), words("c d", 1)];
    const b = [words("a b", 0), words("c X d", 1), words("new", 2)];
    const r = compareDocuments(a, b, { maxTokens: 5, maxEdits: 100 });
    expect(r.mode).toBe("per-page");
    expect(r.changes.map((c) => [c.kind, c.bText, c.bPages?.first])).toEqual([
      ["added", "X", 1],
      ["added", "new", 2],
    ]);
    const moved = compareDocuments([words("p q", 0), words("r s", 1)], [words("r s", 0), words("p q", 1)], { maxTokens: 1, maxEdits: 100 });
    expect(moved.changes.every((c) => c.kind === "changed")).toBe(true);
  });
  it("switches to per-page past the edit budget; hopeless page is one replace", () => {
    const a = [words("a b c d", 0), words("x y", 1)];
    const b = [words("e f g h", 0), words("x y", 1)];
    const r = compareDocuments(a, b, { maxTokens: 1e6, maxEdits: 3 });
    expect(r.mode).toBe("per-page");
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ kind: "changed", aText: "a b c d", bText: "e f g h" });
  });
});

describe("page slices from input structure", () => {
  it("per-page mode with an empty middle page and Word.page not equal to index", () => {
    const w = (s: string, page: number) => words(s, page);
    const a = [w("a b", 7), [], w("c d", 7)];
    const b = [w("a b", 7), w("ins", 7), w("c X d", 7)];
    const r = compareDocuments(a, b, { maxTokens: 1, maxEdits: 100 });
    expect(r.mode).toBe("per-page");
    expect(r.changes.map((c) => [c.kind, c.bText])).toEqual([
      ["added", "ins"],
      ["added", "X"],
    ]);
    expect(r.aIndex).toEqual([0, 1, 2, 3]);
    expect(r.bIndex).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("worker message handler", () => {
  it("answers success, failure on unknown type and on bad payload", () => {
    const ok = handleCompareMessage({ type: "compare", id: 4, a: [words("a")], b: [words("b")], limits: { maxTokens: 10, maxEdits: 10 } });
    expect(ok).toMatchObject({ type: "success", id: 4 });
    const unknown = handleCompareMessage({ type: "nope", id: 5 } as unknown as CompareRequest);
    expect(unknown).toMatchObject({ type: "failure", id: 5 });
    const bad = handleCompareMessage({ type: "compare", id: 6 } as unknown as CompareRequest);
    expect(bad).toMatchObject({ type: "failure", id: 6 });
    expect(handleCompareMessage(null as unknown as CompareRequest).type).toBe("failure");
  });
});

describe("CompareClient", () => {
  it("a new compare supersedes the running one (AbortError, onAbort called)", async () => {
    const sent: { id: number }[] = [];
    let aborts = 0;
    const c = new CompareClient((m) => sent.push(m), () => aborts++);
    const p1 = c.compare([], []);
    const p2 = c.compare([], []);
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    expect(aborts).toBe(1);
    expect(c.pendingCount).toBe(1);
    c.handleMessage({ type: "success", id: sent[0].id, result: {} as never }); // stale reply ignored
    expect(c.pendingCount).toBe(1);
    c.cancel();
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
    expect(aborts).toBe(2);
    c.cancel();
    expect(aborts).toBe(2);
  });
  it("correlates replies by id and rejects on crash", async () => {
    const sent: { id: number }[] = [];
    const c = new CompareClient((m) => sent.push(m));
    const p1 = c.compare([], []);
    const res = (n: number) => ({ changes: [], mode: "document" as const, stats: { aTokens: n, bTokens: 0, added: 0, removed: 0, changed: 0, edits: 0 }, aIndex: [], bIndex: [] });
    c.handleMessage({ type: "success", id: sent[0].id, result: res(1) });
    expect((await p1).stats.aTokens).toBe(1);
    const p3 = c.compare([], []);
    c.handleError(new Error("boom"));
    await expect(p3).rejects.toThrow("boom");
    const p4 = c.compare([], []);
    c.handleMessage({ type: "failure", id: sent[2].id, error: "bad" });
    await expect(p4).rejects.toThrow("bad");
    expect(c.pendingCount).toBe(0);
  });
});
