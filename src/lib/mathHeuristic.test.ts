import { describe, it, expect } from "vitest";
import {
  detectMathRegions,
  symbolDensity,
  type ExtractedPage,
  type ExtractedTextItem,
} from "./mathHeuristic";

// Fixtures taken from the REAL liteparse spike output on sample-paper.pdf
// (the PINN/Poisson paper): body text in LiberationSerif, the display
// equations partly in NotoSans, an oversized Σ, headings in Bold.
function item(p: Partial<ExtractedTextItem>): ExtractedTextItem {
  return {
    text: "",
    x: 0,
    y: 0,
    width: 0,
    height: 16,
    rotation: 0,
    font_name: "BAAAAA+LiberationSerif",
    font_size: 14,
    ...p,
  };
}

const PAGE: ExtractedPage = {
  page_number: 1,
  page_width: 612,
  page_height: 792,
  text: "",
  text_items: [
    item({ text: "Physics-Informed Neural Networks", x: 178, y: 72.6, width: 256.7, font_name: "AAAAAA+LiberationSerif-Bold", font_size: 22.66 }),
    item({ text: "boundary data, removing the need for a meshed solver.", x: 101.7, y: 207.8, width: 219.3, font_size: 13.33 }),
    item({ text: "−Δu(x) = f(x),  x ∈ Ω,   u(x) = g(x),  x ∈ ∂Ω.", x: 196.8, y: 295.4, width: 219.1, font_size: 16 }), // eq (1)
    item({ text: "ℒ(θ) = ℒdata(θ) + λ ℒpde", x: 239.4, y: 356.2, width: 117, font_name: "EAAAAA+NotoSans-Regular", font_size: 16 }), // eq (2)
    item({ text: "(θ) = 1", x: 240.4, y: 422.8, width: 41.3, font_size: 16 }), // eq (3) fragments…
    item({ text: "ℒpde", x: 218.2, y: 428.9, width: 22.2, font_name: "EAAAAA+NotoSans-Regular", font_size: 16 }),
    item({ text: "Σ ∣ Δuθ", x: 295.9, y: 428.9, width: 39.1, font_size: 25.33 }),
    item({ text: "Minimizing ℒ(θ) drives the network toward a solution that is consistent with both the observed data and", x: 75.8, y: 470.5, width: 461.2, font_size: 14.66 }),
  ],
};

describe("symbolDensity", () => {
  it("is high for an equation and low for prose", () => {
    expect(symbolDensity("ℒ(θ) = ℒdata(θ) + λ ℒpde")).toBeGreaterThan(0.3);
    expect(symbolDensity("boundary data, removing the need for a meshed solver.")).toBeLessThan(0.1);
  });
});

describe("detectMathRegions", () => {
  const regions = detectMathRegions([PAGE]);
  const allText = regions.map((r) => r.text).join(" || ");

  it("detects the display equations", () => {
    // eq(1), eq(2), and the eq(3) fragment cluster → at least two blocks.
    expect(regions.length).toBeGreaterThanOrEqual(2);
    expect(allText).toContain("ℒ"); // the script-L from eq (2)/(3)
    expect(allText).toContain("Δu(x)"); // eq (1)
  });

  it("does NOT flag prose or headings as math", () => {
    expect(allText).not.toContain("boundary data");
    expect(allText).not.toContain("Physics-Informed"); // heading: centered + outlier but no symbols
    expect(allText).not.toContain("Minimizing"); // inline ℒ, but mostly prose → low density
  });

  it("clusters the shattered eq(3) fragments into one block", () => {
    // "(θ) = 1", "ℒpde", "Σ ∣ Δuθ" sit at nearly the same y → one region.
    const eq3 = regions.find((r) => r.text.includes("Σ"));
    expect(eq3).toBeDefined();
    expect(eq3!.itemCount).toBeGreaterThanOrEqual(2);
  });
});
