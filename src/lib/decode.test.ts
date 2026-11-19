import { describe, expect, it } from "vitest";
import { DECODE_GLYPHS, decodeDuration, scrambleFrame } from "./decode";

/** A deterministic `rand` cycling through the given values. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe("scrambleFrame", () => {
  it("returns the final text exactly at progress 1 (and beyond)", () => {
    const text = "Supprimer les pages d’un PDF";
    expect(scrambleFrame(text, 1, Math.random)).toBe(text);
    expect(scrambleFrame(text, 1.5, Math.random)).toBe(text);
  });

  it("keeps spaces and no-break spaces in place at every step", () => {
    const text = "Merge PDF files";
    for (const p of [0, 0.2, 0.5, 0.8]) {
      const frame = Array.from(scrambleFrame(text, p, Math.random));
      expect(frame[5]).toBe(" ");
      expect(frame[9]).toBe(" ");
      expect(frame).toHaveLength(Array.from(text).length);
    }
  });

  it("settles left to right: the prefix matches the final text, the rest is glyphs", () => {
    const text = "ABCDEFGHIJ";
    const frame = scrambleFrame(text, 0.4, () => 0);
    expect(frame.slice(0, 4)).toBe("ABCD");
    expect([...frame.slice(4)].every((ch) => ch === DECODE_GLYPHS[0])).toBe(true);
  });

  it("draws unsettled characters from the glyph set only", () => {
    const frame = scrambleFrame("éèà’ç", 0, Math.random);
    expect([...frame].every((ch) => DECODE_GLYPHS.includes(ch))).toBe(true);
  });

  it("is deterministic for an injected rand", () => {
    expect(scrambleFrame("Compress PDF", 0.25, seq(0.1, 0.7, 0.3))).toBe(
      scrambleFrame("Compress PDF", 0.25, seq(0.1, 0.7, 0.3)),
    );
  });

  it("keeps accented code points whole once settled", () => {
    expect(scrambleFrame("Éditer", 0.5, () => 0).slice(0, 3)).toBe("Édi");
  });
});

describe("decodeDuration", () => {
  it("stays between 400 and 600 ms", () => {
    expect(decodeDuration("PDF")).toBe(400);
    expect(decodeDuration("Supprimer les métadonnées du document")).toBe(600);
    const mid = decodeDuration("Compress PDF files");
    expect(mid).toBeGreaterThanOrEqual(400);
    expect(mid).toBeLessThanOrEqual(600);
  });
});
