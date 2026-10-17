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
  it("passes absolute text placement through", () => {
    const text = {
      template: "Signed on 2026-10-17",
      font: "Helvetica" as const,
      size: 9,
      color: [0, 0, 0] as [number, number, number],
      opacity: 1,
      anchor: "bottom-left" as const,
      marginX: 0,
      marginY: 0,
      at: [100, 50] as [number, number],
      page: 2,
    };
    const out = toWasmJob({ ...base, texts: [text] });
    expect(out.texts[0].at).toEqual([100, 50]);
    expect(out.texts[0].page).toBe(2);
  });
});
