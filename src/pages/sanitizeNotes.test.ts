import { describe, it, expect } from "vitest";
import { imagesCleanedNote, sanitizeWarnings } from "./sanitizeNotes";
import { tFor } from "../i18n/testUtils";

const tSan = tFor("sanitize");

const base = { linksKept: 0, linksDropped: 0, commentsKept: 0, commentsDropped: 0, fieldsFlattened: 0, imagesCleaned: 0 };
const ANALYSIS = "Some pages could not be fully analysed and kept all their resources.";
const DEEP = "Some deeply nested content could not be copied.";

describe("sanitizeWarnings", () => {
  it("says nothing without warnings", () => {
    expect(sanitizeWarnings({ ...base, warnings: 0, deepContentDropped: 0 }, tSan)).toEqual([]);
  });

  it("explains pages that kept all their resources", () => {
    expect(sanitizeWarnings({ ...base, warnings: 2, deepContentDropped: 0 }, tSan)).toEqual([ANALYSIS]);
  });

  it("explains dropped deep content only when that is the only warning", () => {
    expect(sanitizeWarnings({ ...base, warnings: 1, deepContentDropped: 1 }, tSan)).toEqual([DEEP]);
  });

  it("explains both when both happened", () => {
    expect(sanitizeWarnings({ ...base, warnings: 3, deepContentDropped: 1 }, tSan)).toEqual([ANALYSIS, DEEP]);
  });
});

describe("imagesCleanedNote", () => {
  it("counts images whose metadata was removed", () => {
    const report = { ...base, warnings: 0, deepContentDropped: 0 };
    expect(imagesCleanedNote(report, tSan)).toBeNull();
    expect(imagesCleanedNote({ ...report, imagesCleaned: 1 }, tSan)).toBe("1 image had its metadata removed");
    expect(imagesCleanedNote({ ...report, imagesCleaned: 3 }, tSan)).toBe("3 images had their metadata removed");
  });
});

describe("sanitize notes in French", () => {
  const t = tFor("sanitize", "fr");
  it("explains in French", () => {
    expect(imagesCleanedNote({ ...base, warnings: 0, deepContentDropped: 0, imagesCleaned: 2 }, t)).toBe(
      "Les métadonnées de 2\u00a0images ont été supprimées",
    );
    expect(sanitizeWarnings({ ...base, warnings: 1, deepContentDropped: 1 }, t)).toEqual([
      "Une partie du contenu très imbriqué n’a pas pu être copiée.",
    ]);
  });
});
