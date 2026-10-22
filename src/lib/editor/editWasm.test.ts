// @vitest-environment node
/**
 * The real engine through its JS binding (`edit_pdf` in the wasm package), for what only the
 * binding can show. Skipped when the package is not built (`npm run build:wasm`).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fitRectToHeight, fitTextRect } from "./textFit";

const PKG = fileURLToPath(new URL("../../../crates/mantis-wasm/pkg/", import.meta.url));
const built = existsSync(`${PKG}mantis_wasm_bg.wasm`);
const PDF = new Uint8Array(readFileSync(new URL("../../../e2e/fixtures/one-page.pdf", import.meta.url)));

type Store = {
  has: (id: string) => boolean;
  add: (id: string, bytes: Uint8Array) => void;
  layout_text: (ids: string[], text: string, size: number, width: number, height: number, align: string, lineHeight: number) => unknown;
  free: () => void;
};
type Wasm = {
  FontStore: new () => Store;
  edit_pdf: (pdf: Uint8Array, job: unknown) => Uint8Array;
  layout_text: (fonts: unknown, text: string, size: number, width: number, height: number, align: string, lineHeight: number) => unknown;
  initSync: (m: { module: BufferSource }) => unknown;
};
const FONT_DIR = "../../../crates/mantis-wasm/tests/fonts/";
const font = (name: string) => new Uint8Array(readFileSync(new URL(`${FONT_DIR}${name}`, import.meta.url)));
let wasm: Wasm;

beforeAll(async () => {
  if (!built) return;
  wasm = (await import(/* @vite-ignore */ `${PKG}mantis_wasm.js`)) as Wasm;
  wasm.initSync({ module: readFileSync(`${PKG}mantis_wasm_bg.wasm`) });
});

const edit = (items: unknown[]) => wasm.edit_pdf(PDF, { items });

/** Opaque RGBA noise: it does not compress, so its size shows in the output. */
function noise(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  let seed = 12345;
  for (let i = 0; i < px.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    px[i] = i % 4 === 3 ? 255 : seed >>> 24;
  }
  return px;
}

