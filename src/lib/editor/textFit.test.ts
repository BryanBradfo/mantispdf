import { describe, expect, it } from "vitest";
import { layoutText } from "./wrap";
import { fitTextRect, textBoxHeight } from "./textFit";

describe("textBoxHeight", () => {
  it("is ascent to descent for one line, plus one line height per extra line", () => {
    // Helvetica: ascender 718, descender -207.
    expect(textBoxHeight(1, "Helvetica", 10, 1.2)).toBeCloseTo(9.25);
    expect(textBoxHeight(3, "Helvetica", 10, 1.2)).toBeCloseTo(9.25 + 24);
    expect(textBoxHeight(0, "Helvetica", 10, 1.2)).toBeCloseTo(9.25);
  });
});

describe("fitTextRect", () => {
  const style = { font: "Helvetica" as const, size: 12, lineHeight: 1.2 };

  it("grows the box downwards so every line is kept, top edge fixed", () => {
    const text = "one\ntwo\nthree\nfour";
    const rect: [number, number, number, number] = [10, 100, 200, 20];
    const fitted = fitTextRect(rect, text, style.font, style.size, style.lineHeight);
    expect(fitted[0]).toBe(10);
    expect(fitted[2]).toBe(200);
    expect(fitted[1] + fitted[3]).toBeCloseTo(120);
    expect(layoutText(fitted, text, style.font, style.size, "left", style.lineHeight)).toHaveLength(4);
  });

  it("leaves a box that already fits unchanged", () => {
    const rect: [number, number, number, number] = [0, 0, 200, 300];
    expect(fitTextRect(rect, "short", style.font, style.size, style.lineHeight)).toBe(rect);
  });
});
