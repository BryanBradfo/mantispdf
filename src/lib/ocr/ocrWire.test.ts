// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OcrPageWire, OcrWordWire } from "./textLayerWire";
import { PAGE_KEYS, WORD_KEYS } from "./wireKeys";

/**
 * The wire contract with `crates/mantis-wasm/src/ocr/binding.rs` (keys in `wireKeys.ts`). Every
 * key must appear as a string literal in the binding source, so a rename on either side fails here.
 */
const binding = readFileSync(new URL("../../../crates/mantis-wasm/src/ocr/binding.rs", import.meta.url), "utf8");
const keys = (o: object) => Object.keys(o).sort();

describe("ocr text layer wire shape", () => {
  it("the wire types have exactly the documented keys", () => {
    const word: OcrWordWire = { text: "MANTIS", x: 72, y: 700, w: 120, h: 20, baseline: null, spaceAfter: true, angle: 2 };
    const page: OcrPageWire = { page: 1, words: [word] };
    expect(keys(page)).toEqual([...PAGE_KEYS].sort());
    expect(keys(word)).toEqual([...WORD_KEYS].sort());
  });

  it("the Rust binding reads every key as a literal", () => {
    for (const k of [...PAGE_KEYS, ...WORD_KEYS]) expect(binding.includes(`"${k}"`), k).toBe(true);
  });
});
