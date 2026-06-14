import { describe, it, expect } from "vitest";
import { validatePdfFile, readFileAsArrayBuffer, readFileAsUint8Array } from "./fileHelpers";

describe("validatePdfFile", () => {
  it("accepts a PDF file", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "doc.pdf", { type: "application/pdf" });
    expect(validatePdfFile(file)).toBeNull();
  });

  it("rejects a non-PDF file with a message", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    expect(validatePdfFile(file)).toBe("Please upload a PDF file.");
  });
});

describe("readFileAsArrayBuffer / readFileAsUint8Array", () => {
  it("reads the exact bytes of a file", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const file = new File([bytes], "doc.pdf", { type: "application/pdf" });

    const buf = await readFileAsArrayBuffer(file);
    expect(new Uint8Array(buf)).toEqual(bytes);

    const u8 = await readFileAsUint8Array(file);
    expect(u8).toEqual(bytes);
  });
});
