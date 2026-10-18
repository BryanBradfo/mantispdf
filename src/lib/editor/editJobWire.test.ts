// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Item } from "./model";
import { buildEditJob, type ImageReader } from "./toJob";

/**
 * The wire contract with `crates/mantis-wasm/src/edit_ops/binding.rs`: the keys the Rust binding
 * reads for each item kind. The test also checks every key appears as a string literal in the
 * binding source, so a rename on either side fails here.
 */
const WIRE_KEYS = {
  text: ["kind", "page", "rect", "text", "font", "size", "color", "opacity", "align", "lineHeight"],
  image: ["kind", "page", "rect", "image", "opacity", "rotation"],
  rect: ["kind", "page", "rect", "stroke", "width", "fill", "opacity"],
  ellipse: ["kind", "page", "rect", "stroke", "width", "fill", "opacity"],
  line: ["kind", "page", "from", "to", "color", "width", "opacity", "arrowStart", "arrowEnd"],
  highlight: ["kind", "page", "rect", "color", "opacity"],
  freehand: ["kind", "page", "points", "color", "width", "opacity"],
  whiteout: ["kind", "page", "rect"],
} as const;
const IMAGE_KEYS = { jpeg: ["kind", "bytes"], rgba: ["kind", "width", "height", "pixels"] } as const;
const PAINT_KEYS = { none: ["kind"], rgb: ["kind", "color"] } as const;

const binding = readFileSync(new URL("../../../crates/mantis-wasm/src/edit_ops/binding.rs", import.meta.url), "utf8");
const literal = (s: string) => binding.includes(`"${s}"`);

/** Baseline 8-bit JPEG (4 x 2, no EXIF orientation). */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 2, 0, 4, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9,
]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const jpegBlob = new Blob([JPEG]);
const pngBlob = new Blob([PNG]);
const reader: ImageReader = {
  readBytes: async (blob) => (blob === jpegBlob ? JPEG : PNG),
  decodeRgba: async () => ({ width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 255]) }),
};

const base = { page: 1, opacity: 1 };
const rgb: [number, number, number] = [0, 0, 0];
const items: Item[] = [
  { ...base, id: "1", kind: "text", rect: [0, 0, 9, 9], text: "a", font: "Helvetica", size: 12, color: rgb, align: "left", lineHeight: 1.2 },
  { ...base, id: "2", kind: "image", rect: [0, 0, 9, 9], image: { blob: jpegBlob, width: 4, height: 2, bytes: jpegBlob.size }, rotation: 0 },
  { ...base, id: "3", kind: "image", rect: [0, 0, 9, 9], image: { blob: pngBlob, width: 1, height: 1, bytes: 4 }, rotation: 90 },
  { ...base, id: "4", kind: "rect", rect: [0, 0, 9, 9], stroke: { kind: "rgb", color: rgb }, width: 1, fill: { kind: "none" } },
  { ...base, id: "5", kind: "ellipse", rect: [0, 0, 9, 9], stroke: { kind: "none" }, width: 1, fill: { kind: "rgb", color: rgb } },
  { ...base, id: "6", kind: "line", from: [0, 0], to: [5, 5], color: rgb, width: 2, arrowStart: false, arrowEnd: true },
  { ...base, id: "7", kind: "highlight", rect: [0, 0, 9, 9], color: rgb },
  { ...base, id: "8", kind: "freehand", points: [[0, 0], [5, 5], [9, 0]], color: rgb, width: 2 },
  { id: "9", kind: "whiteout", page: 1, rect: [0, 0, 9, 9] },
];

const keys = (o: object) => Object.keys(o).sort();

describe("edit-pdf wire shape", () => {
  it("each item kind carries exactly the keys the Rust binding reads", async () => {
    const job = await buildEditJob(items, reader);
    expect(new Set(job.items.map((i) => i.kind))).toEqual(new Set(Object.keys(WIRE_KEYS)));
    for (const it of job.items) {
      expect(keys(it), it.kind).toEqual([...WIRE_KEYS[it.kind]].sort());
      if (it.kind === "image") expect(keys(it.image)).toEqual([...IMAGE_KEYS[it.image.kind]].sort());
      if (it.kind === "rect" || it.kind === "ellipse") {
        for (const p of [it.stroke, it.fill]) expect(keys(p)).toEqual([...PAINT_KEYS[p.kind]].sort());
      }
    }
    expect(job.items.map((i) => (i.kind === "image" ? i.image.kind : null)).filter(Boolean)).toEqual(["jpeg", "rgba"]);
  });

  it("the Rust binding reads every key and kind as a literal", () => {
    const all = new Set<string>([...Object.keys(WIRE_KEYS), ...Object.values(WIRE_KEYS).flat(), ...Object.values(IMAGE_KEYS).flat(), ...Object.values(PAINT_KEYS).flat(), "none", "rgb", "jpeg", "rgba", "items"]);
    const missing = [...all].filter((k) => !literal(k));
    expect(missing).toEqual([]);
  });
});
