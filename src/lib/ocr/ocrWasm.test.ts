// @vitest-environment node
/**
 * The real engine through its JS binding (`add_text_layer` in the wasm package) on a tiny PDF
 * built here, read back with the engine's own search. Skipped when the package is not built
 * (`npm run build:wasm`).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { RedactSearchResultWire } from "../redact/searchWire";
import type { OcrPageWire, OcrWordWire } from "./textLayerWire";

const PKG = fileURLToPath(new URL("../../../crates/mantis-wasm/pkg/", import.meta.url));
const built = existsSync(`${PKG}mantis_wasm_bg.wasm`);

type Wasm = {
  add_text_layer: (pdf: Uint8Array, pages: unknown) => Uint8Array;
  redact_search: (pdf: Uint8Array, query: string, options: object) => RedactSearchResultWire;
  initSync: (m: { module: BufferSource }) => unknown;
};
let wasm: Wasm;

beforeAll(async () => {
  if (!built) return;
  wasm = (await import(/* @vite-ignore */ `${PKG}mantis_wasm.js`)) as Wasm;
  wasm.initSync({ module: readFileSync(`${PKG}mantis_wasm_bg.wasm`) });
});

/** A PDF from object bodies (object n is `bodies[n - 1]`), with a correct xref table. */
function buildPdf(bodies: string[]): Uint8Array {
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** One empty 612 x 792 page. */
const PDF = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
]);

const word = (text: string, x: number, spaceAfter: boolean): OcrWordWire => ({ text, x, y: 700, w: 60, h: 20, baseline: null, spaceAfter });
const SEARCH = { wholeWord: false, caseSensitive: false };

describe.skipIf(!built)("add_text_layer binding", () => {
  it("adds words that the engine's search finds where they were placed", () => {
    const pages: OcrPageWire[] = [{ page: 1, words: [word("MANTIS", 72, true), word("été", 133, false)] }];
    const out = wasm.add_text_layer(PDF, pages);
    expect(new TextDecoder("latin1").decode(out)).toContain("GlyphLessFont");
    // A 1 pt gap reads as a space only thanks to `spaceAfter`.
    const found = wasm.redact_search(out, "mantis été", SEARCH);
    expect(found.matches).toHaveLength(1);
    const [x, y, w, h] = found.matches[0].rects[0];
    expect([x, y, x + w, y + h].map((v) => Math.round(v * 100) / 100)).toEqual([72, 700, 193, 720]);
  });

  it("accepts a known baseline and pages without words", () => {
    const pages = [
      { page: 1, words: [{ ...word("x", 10, false), baseline: 704 }] },
    ];
    expect(wasm.add_text_layer(PDF, pages).length).toBeGreaterThan(PDF.length);
    expect(wasm.add_text_layer(PDF, [{ page: 1, words: [] }]).length).toBeGreaterThan(0);
  });

  it("refuses bad shapes with the engine's messages", () => {
    const bad = (pages: unknown) => () => wasm.add_text_layer(PDF, pages);
    expect(bad({ page: 1 })).toThrow("Invalid OCR settings: pages");
    expect(bad([{ page: 1.5, words: [] }])).toThrow("Invalid OCR settings: pages[0].page");
    expect(bad([{ page: 2, words: [] }])).toThrow("Invalid OCR settings: page");
    expect(bad([{ page: 1 }])).toThrow("Invalid OCR settings: pages[0].words");
    const { spaceAfter: _, ...noSpace } = word("a", 1, false);
    expect(bad([{ page: 1, words: [noSpace] }])).toThrow("Invalid OCR settings: pages[0].words[0].spaceAfter");
    expect(bad([{ page: 1, words: [{ ...word("a", 1, false), baseline: "low" }] }])).toThrow("Invalid OCR settings: pages[0].words[0].baseline");
    expect(bad([{ page: 1, words: [{ ...word("a", 1, false), w: -1 }] }])).toThrow("Invalid OCR settings: box");
  });

  it("checks counts and string lengths before copying", () => {
    const bad = (pages: unknown) => () => wasm.add_text_layer(PDF, pages);
    // Sparse arrays: only their lengths are read.
    expect(bad(new Array(2001))).toThrow("Invalid OCR settings: pages");
    expect(bad([{ page: 1, words: new Array(200_001) }])).toThrow("Invalid OCR settings: words");
    const full = Array.from({ length: 10 }, () => ({ page: 1, words: new Array(200_000) }));
    expect(bad([...full, { page: 1, words: [word("a", 1, false)] }])).toThrow("Invalid OCR settings: words");
    expect(bad([{ page: 1, words: [word("x".repeat(201), 1, false)] }])).toThrow("Invalid OCR settings: text");
    expect(wasm.add_text_layer(PDF, [{ page: 1, words: [word("😀".repeat(100), 1, false)] }]).length).toBeGreaterThan(0);
  });
});
