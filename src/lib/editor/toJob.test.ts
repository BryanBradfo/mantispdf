import { describe, expect, it, vi } from "vitest";
import { simplifyStroke } from "./simplify";
import { LIMITS, type ImageItem, type Item, type Point } from "./model";
import { buildEditJob, editJobTransferables, readEditImage, type ImageReader } from "./toJob";

/** Baseline 8-bit JPEG header with an EXIF orientation (big-endian TIFF) and a 4 x 2 frame. */
function jpeg(orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const frame = [8, 0, 2, 0, 4, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0];
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, 0, exif.length + 2, ...exif,
    0xff, 0xc0, 0, frame.length + 2, ...frame,
    0xff, 0xd9,
  ]);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RGBA = { width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 255]) };

/** Reader over in-memory bytes keyed by blob; counts reads and decodes. */
function fakeReader(bytes: Map<Blob, Uint8Array>): ImageReader & { decodes: number; reads: number } {
  const r = {
    decodes: 0,
    reads: 0,
    readBytes: async (blob: Blob) => {
      r.reads++;
      const b = bytes.get(blob);
      if (!b) throw new Error("unknown blob");
      return b;
    },
    decodeRgba: async () => {
      r.decodes++;
      return RGBA;
    },
  };
  return r;
}

function imageItem(blob: Blob, rotation: ImageItem["rotation"] = 0, id = "img"): ImageItem {
  return { id, kind: "image", page: 2, rect: [10, 20, 40, 20], image: { blob, width: 4, height: 2, bytes: 32 }, opacity: 0.8, rotation };
}

describe("readEditImage", () => {
  it("passes a JPEG through and folds the EXIF rotation into the item rotation", async () => {
    const blob = new Blob();
    const reader = fakeReader(new Map([[blob, jpeg(6)]]));
    const out = await readEditImage(blob, 270, reader);
    expect(out.image.kind).toBe("jpeg");
    // EXIF 6 = 90 degrees clockwise, + 270 = 360 = 0.
    expect(out.rotation).toBe(0);
    expect(reader.decodes).toBe(0);
    const plain = fakeReader(new Map([[blob, jpeg(1)]]));
    expect((await readEditImage(blob, 90, plain)).rotation).toBe(90);
    const upsideDown = fakeReader(new Map([[blob, jpeg(3)]]));
    expect((await readEditImage(blob, 180, upsideDown)).rotation).toBe(0);
  });

  it("decodes a mirrored JPEG upright instead (a rotation cannot mirror)", async () => {
    const blob = new Blob();
    const reader = fakeReader(new Map([[blob, jpeg(5)]]));
    const out = await readEditImage(blob, 90, reader);
    expect(out).toEqual({ image: { kind: "rgba", ...RGBA }, rotation: 90 });
  });

  it("decodes other formats to RGBA", async () => {
    const blob = new Blob();
    const reader = fakeReader(new Map([[blob, PNG]]));
    const out = await readEditImage(blob, 0, reader);
    expect(out.image).toEqual({ kind: "rgba", ...RGBA });
    expect(reader.decodes).toBe(1);
  });
});

