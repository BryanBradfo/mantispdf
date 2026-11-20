import { describe, expect, it } from "vitest";
import { compareAddedOutline } from "./onPage";

describe("compareAddedOutline", () => {
  it("is about 0.1 em of the word, clamped to 0.5-2 px, and drawn inside the box", () => {
    // 14 pt type on a 612 pt page: 0.1 em is 0.2288 % of the page width.
    expect(compareAddedOutline(14 / 612)).toEqual({
      outlineWidth: "clamp(0.5px, 0.2288cqw, 2px)",
      outlineOffset: "calc(-1 * clamp(0.5px, 0.2288cqw, 2px))",
    });
  });
});
