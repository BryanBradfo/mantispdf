import { describe, expect, it } from "vitest";
import { createBatesTokens, batesRanges, describeBatesRange, formatBates } from "./bates";

describe("bates", () => {
  it("formats with padding", () => {
    expect(formatBates("ACME-", "", 6, 1)).toBe("ACME-000001");
    expect(formatBates("", "-X", 3, 12345)).toBe("12345-X");
  });

  it("advances each file's start by the previous page count", () => {
    const r = batesRanges([10, 20, 7], 1, 6, "ACME-", "");
    expect(r.map((x) => x.start)).toEqual([1, 11, 31]);
    expect(r[2].last).toBe("ACME-000037");
    expect(describeBatesRange(r)).toBe("ACME-000001 to ACME-000037");
  });

  it("handles empty prefix, custom start and a single page", () => {
    const r = batesRanges([1], 42, 4, "", "");
    expect(describeBatesRange(r)).toBe("0042");
  });

  it("returns null with no pages", () => {
    expect(describeBatesRange(batesRanges([], 1, 6, "", ""))).toBeNull();
    expect(describeBatesRange(batesRanges([0], 1, 6, "", ""))).toBeNull();
  });

  it("keeps a running job current when files are added, until invalidateAll", () => {
    const t = createBatesTokens();
    const run = t.run.begin();
    const up = t.upload.begin();
    expect(run()).toBe(true);
    t.upload.begin();
    expect(up()).toBe(false);
    expect(run()).toBe(true);
    t.invalidateAll();
    expect(run()).toBe(false);
  });
});
