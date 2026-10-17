import { describe, expect, it } from "vitest";
import { substituteJsTokens, toWasmJob, type StampJobSpec } from "./stampJob";

describe("substituteJsTokens", () => {
  const ctx = { date: "2026-10-17", filename: "a.pdf" };
  it("replaces date and filename, all occurrences", () => {
    expect(substituteJsTokens("{date} {filename} {date}", ctx)).toBe("2026-10-17 a.pdf 2026-10-17");
  });
  it("leaves Rust tokens and unknown tokens alone", () => {
    expect(substituteJsTokens("{n}/{total} {bates} {x}", ctx)).toBe("{n}/{total} {bates} {x}");
  });
  it("does not interpret replacement patterns in values", () => {
    expect(substituteJsTokens("{filename}", { date: "", filename: "$&x" })).toBe("$&x");
  });
});

describe("toWasmJob", () => {
  const base: StampJobSpec = { pages: "all", texts: [], images: [], numberStart: 1 };
  it("omits bates when absent", () => {
    expect("bates" in toWasmJob(base)).toBe(false);
  });
  it("keeps bates when present", () => {
    const bates = { prefix: "A", suffix: "", start: 1, digits: 6 };
    expect(toWasmJob({ ...base, bates }).bates).toEqual(bates);
  });
});
