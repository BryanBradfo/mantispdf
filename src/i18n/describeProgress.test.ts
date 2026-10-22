import { describe, it, expect } from "vitest";
import { describeProgress } from "./describeProgress";
import { tFor } from "./testUtils";

describe("describeProgress", () => {
  const en = tFor("common");
  const fr = tFor("common", "fr");

  it("keeps the engine's English wording", () => {
    expect(describeProgress(null, en)).toBe("");
    expect(describeProgress({ step: "starting" }, en)).toBe("Starting…");
    expect(describeProgress({ step: "splitting", parts: 3 }, en)).toBe("Splitting into 3 parts…");
    expect(describeProgress({ step: "extracting", part: 2, of: 3 }, en)).toBe("Extracting part 2 of 3…");
    expect(describeProgress({ step: "preparing" }, en)).toBe("Preparing download…");
    expect(describeProgress({ step: "merging", count: 2 }, en)).toBe("Merging 2 documents…");
    expect(describeProgress({ step: "done" }, en)).toBe("Done");
  });

  it("speaks French", () => {
    expect(describeProgress({ step: "splitting", parts: 3 }, fr)).toBe("Découpage en 3 parties…");
    expect(describeProgress({ step: "extracting", part: 2, of: 3 }, fr)).toBe("Extraction de la partie 2 sur 3…");
    expect(describeProgress({ step: "merging", count: 2 }, fr)).toBe("Fusion de 2 documents…");
  });
});
