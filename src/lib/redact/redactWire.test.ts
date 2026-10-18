// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addMarks, initialMarks, togglePage } from "./model";
import { toJob } from "./toJob";
import { FILLS, JOB_KEYS, PLAN_KEYS, RASTER_KEYS, RECT_KEYS, RESULT_KEYS, SEARCH_KEYS, SEARCH_OPTION_KEYS, SEARCH_PAGE_KEYS } from "./wireKeys";

/**
 * The wire contract with `crates/mantis-wasm/src/redact/binding.rs` (keys in `wireKeys.ts`).
 * Every key must appear as a string literal in the binding source, so a rename on either side
 * fails here.
 */
const binding = readFileSync(new URL("../../../crates/mantis-wasm/src/redact/binding.rs", import.meta.url), "utf8");
const keys = (o: object) => Object.keys(o).sort();

describe("redact wire shape", () => {
  it("builds a job with exactly the keys the binding reads", () => {
    let s = initialMarks();
    s = addMarks(s, [{ kind: "area", page: 1, rect: [10, 20, 30, 40] }]);
    s = togglePage(s, 2);
    const raster = { page: 2, width: 1, height: 1, dpi: 200, rgba: new Uint8Array(4) };
    const job = toJob(s.marks, [[600, 800], [500, 700]], { fill: "white", removeMetadata: false }, [raster]);
    expect(keys(job)).toEqual([...JOB_KEYS].sort());
    for (const r of job.rects) expect(keys(r)).toEqual([...RECT_KEYS].sort());
    for (const r of job.rasters) expect(keys(r)).toEqual([...RASTER_KEYS].sort());
    expect(job.fill).toBe("white");
    expect(job.rects).toEqual([
      { page: 1, rect: [10, 20, 30, 40] },
      { page: 2, rect: [0, 0, 500, 700] },
    ]);
  });

  it("the Rust binding reads and writes every key as a literal", () => {
    for (const k of [...RECT_KEYS, ...JOB_KEYS, ...RASTER_KEYS, ...FILLS, ...PLAN_KEYS, ...RESULT_KEYS, ...SEARCH_OPTION_KEYS, ...SEARCH_KEYS, ...SEARCH_PAGE_KEYS]) {
      expect(binding.includes(`"${k}"`), k).toBe(true);
    }
  });
});
