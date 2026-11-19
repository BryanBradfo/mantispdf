import { describe, expect, it } from "vitest";
import type { EditJobSpec } from "../editor/toJob";
import { attachJobFonts, jobFontFiles } from "./jobFonts";

const text = (faces: string[] | null) =>
  ({
    kind: "text",
    page: 1,
    rect: [0, 0, 10, 10],
    text: "x",
    size: 12,
    color: [0, 0, 0],
    opacity: 1,
    align: "auto",
    lineHeight: 1.2,
    ...(faces ? { family: "noto", font: "Noto Sans", faces, fakeBold: [] } : { font: "Helvetica" }),
  }) as EditJobSpec["items"][number];

describe("job fonts", () => {
  it("lists each font file once, in first-use order", () => {
    const job: EditJobSpec = { items: [text(["A.ttf", "B.ttf"]), text(null), text(["B.ttf", "C.ttf"])] };
    expect(jobFontFiles(job)).toEqual(["A.ttf", "B.ttf", "C.ttf"]);
  });

  it("attaches the bytes through the loader, and nothing for standard text", async () => {
    const asked: string[] = [];
    const loader = {
      font: async (file: string) => {
        asked.push(file);
        return new Uint8Array([file.length]);
      },
    };
    const job: EditJobSpec = { items: [text(["A.ttf"]), text(["A.ttf", "BB.ttf"])] };
    const out = await attachJobFonts(job, loader);
    expect(out.fonts).toEqual([
      { id: "A.ttf", bytes: new Uint8Array([5]) },
      { id: "BB.ttf", bytes: new Uint8Array([6]) },
    ]);
    expect(asked).toEqual(["A.ttf", "BB.ttf"]);
    const plain: EditJobSpec = { items: [text(null)] };
    expect(await attachJobFonts(plain, loader)).toBe(plain);
  });
});
