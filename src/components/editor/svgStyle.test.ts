import { describe, expect, it } from "vitest";
import { ascent } from "../../lib/editor/afm";
import { CSS_FONT_METRICS, textareaBaselineShift } from "./svgStyle";

describe("textareaBaselineShift", () => {
  it("moves the first CSS baseline onto the engine's first baseline (top - ascent * size / 1000)", () => {
    for (const font of ["Helvetica", "Helvetica-Bold", "Times-Roman", "Courier"] as const) {
      for (const lineHeight of [0.8, 1.2, 2]) {
        const { ascent: a, descent: d } = CSS_FONT_METRICS[font];
        // CSS: half-leading above the content area, then the font ascent.
        const cssBaseline = (lineHeight - (a + d)) / 2 + a;
        expect(cssBaseline + textareaBaselineShift(font, lineHeight)).toBeCloseTo(ascent(font) / 1000, 10);
      }
    }
  });

  it("is about a quarter em upwards for Helvetica at line height 1.2", () => {
    expect(textareaBaselineShift("Helvetica", 1.2)).toBeCloseTo(-0.2285, 3);
  });
});
