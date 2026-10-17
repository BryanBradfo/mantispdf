import { describe, expect, it } from "vitest";
import { isJpeg, orientationToTransform, readExifOrientation, type Orientation } from "./imageInput";

function exifJpeg(little: boolean, value: number, tag = 0x0112): Uint8Array {
  const u16 = (v: number) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) => (little ? [v & 255, (v >> 8) & 255, 0, 0] : [0, 0, (v >> 8) & 255, v & 255]);
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(1),
    ...u16(tag),
    ...u16(3),
    ...u32(1),
    ...u16(value),
    0,
    0,
    ...u32(0),
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = payload.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...payload, 0xff, 0xd9]);
}

describe("readExifOrientation", () => {
  it("reads every value in both byte orders", () => {
    for (const little of [true, false]) {
      for (let v = 1; v <= 8; v++) expect(readExifOrientation(exifJpeg(little, v))).toBe(v);
    }
  });

  it("defaults to 1 when the tag is missing or out of range", () => {
    expect(readExifOrientation(exifJpeg(true, 6, 0x0100))).toBe(1);
    expect(readExifOrientation(exifJpeg(false, 9))).toBe(1);
    expect(readExifOrientation(exifJpeg(false, 0))).toBe(1);
  });

  it("skips earlier segments", () => {
    const e = exifJpeg(true, 8);
    const app0 = [0xff, 0xe0, 0, 4, 0, 0];
    const bytes = new Uint8Array([0xff, 0xd8, ...app0, ...e.slice(2)]);
    expect(readExifOrientation(bytes)).toBe(8);
  });

  it("is safe on garbage and truncation", () => {
    expect(readExifOrientation(new Uint8Array())).toBe(1);
    expect(readExifOrientation(new Uint8Array([1, 2, 3, 4, 5]))).toBe(1);
    expect(readExifOrientation(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(1);
    const good = exifJpeg(true, 6);
    for (let n = 0; n < good.length; n++) expect(readExifOrientation(good.slice(0, n))).toBeLessThanOrEqual(8);
    const noise = new Uint8Array(200).map((_, i) => (i * 37 + 11) & 255);
    noise[0] = 0xff;
    noise[1] = 0xd8;
    noise[2] = 0xff;
    expect(readExifOrientation(noise)).toBe(1);
    const huge = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45]);
    expect(readExifOrientation(huge)).toBe(1);
  });

  it("finds Exif after an XMP APP1", () => {
    const xmp = [0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x6e, 0x73, 0x2e, 0x61, 0x64, 0x6f, 0x62, 0x65, 0x2e, 0x63];
    const seg = [0xff, 0xe1, 0, xmp.length + 2, ...xmp];
    const e = exifJpeg(false, 6);
    expect(readExifOrientation(new Uint8Array([0xff, 0xd8, ...seg, ...e.slice(2)]))).toBe(6);
  });

  it("reads a LONG-typed tag", () => {
    const b = exifJpeg(true, 6);
    // type field of the entry: 2 (SOI) + 4 (marker, len) + 6 (Exif) + 8 (header) + 2 (count) + 2 (tag)
    b[2 + 4 + 6 + 8 + 2 + 2] = 4;
    expect(readExifOrientation(b)).toBe(6);
  });

  it("returns 1 for exact truncations", () => {
    const b = exifJpeg(true, 6);
    const ifdStart = 2 + 4 + 6 + 8;
    expect(readExifOrientation(b.slice(0, ifdStart + 2))).toBe(1);
    expect(readExifOrientation(b.slice(0, ifdStart + 2 + 11))).toBe(1);
    const far = exifJpeg(true, 6);
    far[2 + 4 + 6 + 4] = 200; // IFD offset past the segment end
    expect(readExifOrientation(far)).toBe(1);
  });

  it("works on a subarray view", () => {
    const e = exifJpeg(false, 3);
    const padded = new Uint8Array([9, 9, ...e]);
    expect(readExifOrientation(padded.subarray(2))).toBe(3);
  });
});

describe("orientationToTransform", () => {
  it("follows the standard table", () => {
    const expected: Record<Orientation, [number, boolean]> = {
      1: [0, false],
      2: [0, true],
      3: [180, false],
      4: [180, true],
      5: [270, true],
      6: [90, false],
      7: [90, true],
      8: [270, false],
    };
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      expect(orientationToTransform(o)).toEqual({ rotate: expected[o][0], flipX: expected[o][1] });
    }
  });
});

describe("isJpeg", () => {
  it("checks the SOI marker", () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isJpeg(new Uint8Array())).toBe(false);
  });
});