describe("buildEditJob", () => {
  it("drops ids, keeps paint order and camelCase fields", async () => {
    const items: Item[] = [
      { id: "a", kind: "whiteout", page: 1, rect: [0, 0, 10, 10] },
      {
        id: "b",
        kind: "text",
        page: 1,
        rect: [1, 2, 3, 4],
        text: "Hi",
        font: "Courier",
        size: 12,
        color: [0, 0, 0],
        opacity: 1,
        align: "center",
        lineHeight: 1.2,
      },
      {
        id: "c",
        kind: "line",
        page: 1,
        from: [0, 0],
        to: [5, 5],
        color: [1, 0, 0],
        width: 2,
        opacity: 1,
        arrowStart: true,
        arrowEnd: false,
      },
      {
        id: "d",
        kind: "ellipse",
        page: 3,
        rect: [0, 0, 5, 5],
        stroke: { kind: "none" },
        width: 0,
        fill: { kind: "rgb", color: [0, 1, 0] },
        opacity: 0.5,
      },
      { id: "e", kind: "highlight", page: 1, rect: [0, 0, 5, 5], color: [1, 1, 0], opacity: 0.4 },
    ];
    const job = await buildEditJob(items, fakeReader(new Map()));
    expect(job.items.map((it) => it.kind)).toEqual(["whiteout", "text", "line", "ellipse", "highlight"]);
    for (const it of job.items) expect(it).not.toHaveProperty("id");
    expect(job.items[1]).toStrictEqual({
      kind: "text",
      page: 1,
      rect: [1, 2, 3, 4],
      text: "Hi",
      font: "Courier",
      size: 12,
      color: [0, 0, 0],
      opacity: 1,
      align: "center",
      lineHeight: 1.2,
    });
    expect(job.items[2]).toMatchObject({ arrowStart: true, arrowEnd: false });
    expect(job.items[3]).toMatchObject({ stroke: { kind: "none" }, fill: { kind: "rgb", color: [0, 1, 0] } });
  });

  it("simplifies freehand strokes", async () => {
    const points: Point[] = Array.from({ length: 50 }, (_, i) => [i, 0] as Point);
    const job = await buildEditJob(
      [{ id: "f", kind: "freehand", page: 1, points, color: [0, 0, 0], width: 1, opacity: 1 }],
      fakeReader(new Map()),
    );
    expect(job.items[0]).toMatchObject({ kind: "freehand", points: [[0, 0], [49, 0]] });
  });

  it("re-simplifies every stroke when the job exceeds the 20000 freehand points budget", async () => {
    // 6 zigzag strokes of 4000 points (0.8 pt high): about 15000 points per 4 strokes survive
    // 0.5 pt, so 6 strokes are over budget; at 1 pt only window ends remain.
    const zigzag = (o: number): Point[] => Array.from({ length: 4000 }, (_, i) => [o + i * 0.01, (i % 2) * 0.8] as Point);
    const items: Item[] = Array.from({ length: 6 }, (_, k) => ({
      id: `f${k}`,
      kind: "freehand" as const,
      page: 1,
      points: zigzag(k * 100),
      color: [0, 0, 0] as [number, number, number],
      width: 1,
      opacity: 1,
    }));
    const job = await buildEditJob(items, fakeReader(new Map()));
    const total = job.items.reduce((n, it) => n + (it.kind === "freehand" ? it.points.length : 0), 0);
    expect(total).toBeLessThanOrEqual(LIMITS.freehandPoints);
    // At 1 pt only window ends remain (5 per stroke).
    expect(total).toBe(30);
    // Under budget: strokes keep their 0.5 pt simplification.
    const small = await buildEditJob(items.slice(0, 4), fakeReader(new Map()));
    const smallTotal = small.items.reduce((n, it) => n + (it.kind === "freehand" ? it.points.length : 0), 0);
    expect(smallTotal).toBe(4 * simplifyStroke(zigzag(0)).length);
    expect(smallTotal).toBeGreaterThan(10000);
  });

  it("reads each image file once and transfers each buffer once", async () => {
    const blob = new Blob();
    const reader = fakeReader(new Map([[blob, jpeg(6)]]));
    const readSpy = vi.spyOn(reader, "readBytes");
    const job = await buildEditJob([imageItem(blob, 0, "x"), imageItem(blob, 90, "y")], reader);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(job.items).toEqual([
      { kind: "image", page: 2, rect: [10, 20, 40, 20], image: { kind: "jpeg", bytes: jpeg(6) }, opacity: 0.8, rotation: 90 },
      { kind: "image", page: 2, rect: [10, 20, 40, 20], image: { kind: "jpeg", bytes: jpeg(6) }, opacity: 0.8, rotation: 180 },
    ]);
    expect(editJobTransferables(job)).toHaveLength(1);
  });
});

describe("buildEditJob text fonts", () => {
  const box = (font: Item & { kind: "text" } extends { font: infer F } ? F : never, text: string): Item => ({
    id: "t",
    kind: "text",
    page: 1,
    rect: [1, 2, 3, 4],
    text,
    font,
    size: 12,
    color: [0, 0, 0],
    opacity: 1,
    align: "auto",
    lineHeight: 1.2,
  });

  it("sends embedded-font boxes with their font files and keeps standard ones as they were", async () => {
    const resolver = vi.fn((item: { text: string }) =>
      item.text === "ok" ? { family: "standard" as const, font: "Courier" as const } : { family: "noto" as const, faces: ["A.ttf", "B.ttf"], fakeBold: ["B.ttf"] },
    );
    const job = await buildEditJob([box("Courier", "ok"), box("Helvetica-Bold", "你好")], undefined, resolver);
    expect(job.items[0]).toEqual({ kind: "text", page: 1, rect: [1, 2, 3, 4], text: "ok", font: "Courier", size: 12, color: [0, 0, 0], opacity: 1, align: "auto", lineHeight: 1.2 });
    expect(job.items[1]).toMatchObject({ family: "noto", font: "Helvetica-Bold", faces: ["A.ttf", "B.ttf"], fakeBold: ["B.ttf"], align: "auto" });
    expect(job.items[1]).not.toHaveProperty("id");
    expect(job.fonts).toBeUndefined();
  });
});
