import { describe, expect, it } from "vitest";
import type { RecognizedWord } from "./engine";
import { wordsToWire } from "./run";

describe("wordsToWire with deskewed words", () => {
  it("sends a turned word's own box, its bottom-left corner and its angle", () => {
    // 300 dpi page image of a 612 x 792 pt page: 1 px = 0.24 pt.
    const word: RecognizedWord = {
      text: "MANTIS",
      bbox: { x0: 273.5, y0: 493.3, x1: 909.1, y1: 628.4 },
      baseline: 613.3,
      confidence: 90,
      lineEnd: true,
      turned: { corner: [277.3, 628.4], width: 632, height: 113, angle: 2.0146, rise: 4 },
    };
    const [w] = wordsToWire([word], [2550, 3300], [612, 792]);
    expect(w.x).toBeCloseTo(277.3 * 0.24, 6);
    expect(w.y).toBeCloseTo(792 - 628.4 * 0.24, 6);
    expect(w.w).toBeCloseTo(632 * 0.24, 6);
    expect(w.h).toBeCloseTo(113 * 0.24, 6);
    expect(w.angle).toBe(2.0146);
    // The baseline is in the word's own frame: `rise` above its bottom edge.
    expect(w.baseline).toBeCloseTo(w.y + 4 * 0.24, 6);
  });

  it("sends no angle for upright words", () => {
    const word: RecognizedWord = { text: "a", bbox: { x0: 0, y0: 0, x1: 100, y1: 100 }, baseline: null, confidence: 90, lineEnd: true };
    const [w] = wordsToWire([word], [2550, 3300], [612, 792]);
    expect(w.angle).toBeUndefined();
  });
});
