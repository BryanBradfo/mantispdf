// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanupOps } from "./cleanup";
import { compareDocuments } from "./compare";
import { diffTokens } from "./diff";
import { extractWords, type PdfLike } from "./extract";
import { tokenize } from "./tokens";
import type { Op, Token, Word } from "./types";

const box = { x: 0, y: 0, w: 1, h: 1 };
const words = (s: string, page = 0): Word[] => s.split(" ").filter(Boolean).map((text) => ({ text, page, box }));
const toks = (s: string, page = 0) => tokenize(words(s, page));

/** Apply ops: rebuilds b from a (the script stays valid after the cleanup). */
function replay(ops: Op[], a: Token[], b: Token[]) {
  const out: string[] = [];
  let ia = 0;
  let ib = 0;
  for (const o of ops) {
    expect([o.aStart, o.bStart]).toEqual([ia, ib]);
    if (o.kind === "equal") {
      for (let i = 0; i < o.aEnd - o.aStart; i++) {
        expect(a[o.aStart + i].text).toBe(b[o.bStart + i].text);
        out.push(a[o.aStart + i].text);
      }
    } else if (o.kind === "add") for (let i = o.bStart; i < o.bEnd; i++) out.push(b[i].text);
    ia = o.aEnd;
    ib = o.bEnd;
  }
  expect([ia, ib]).toEqual([a.length, b.length]);
  expect(out).toEqual(b.map((t) => t.text));
}

function clean(x: string, y: string) {
  const a = toks(x);
  const b = toks(y);
  const ops = diffTokens(a, b, { maxEdits: 1e9 });
  if (ops === "over-budget") throw new Error("unexpected");
  const out = cleanupOps(ops, a, b);
  replay(out, a, b);
  const changes = compareDocuments([words(x)], [words(y)]).changes;
  return { ops: out, changes };
}

describe("cleanupOps", () => {
  it("a sentence rewritten around a shared word stays one change, not word confetti", () => {
    const { changes } = clean("the cat sat on the mat", "a dog ran on a rug");
    expect(changes.map((c) => [c.kind, c.aText, c.bText])).toEqual([["changed", "the cat sat on the mat", "a dog ran on a rug"]]);
  });

  it("keeps separate edits apart when a real stretch of text is between them", () => {
    const { changes } = clean("one quick step and then the long middle part stays here as it was today", "one swift step and then the long middle part stays here as it was tonight");
    expect(changes.map((c) => [c.aText, c.bText])).toEqual([
      ["quick", "swift"],
      ["today", "tonight"],
    ]);
  });

  it("folds a one-word match between two edits", () => {
    const { changes } = clean("start alpha of beta end", "start gamma of delta end");
    expect(changes.map((c) => [c.aText, c.bText])).toEqual([["alpha of beta", "gamma of delta"]]);
  });

  it("leaves identical, added-only and removed-only scripts as they were", () => {
    expect(clean("a b c", "a b c").changes).toEqual([]);
    expect(clean("a b c", "a b x y c").changes.map((c) => [c.kind, c.bText])).toEqual([["added", "x y"]]);
    expect(clean("a b x y c", "a b c").changes.map((c) => [c.kind, c.aText])).toEqual([["removed", "x y"]]);
  });

  it("keeps a moved block whole: removed where it was, added where it went", () => {
    const p = "this paragraph moves somewhere else";
    const s = "the second sentence keeps all of its words";
    const { changes } = clean(`intro ${p} ${s}`, `intro ${s} ${p} brand new ending here`);
    expect(changes.map((c) => [c.kind, c.aText, c.bText])).toEqual([
      ["removed", p, ""],
      ["added", "", `${p} brand new ending here`],
    ]);
  });

  it("stays valid and quick on a heavily edited document", () => {
    const n = 4000;
    const x = Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const y = Array.from({ length: n }, (_, i) => (i % 2 ? `v${i}` : `w${i}`)).join(" ");
    const t0 = performance.now();
    const { changes } = clean(x, y);
    expect(performance.now() - t0).toBeLessThan(3000);
    // Every other word changed: one rewritten passage, not 2000 one-word changes.
    expect(changes).toHaveLength(1);
  });

  it("keeps the minimal diff for a region once the re-align work budget is spent", () => {
    const a = toks("p A q B r C s");
    const b = toks("p X q Y r Z s");
    const ops = diffTokens(a, b, { maxEdits: 1e9 });
    if (ops === "over-budget") throw new Error("unexpected");
    const spent = cleanupOps(ops, a, b, undefined, undefined, { left: 0 });
    replay(spent, a, b);
    expect(spent.filter((o) => o.kind === "equal").map((o) => a[o.aStart].text)).toEqual(["p", "q", "r", "s"]);
    const budget = { left: 1_000 };
    const done = cleanupOps(ops, a, b, undefined, undefined, budget);
    expect(done.filter((o) => o.kind === "equal").map((o) => a[o.aStart].text)).toEqual(["p", "s"]);
    expect(budget.left).toBeLessThan(1_000);
  });

  it("splits a pure addition at page boundaries", () => {
    const a = [words("x y", 0)];
    const b = [words("x y new words", 0), words("next page text", 1)];
    const r = compareDocuments(a, b);
    expect(r.changes.map((c) => [c.kind, c.bText, c.bPages?.first])).toEqual([
      ["added", "new words", 0],
      ["added", "next page text", 1],
    ]);
  });

  it("does not fold across a page boundary in per-page mode", () => {
    // "c" opens page 2 between two edits: document mode folds it, per-page mode keeps the pages apart.
    const a = [words("a X", 0), words("c Y b", 1)];
    const b = [words("a P", 0), words("c Q b", 1)];
    expect(compareDocuments(a, b).changes.map((c) => [c.aText, c.bText])).toEqual([["X c Y", "P c Q"]]);
    const r = compareDocuments(a, b, { maxTokens: 1, maxEdits: 100 });
    expect(r.mode).toBe("per-page");
    expect(r.changes.map((c) => [c.aText, c.bText])).toEqual([
      ["X", "P"],
      ["Y", "Q"],
    ]);
  });
});

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Pdfjs;
beforeAll(async () => {
  pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as Pdfjs;
});

async function fixtureWords(name: string): Promise<Word[][]> {
  const bytes = readFileSync(fileURLToPath(new URL(`../../../e2e/fixtures/${name}`, import.meta.url)));
  const doc = (await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise) as unknown as PdfLike;
  return extractWords(doc);
}

describe("the compare fixtures read like a person would describe them", () => {
  it("quick -> swift, line -> sentence, moved paragraph, new third page", async () => {
    const r = compareDocuments(await fixtureWords("compare-a.pdf"), await fixtureWords("compare-b.pdf"));
    const summary = r.changes.map((c) => [c.kind, c.aText, c.bText, c.aPages?.first ?? null, c.bPages?.first ?? null]);
    expect(summary).toEqual([
      ["changed", "quick", "swift", 0, 0],
      ["changed", "line will be removed", "sentence was added", 0, 0],
      ["removed", "Paragraph two moves to the bottom later.", "", 0, null],
      ["added", "", "Paragraph two moves to the bottom later.", null, 1],
      ["added", "", "Third page exists only in the modified copy.", null, 2],
    ]);
    const texts = r.changes.flatMap((c) => [c.aText, c.bText]);
    expect(texts).not.toContain("Second");
    expect(texts).not.toContain("keeps");
  });
});
