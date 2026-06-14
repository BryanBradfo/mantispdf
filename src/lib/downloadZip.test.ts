import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildZip, sanitizeZipNames } from "./downloadZip";

describe("sanitizeZipNames", () => {
  it("preserves legal names including spaces and hyphens", () => {
    expect(sanitizeZipNames(["pages_1-2.pdf", "my report.pdf"])).toEqual([
      "pages_1-2.pdf",
      "my report.pdf",
    ]);
  });

  it("strips path separators and Windows-illegal characters", () => {
    expect(sanitizeZipNames(["a/b:c*?.pdf"])).toEqual(["a_b_c__.pdf"]);
  });

  it("disambiguates duplicate names before the extension", () => {
    expect(sanitizeZipNames(["doc.pdf", "doc.pdf", "doc.pdf"])).toEqual([
      "doc.pdf",
      "doc (1).pdf",
      "doc (2).pdf",
    ]);
  });

  it("dedupes case-insensitively and after sanitization", () => {
    // "a/b.pdf" and "a:b.pdf" both sanitize to "a_b.pdf" → must not collide.
    expect(sanitizeZipNames(["a/b.pdf", "a:b.pdf"])).toEqual(["a_b.pdf", "a_b (1).pdf"]);
  });
});

describe("buildZip", () => {
  it("produces a valid zip whose entries round-trip", async () => {
    const parts = [
      { name: "pages_1-2.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]) },
      { name: "pages_3-5.pdf", bytes: new Uint8Array([9, 8, 7, 6, 5]) },
    ];

    const zipped = await buildZip(parts);

    // A real zip starts with the local-file-header magic "PK\x03\x04".
    expect(Array.from(zipped.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    // Unzipping must recover every entry's exact bytes — this fails if the
    // fflate callback signature is wrong (it would push the error slot / resolve
    // early and yield a corrupt archive).
    const entries = unzipSync(zipped);
    expect(Object.keys(entries).sort()).toEqual(["pages_1-2.pdf", "pages_3-5.pdf"]);
    expect(entries["pages_1-2.pdf"]).toEqual(parts[0].bytes);
    expect(entries["pages_3-5.pdf"]).toEqual(parts[1].bytes);
  });

  it("handles a single entry", async () => {
    const parts = [{ name: "only.pdf", bytes: new Uint8Array([1, 2, 3, 4]) }];
    const zipped = await buildZip(parts);
    const entries = unzipSync(zipped);
    expect(strFromU8(entries["only.pdf"], true)).toBeTypeOf("string");
    expect(entries["only.pdf"]).toEqual(parts[0].bytes);
  });
});