describe.skipIf(!built)("edit_pdf binding", () => {
  it("embeds an image placed twice once (same data buffer)", () => {
    const pixels = noise(64, 64);
    const place = (image: unknown, x: number) => ({ kind: "image", page: 1, rect: [x, 10, 50, 50], image, opacity: 1, rotation: 0 });
    const shared = { kind: "rgba", width: 64, height: 64, pixels };
    const once = edit([place(shared, 10)]).length;
    const twiceShared = edit([place(shared, 10), place(shared, 100)]).length;
    const twiceCopied = edit([place(shared, 10), place({ ...shared, pixels: pixels.slice() }, 100)]).length;
    // 16 KiB of noise per embedded copy; a second placement of shared data only adds operators.
    expect(twiceShared - once).toBeLessThan(1000);
    expect(twiceCopied - once).toBeGreaterThan(10000);
  });

  it("refuses freehand points past the job total before reading the next stroke", () => {
    const stroke = (points: unknown[]) => ({ kind: "freehand", page: 1, points, color: [0, 0, 0], width: 1, opacity: 1 });
    const ok = Array.from({ length: 15000 }, (_, i) => [i % 500, 10]);
    // The second stroke is malformed at its end: rejecting on the running total never reaches it.
    const over = [...Array.from({ length: 5999 }, () => [1, 1]), ["x", 0]];
    expect(() => edit([stroke(ok), stroke(over)])).toThrow("Invalid edit settings: points");
    expect(() => edit([stroke(ok.slice(0, 10000)), stroke(ok.slice(0, 10000))])).not.toThrow();
  });

  it("draws a Noto text box with the job's fonts", () => {
    const fonts = [
      { id: "sans", bytes: font("NotoSans-subset.ttf") },
      { id: "sc", bytes: font("NotoSansSC-subset.ttf") },
    ];
    const item = {
      kind: "text", page: 1, rect: [50, 600, 300, 60], text: "Привет 你好", family: "noto", font: "Noto Sans",
      faces: ["sans", "sc"], fakeBold: ["sc"], size: 14, color: [0, 0, 0], opacity: 1, align: "auto", lineHeight: 1.2,
    };
    const out = wasm.edit_pdf(PDF, { items: [item], fonts });
    const text = new TextDecoder("latin1").decode(out);
    expect(text).toContain("/Type0");
    expect(text).toContain("/CIDFontType2");
    // A face the job does not carry, or bytes that are not a font.
    expect(() => wasm.edit_pdf(PDF, { items: [{ ...item, faces: ["sans", "nope"] }], fonts })).toThrow("Invalid edit settings: items[0].faces");
    expect(() => wasm.edit_pdf(PDF, { items: [item], fonts: [{ id: "sans", bytes: new Uint8Array(8) }, fonts[1]] })).toThrow("Invalid edit settings: font");
    expect(() => wasm.edit_pdf(PDF, { items: [{ ...item, family: "fancy" }], fonts })).toThrow("Invalid edit settings: items[0].family");
  });

  it("refuses more than 20 fonts or 64 MiB of them before copying", () => {
    const one = { id: "x", bytes: new Uint8Array(1) };
    const many = Array.from({ length: 21 }, (_, i) => ({ ...one, id: `f${i}` }));
    expect(() => wasm.edit_pdf(PDF, { items: [], fonts: many })).toThrow("Invalid edit settings: font");
    // Views over one 40 MiB buffer: the total is counted on the lengths, nothing is copied.
    const big = new Uint8Array(40 << 20);
    expect(() => wasm.edit_pdf(PDF, { items: [], fonts: [{ id: "a", bytes: big }, { id: "b", bytes: big }] })).toThrow("Invalid edit settings: font");
    expect(() => wasm.layout_text([big, big], "x", 12, 100, 100, "auto", 1.2)).toThrow("Invalid edit settings: font");
  });

  it("lays out text for the preview as the PDF will", () => {
    const layout = wasm.layout_text([font("NotoSans-subset.ttf"), font("NotoSansHebrew-subset.ttf")], "Hi שלום\nmore", 12, 200, 100, "auto", 1.2) as {
      lines: { baselineY: number; runs: { face: number; rtl: boolean; x: number; width: number; text: string }[] }[];
      missing: string;
    };
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[0].runs.map((r) => [r.face, r.rtl, r.text])).toEqual([[0, false, "Hi "], [1, true, "שלום"]]);
    expect(layout.lines[1].baselineY - layout.lines[0].baselineY).toBeCloseTo(14.4);
    expect(layout.missing).toBe("");
    expect(() => wasm.layout_text([font("NotoSans-subset.ttf")], "x", 12, 100, 100, "justify", 1.2)).toThrow("Invalid edit settings: align");
  });

  it("pdf.js reads Noto text in reading order, also across lines and with harakat", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const fonts = [
      { id: "sans", bytes: font("NotoSans-subset.ttf") },
      { id: "ar", bytes: font("NotoSansArabic-subset.ttf") },
      { id: "he", bytes: font("NotoSansHebrew-subset.ttf") },
    ];
    const box = (text: string, y: number, width: number) => ({
      kind: "text", page: 1, rect: [50, y, width, 80], text, family: "noto", font: "Noto Sans",
      faces: ["sans", "ar", "he"], fakeBold: [], size: 14, color: [0, 0, 0], opacity: 1, align: "auto", lineHeight: 1.2,
    });
    // "مرحبا" ends the first line, "بالعالم" starts the second.
    const items = [box("Hi مرحبا بالعالم", 600, 90), box("مَرْحَبًا שָׁלוֹם", 400, 400)];
    const out = wasm.edit_pdf(PDF, { items, fonts });
    const doc = await pdfjs.getDocument({ data: out, verbosity: 0 }).promise;
    const content = await (await doc.getPage(1)).getTextContent();
    const text = content.items.map((i) => ("str" in i ? i.str : "")).join("|");
    for (const word of ["مرحبا", "بالعالم", "مَرْحَبًا", "שָׁלוֹם"]) expect(text).toContain(word);
    await doc.destroy();
  });

  it("fits a box to the engine's lines: two and three Arabic lines all show", () => {
    const fonts = [font("NotoSans-subset.ttf"), font("NotoSansArabic-subset.ttf")];
    for (const text of ["مرحبا\nبالعالم", "مرحبا\nبالعالم\nالسلام"]) {
      const lines = text.split("\n").length;
      // The box the editor's estimate gives (textFit): too short for Noto Sans Arabic.
      const estimated = fitTextRect([50, 600, 200, 10], text, "Helvetica", 14, 1.2);
      type Layout = { lines: unknown[]; height: number };
      const first = wasm.layout_text(fonts, text, 14, 200, estimated[3], "auto", 1.2) as Layout;
      // Fitted to the height the engine reports, every line shows.
      const fitted = fitRectToHeight(estimated, first.height);
      const again = wasm.layout_text(fonts, text, 14, 200, fitted[3], "auto", 1.2) as Layout;
      expect(again.lines).toHaveLength(lines);
      expect(fitted[1] + fitted[3]).toBeCloseTo(estimated[1] + estimated[3]);
    }
  });

  it("keeps preview fonts in a store: copied once, laid out by id, bounded", () => {
    const sans = font("NotoSans-subset.ttf");
    const sc = font("NotoSansSC-subset.ttf");
    const store = new wasm.FontStore();
    store.add("sans", sans);
    store.add("sc", sc);
    expect(store.has("sc")).toBe(true);
    const held = store.layout_text(["sans", "sc"], "Hi 你好", 12, 200, 100, "auto", 1.2);
    expect(held).toEqual(wasm.layout_text([sans, sc], "Hi 你好", 12, 200, 100, "auto", 1.2));
    expect(() => store.layout_text(["nope"], "x", 12, 10, 10, "auto", 1.2)).toThrow("Invalid edit settings: font");
    // 64 MiB together at most, checked before copying.
    const big = new Uint8Array(40 << 20);
    store.add("big", big);
    expect(() => store.add("bigger", big)).toThrow("Invalid edit settings: font");
    expect(store.has("bigger")).toBe(false);
    store.free();
  });
});
