import { describe, it, expect } from "vitest";
import { normalizeTypographicSpaces } from "./pdfText";
import { toWasmJob } from "./stampJob";
import { toWire } from "./forms/toWire";
import type { FormState } from "./forms/model";
import { charUnits, unsupportedChars, winAnsiByte } from "./editor/afm";
import { buildEditJob } from "./editor/toJob";

// macOS and iOS French typing puts a narrow no-break space (U+202F) before ! ? ; : and some tools
// a thin space (U+2009). Neither is in the standard fonts' WinAnsi set; U+00A0 is.
const TYPED = "Confidentiel\u202f!";
const SAVED = "Confidentiel\u00a0!";

describe("typographic spaces before standard-font text", () => {
  it("become no-break spaces", () => {
    expect(normalizeTypographicSpaces("a\u202fb\u2009c\u00a0d")).toBe("a\u00a0b\u00a0c\u00a0d");
  });

  it("are not reported as unsupported characters", () => {
    expect(unsupportedChars(TYPED)).toBe("");
  });

  it("are normalised in stamp jobs (watermark, page numbers, header and footer, Bates, sign)", () => {
    const job = toWasmJob({
      pages: "all",
      numberStart: 1,
      images: [],
      texts: [
        { template: TYPED, font: "Helvetica", size: 10, color: [0, 0, 0], opacity: 1, anchor: "center", marginX: 0, marginY: 0 },
      ],
    });
    expect(job.texts[0].template).toBe(SAVED);
  });

  it("are normalised in Edit PDF text boxes", async () => {
    const job = await buildEditJob([
      {
        id: "t",
        kind: "text",
        page: 1,
        rect: [0, 0, 100, 20],
        text: TYPED,
        font: "Helvetica",
        size: 12,
        color: [0, 0, 0],
        opacity: 1,
        align: "left",
        lineHeight: 1.2,
      },
    ]);
    expect(job.items[0]).toMatchObject({ kind: "text", text: SAVED });
  });

  it("are normalised in form values", () => {
    const state: FormState = {
      original: new Map([[3, { kind: "none" }]]),
      values: new Map([[3, { kind: "text", text: TYPED }]]),
    };
    expect(toWire(state)).toEqual([{ id: 3, value: { kind: "text", text: SAVED } }]);
  });
});

describe("typographic spaces in text measurement", () => {
  it("measure like the no-break space the engine draws", () => {
    for (const font of ["Helvetica", "Times-Roman", "Courier"] as const) {
      expect(charUnits(font, "\u202f")).toBe(charUnits(font, "\u00a0"));
      expect(charUnits(font, "\u2009")).toBe(charUnits(font, "\u00a0"));
      expect(charUnits(font, "\u00a0")).toBeGreaterThan(0);
    }
    expect(winAnsiByte("\u202f")).toBe(0xa0);
    expect(winAnsiByte("\u2009")).toBe(0xa0);
  });
});
