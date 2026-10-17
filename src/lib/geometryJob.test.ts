import { describe, expect, it } from "vitest";
import { PAPER_SIZES, inToPt, mmToPt, ptToIn, ptToMm } from "./geometryJob";

describe("PAPER_SIZES", () => {
  it("are portrait", () => {
    for (const [w, h] of Object.values(PAPER_SIZES)) expect(w).toBeLessThan(h);
  });
  it("has the expected A4 and Letter sizes", () => {
    expect(PAPER_SIZES.A4).toEqual([595.28, 841.89]);
    expect(PAPER_SIZES.Letter).toEqual([612, 792]);
    expect(Object.keys(PAPER_SIZES)).toEqual(["A3", "A4", "A5", "Letter", "Legal", "Tabloid"]);
  });
});

describe("unit converters", () => {
  it("converts mm to points", () => {
    expect(mmToPt(25.4)).toBeCloseTo(72, 10);
    expect(mmToPt(210)).toBeCloseTo(595.28, 1);
  });
  it("converts inches to points", () => {
    expect(inToPt(1)).toBe(72);
    expect(inToPt(8.5)).toBe(612);
  });
  it("round-trips", () => {
    expect(ptToMm(mmToPt(10))).toBeCloseTo(10, 10);
    expect(ptToIn(inToPt(3.25))).toBeCloseTo(3.25, 10);
  });
});
