// @vitest-environment node
/**
 * The real engine through its JS binding (`edit_pdf` in the wasm package), for what only the
 * binding can show. Skipped when the package is not built (`npm run build:wasm`).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const PKG = fileURLToPath(new URL("../../../crates/mantis-wasm/pkg/", import.meta.url));
const built = existsSync(`${PKG}mantis_wasm_bg.wasm`);
const PDF = new Uint8Array(readFileSync(new URL("../../../e2e/fixtures/one-page.pdf", import.meta.url)));

type Wasm = { edit_pdf: (pdf: Uint8Array, job: unknown) => Uint8Array; initSync: (m: { module: BufferSource }) => unknown };
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
});
