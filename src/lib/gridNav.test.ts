import { describe, expect, it } from "vitest";
import { gridStep, listStep } from "./gridNav";

describe("gridStep (3 columns)", () => {
  it("Left/Right move by a column, wrapping through the grid", () => {
    expect(gridStep(0, "ArrowRight", 3, 9)).toBe(1);
    expect(gridStep(2, "ArrowRight", 3, 9)).toBe(3);
    expect(gridStep(8, "ArrowRight", 3, 9)).toBe(0);
    expect(gridStep(0, "ArrowLeft", 3, 9)).toBe(8);
    expect(gridStep(4, "ArrowLeft", 3, 9)).toBe(3);
  });
  it("Up/Down move by a row, staying in the column", () => {
    expect(gridStep(1, "ArrowDown", 3, 9)).toBe(4);
    expect(gridStep(7, "ArrowDown", 3, 9)).toBe(1);
    expect(gridStep(1, "ArrowUp", 3, 9)).toBe(7);
    expect(gridStep(5, "ArrowUp", 3, 9)).toBe(2);
  });
  it("two-row grid: Down from the top row reaches the bottom row", () => {
    expect(gridStep(2, "ArrowDown", 3, 6)).toBe(5);
    expect(gridStep(5, "ArrowDown", 3, 6)).toBe(2);
    expect(gridStep(0, "ArrowUp", 3, 6)).toBe(3);
  });
  it("other keys return null", () => {
    expect(gridStep(0, "Enter", 3, 9)).toBeNull();
  });
});

describe("listStep (tabs)", () => {
  it("Left/Right wrap, Home/End jump, other keys are ignored", () => {
    expect(listStep(0, "ArrowRight", 3)).toBe(1);
    expect(listStep(2, "ArrowRight", 3)).toBe(0);
    expect(listStep(0, "ArrowLeft", 3)).toBe(2);
    expect(listStep(1, "Home", 3)).toBe(0);
    expect(listStep(0, "End", 3)).toBe(2);
    expect(listStep(1, "ArrowDown", 3)).toBeNull();
    expect(listStep(1, "a", 3)).toBeNull();
  });
});
