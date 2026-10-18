// @vitest-environment node
/**
 * The real engine through its JS bindings (`redact_plan`, `redact` in the wasm package) on a tiny
 * PDF built here: page 1 is redacted in place, page 2 (a Type3 font) needs a raster, made here.
 * Skipped when the package is not built (`npm run build:wasm`).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { PageStatusWire, RedactResultWire } from "./toJob";
import { PLAN_KEYS, RESULT_KEYS } from "./wireKeys";

const PKG = fileURLToPath(new URL("../../../crates/mantis-wasm/pkg/", import.meta.url));
const built = existsSync(`${PKG}mantis_wasm_bg.wasm`);

type Wasm = {
  redact_plan: (pdf: Uint8Array, rects: unknown) => PageStatusWire[];
  redact: (pdf: Uint8Array, job: unknown) => RedactResultWire;
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

const stream = (content: string) => `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;

const PDF = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 612 792] >>",
  "<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /H 7 0 R >> >> >>",
  "<< /Type /Page /Parent 2 0 R /Contents 6 0 R /Resources << /Font << /T 8 0 R >> >> >>",
  stream("BT /H 10 Tf 100 700 Td (Hello World) Tj ET"),
  stream("BT /T 10 Tf 100 700 Td (x) Tj ET"),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  "<< /Type /Font /Subtype /Type3 /FontMatrix [0.001 0 0 0.001 0 0] /FontBBox [0 0 1000 1000] /FirstChar 120 /LastChar 120 /Widths [500] /CharProcs << >> /Encoding << /Differences [120 /x] >> >>",
]);

const rects = [
  { page: 1, rect: [127, 700, 30, 5] },
  { page: 2, rect: [90, 690, 40, 20] },
];

describe.skipIf(!built)("redact_plan / redact bindings", () => {
  it("plans: page 1 in place, page 2 needs a raster", () => {
    const plan = wasm.redact_plan(PDF, rects);
    for (const p of plan) expect(Object.keys(p).sort()).toEqual([...PLAN_KEYS].sort());
    expect(plan[0]).toEqual({ page: 1, reason: null });
    expect(plan[1].page).toBe(2);
    expect(plan[1].reason).toMatch(/Type3/);
  });

  it("redacts, completing page 2 with a raster made here", () => {
    const rgba = new Uint8Array(612 * 792 * 4).fill(255);
    const job = { rects, fill: "black", removeMetadata: true, rasters: [{ page: 2, width: 612, height: 792, dpi: 72, rgba }] };
    const out = wasm.redact(PDF, job);
    expect(Object.keys(out).sort()).toEqual([...RESULT_KEYS].sort());
    expect(new TextDecoder().decode(out.bytes.subarray(0, 5))).toBe("%PDF-");
    expect(out.pagesRedacted).toEqual([1]);
    expect(out.pagesRasterized).toEqual([2]);
    expect(out.glyphsRemoved).toBe(5);
  });

  it("refuses a missing raster and bad shapes with the engine's messages", () => {
    const job = { rects, fill: "black", removeMetadata: true, rasters: [] };
    expect(() => wasm.redact(PDF, job)).toThrow(/^Invalid redact settings: raster \(page 2: /);
    expect(() => wasm.redact(PDF, { ...job, fill: "red" })).toThrow("Invalid redact settings: fill");
    expect(() => wasm.redact_plan(PDF, [{ page: 1, rect: [0, 0, 1] }])).toThrow("Invalid redact settings: rects[0].rect");
    const short = { page: 2, width: 612, height: 792, dpi: 72, rgba: new Uint8Array(4) };
    expect(() => wasm.redact(PDF, { ...job, rasters: [short] })).toThrow("Invalid redact settings: raster");
  });
});
