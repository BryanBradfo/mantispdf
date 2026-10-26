import { describe, it, expect } from "vitest";
import { tFor } from "./testUtils";
import { missedPagesProblem } from "../lib/cropBox";

/** "and N more" agrees with N in French ("et 1 autre", "et 3 autres"); English is unchanged. */
describe("'and N more' is plural-aware", () => {
  it("in Fill form's required-fields dialog", () => {
    expect(tFor("fillForm", "fr")("missingMore", { count: 1 })).toBe(" et 1 autre");
    expect(tFor("fillForm", "fr")("missingMore", { count: 3 })).toBe(" et 3 autres");
    expect(tFor("fillForm")("missingMore", { count: 1 })).toBe(" and 1 more");
  });

  it("in Redact's page list", () => {
    expect(tFor("redact", "fr")("listMore", { list: "1, 2", count: 1 })).toBe("1, 2 et 1 autre");
    expect(tFor("redact")("listMore", { list: "1, 2", count: 4 })).toBe("1, 2 and 4 more");
  });

  it("in Crop's missed pages", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => i + 1);
    expect(missedPagesProblem(eleven, tFor("crop", "fr"))).toBe(
      "La zone de rognage ne couvre pas les pages 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 et 1 autre. Utilisez une plage de pages ou la détection automatique.",
    );
    expect(missedPagesProblem(eleven, tFor("crop"))).toBe(
      "The crop area misses pages 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 and 1 more. Use a page range or auto-detect.",
    );
  });
});
