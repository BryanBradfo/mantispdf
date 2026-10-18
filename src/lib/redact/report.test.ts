import { describe, expect, it } from "vitest";
import { REPORT_TITLE, reportLines, uncoveredNote } from "./report";
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
      "2 images removed entirely (could not be edited safely).",
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
