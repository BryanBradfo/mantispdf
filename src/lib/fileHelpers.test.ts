import { describe, it, expect } from "vitest";
import { isPdfFile, readFileAsArrayBuffer, readFileAsUint8Array } from "./fileHelpers";

describe("isPdfFile", () => {
  it("accepts a PDF file", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "doc.pdf", { type: "application/pdf" });
    expect(isPdfFile(file)).toBe(true);
  });

  it("rejects a non-PDF file (the page shows common.invalidPdf)", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    expect(isPdfFile(file)).toBe(false);
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

  it("rejects (does not hang) when the read errors", async () => {
    // A FileReader whose read fails should reject the promise rather than leave
    // it pending forever.
    const file = new File([new Uint8Array([1])], "doc.pdf", { type: "application/pdf" });
    const originalReadAsArrayBuffer = FileReader.prototype.readAsArrayBuffer;
    FileReader.prototype.readAsArrayBuffer = function (this: FileReader) {
      // Simulate an async error.
      const ev = new ProgressEvent("error") as unknown as ProgressEvent<FileReader>;
      setTimeout(() => this.onerror?.(ev), 0);
    };
    try {
      await expect(readFileAsArrayBuffer(file)).rejects.toThrow(/Failed to read file/);
    } finally {
      FileReader.prototype.readAsArrayBuffer = originalReadAsArrayBuffer;
    }
  });
});
});
