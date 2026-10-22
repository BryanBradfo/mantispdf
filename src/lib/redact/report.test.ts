import { describe, expect, it } from "vitest";
import { TOO_LARGE_REASON, pageLabelText, pageListText, neededRasters, plainReason as plainReasonT, reportLines as reportLinesT, uncoveredNote as uncoveredNoteT } from "./report";
import type { RedactResultWire } from "./toJob";
import { tFor } from "../../i18n/testUtils";

const tEn = tFor("redact");
const reportLines = (r: Parameters<typeof reportLinesT>[0], uncovered: readonly number[] = []) => reportLinesT(r, uncovered, tEn);
const uncoveredNote = (a: readonly number[], b: readonly number[]) => uncoveredNoteT(a, b, tEn);
const plainReason = (reason: string) => plainReasonT(reason, tEn);

const result = (extra: Partial<RedactResultWire> = {}): RedactResultWire => ({
  bytes: new Uint8Array(),
  pagesRedacted: [1],
  pagesRasterized: [],
  glyphsRemoved: 0,
  pathsRemoved: 0,
  imagesRedacted: 0,
  formsRedacted: 0,
  annotationsRemoved: 0,
  ...extra,
});

describe("redaction report", () => {
  it("states what the engine verified", () => {
    expect(tEn("reportTitle")).toBe(
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

describe("redaction report in French", () => {
  const t = tFor("redact", "fr");
  it("reads in French", () => {
    expect(reportLinesT(result({ pagesRedacted: [1, 3], glyphsRemoved: 1, pagesRasterized: [2] }), [], t)).toEqual([
      "2\u00a0pages caviardées.",
      "1\u00a0caractère de texte supprimé.",
      "Converties en images\u00a0: page 2.",
    ]);
    expect(plainReasonT("TYPE3 font", t)).toBe("utilise une police spéciale");
    expect(uncoveredNoteT([4], [], t)).toBe("La recherche n’a pas couvert la page 4\u00a0; vérifiez-la à la main.");
  });
});

describe("French page lists", () => {
  const t = tFor("redact", "fr");
  it("reads naturally after a preposition and as a label", () => {
    expect(t("matches", { count: 3, query: "SMITH", pages: pageListText([1], t) })).toBe(
      "3\u00a0résultats pour «\u00a0SMITH\u00a0» sur la page 1.",
    );
    expect(t("matches", { count: 3, query: "SMITH", pages: pageListText([1, 2], t) })).toBe(
      "3\u00a0résultats pour «\u00a0SMITH\u00a0» sur les pages 1 et 2.",
    );
    expect(t("undecodable", { pages: pageListText([4], t) })).toBe(
      "La recherche peut manquer du texte sur la page 4. Marquez ces zones à la main.",
    );
    expect(pageLabelText([3, 4], t)).toBe("pages 3 et 4");
    expect(pageLabelText([2, 5, 9], t)).toBe("pages 2, 5 et 9");
    expect(reportLinesT(result({ pagesRasterized: [3, 4] }), [], t)).toContain("Converties en images\u00a0: pages 3 et 4.");
  });

  it("keeps English lists as they were", () => {
    expect(pageListText([1, 2, 5], tEn)).toBe("pages 1, 2, 5");
    expect(pageLabelText([4], tEn)).toBe("page 4");
  });
});
