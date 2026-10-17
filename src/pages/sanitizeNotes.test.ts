import { describe, it, expect } from "vitest";
import { imagesCleanedNote, sanitizeWarnings } from "./sanitizeNotes";

const base = { linksKept: 0, linksDropped: 0, commentsKept: 0, commentsDropped: 0, fieldsFlattened: 0, imagesCleaned: 0 };
const ANALYSIS = "Some pages could not be fully analysed and kept all their resources.";
const DEEP = "Some deeply nested content could not be copied.";

describe("sanitizeWarnings", () => {
  it("says nothing without warnings", () => {
    expect(sanitizeWarnings({ ...base, warnings: 0, deepContentDropped: 0 })).toEqual([]);
  });

  it("explains pages that kept all their resources", () => {
    expect(sanitizeWarnings({ ...base, warnings: 2, deepContentDropped: 0 })).toEqual([ANALYSIS]);
  });

  it("explains dropped deep content only when that is the only warning", () => {
    expect(sanitizeWarnings({ ...base, warnings: 1, deepContentDropped: 1 })).toEqual([DEEP]);
  });

  it("explains both when both happened", () => {
    expect(sanitizeWarnings({ ...base, warnings: 3, deepContentDropped: 1 })).toEqual([ANALYSIS, DEEP]);
  });
});

describe("imagesCleanedNote", () => {
  it("counts images whose metadata was removed", () => {
    const report = { ...base, warnings: 0, deepContentDropped: 0 };
    expect(imagesCleanedNote(report)).toBeNull();
    expect(imagesCleanedNote({ ...report, imagesCleaned: 1 })).toBe("1 image had its metadata removed");
    expect(imagesCleanedNote({ ...report, imagesCleaned: 3 })).toBe("3 images had their metadata removed");
  });
});
