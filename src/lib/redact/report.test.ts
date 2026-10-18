import { describe, expect, it } from "vitest";
import { REPORT_TITLE, TOO_LARGE_REASON, neededRasters, plainReason, reportLines, uncoveredNote } from "./report";
import type { RedactResultWire } from "./toJob";

const result = (extra: Partial<RedactResultWire> = {}): RedactResultWire => ({
  bytes: new Uint8Array(),
  pagesRedacted: [1],
  pagesRasterized: [],
  glyphsRemoved: 0,
  pathsRemoved: 0,
  imagesRedacted: 0,
  imagesRemoved: 0,
  formsRedacted: 0,
  annotationsRemoved: 0,
  ...extra,
});

describe("redaction report", () => {
  it("states what the engine verified", () => {
    expect(REPORT_TITLE).toBe(
      "The marked content was removed and the result was checked: no text, images or drawings remain under the marks.",
    );
  });

  it("lists only what happened, with singular and plural", () => {
    expect(reportLines(result())).toEqual(["1 page redacted."]);
    expect(
      reportLines(
        result({
          pagesRedacted: [1, 3],
          pagesRasterized: [2],
          glyphsRemoved: 1,
          pathsRemoved: 2,
          imagesRedacted: 1,
          imagesRemoved: 2,
          formsRedacted: 1,
          annotationsRemoved: 3,
        }),
      ),
    ).toEqual([
      "2 pages redacted.",
      "1 character of text removed.",
      "1 image blacked out where marked.",
      "2 drawings removed.",
      "1 shared graphic (form XObject) redacted.",
      "3 annotations or links removed.",
      "Converted to images: page 2.",
    ]);
  });

  it("lists the pages where a box was widened over removed text, when the engine says", () => {
    expect(reportLines(result())).not.toContainEqual(expect.stringMatching(/widened/));
    expect(reportLines(result({ widenedPages: [] }))).toEqual(["1 page redacted."]);
    expect(reportLines(result({ widenedPages: [3, 1] }))).toEqual([
      "1 page redacted.",
      "Box widened to cover removed text on page 1",
      "Box widened to cover removed text on page 3",
    ]);
  });

  it("repeats the pages search did not cover", () => {
    expect(uncoveredNote([], [])).toBeNull();
    expect(uncoveredNote([4], [])).toBe("Search did not cover page 4; check it by hand.");
    expect(uncoveredNote([5, 2], [2, 9])).toBe("Search did not cover pages 2, 5, 9; check them by hand.");
    expect(reportLines(result(), [3])).toContain("Search did not cover page 3; check it by hand.");
  });
});

describe("plainReason", () => {
  it("says why a page becomes an image in plain words", () => {
    expect(plainReason("font T: Type3 fonts are not supported")).toBe("uses a special font");
    expect(plainReason("shaped clip path under a redaction area")).toBe("uses complex graphics");
    expect(plainReason("soft mask content under a redaction area")).toBe("uses complex graphics");
    expect(plainReason("pattern under a redaction area")).toBe("uses complex graphics");
    expect(plainReason("scanned image that cannot be edited (DCT too big)")).toBe("contains a scanned image");
    expect(plainReason("image too large to edit in memory")).toBe("contains a very large image");
    expect(plainReason("font F1: named CMap")).toBe("uses content that cannot be edited safely");
    expect(plainReason("")).toBe("uses content that cannot be edited safely");
  });

  it("matches without regard to case", () => {
    expect(plainReason("TYPE3 font")).toBe("uses a special font");
    expect(plainReason("Image Too Large")).toBe("contains a very large image");
  });
});

describe("neededRasters", () => {
  it("reads the pages of the engine's late raster request", () => {
    expect(neededRasters("Invalid redact settings: needs raster [2]")).toEqual([2]);
    expect(neededRasters("Error: Invalid redact settings: needs raster [3, 1,7]")).toEqual([1, 3, 7]);
  });

  it("is null for any other message", () => {
    expect(neededRasters("Invalid redact settings: rects")).toBeNull();
    expect(neededRasters("Invalid redact settings: needs raster []")).toBeNull();
    expect(neededRasters("needs raster [x]")).toBeNull();
  });

  it("explains it in plain words", () => {
    expect(plainReason(TOO_LARGE_REASON)).toBe("contains a very large image");
  });
});

