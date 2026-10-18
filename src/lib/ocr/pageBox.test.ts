// @vitest-environment node
/**
 * The OCR page maps image pixels to the engine's visible page size proportionally
 * (`wordsToWire`). That is right only when pdf.js (which renders the image) and the engine
 * (`visible_page_sizes`, `stamp::geometry::VisibleBox`) see the same visible box. Both take the
 * CropBox clipped to the MediaBox (the MediaBox when they do not overlap), apply /Rotate, and
 * ignore /UserUnit; this checks they agree on such pages. Skipped without the wasm package.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const PKG = fileURLToPath(new URL("../../../crates/mantis-wasm/pkg/", import.meta.url));
const built = existsSync(`${PKG}mantis_wasm_bg.wasm`);

type Wasm = { visible_page_sizes: (pdf: Uint8Array) => Float64Array | number[]; initSync: (m: { module: BufferSource }) => unknown };
let wasm: Wasm;
type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Pdfjs;

beforeAll(async () => {
  if (!built) return;
  wasm = (await import(/* @vite-ignore */ `${PKG}mantis_wasm.js`)) as Wasm;
  wasm.initSync({ module: readFileSync(`${PKG}mantis_wasm_bg.wasm`) });
  pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as Pdfjs;
});

/** A one-page PDF whose page dictionary carries `pageExtra`. */
function onePage(pageExtra: string): Uint8Array {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> ${pageExtra} >>`,
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  bodies.forEach((b, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${b}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

async function pdfjsSize(bytes: Uint8Array): Promise<[number, number]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const v = page.getViewport({ scale: 1 });
  await doc.destroy();
  return [v.width, v.height];
}

const engineSize = (bytes: Uint8Array): [number, number] => {
  const s = Array.from(wasm.visible_page_sizes(bytes));
  return [s[0], s[1]];
};

describe.skipIf(!built)("pdf.js and the engine see the same visible box", () => {
  it.each([
    ["plain MediaBox", "/MediaBox [0 0 612 792]"],
    ["CropBox inside", "/MediaBox [0 0 612 792] /CropBox [50 60 500 700]"],
    ["CropBox partly outside the MediaBox", "/MediaBox [0 0 612 792] /CropBox [-100 -50 400 900]"],
    ["CropBox outside the MediaBox", "/MediaBox [0 0 612 792] /CropBox [700 800 900 1000]"],
    ["rotated with a crop", "/MediaBox [0 0 612 792] /CropBox [10 20 410 620] /Rotate 90"],
    ["UserUnit (ignored by both)", "/MediaBox [0 0 300 400] /UserUnit 2"],
  ])("%s", async (_, extra) => {
    const bytes = onePage(extra);
    const [pw, ph] = await pdfjsSize(bytes);
    const [ew, eh] = engineSize(bytes);
    expect(pw).toBeCloseTo(ew, 6);
    expect(ph).toBeCloseTo(eh, 6);
  });
});
