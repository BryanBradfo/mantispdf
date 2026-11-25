import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pdfWorkerPath } from "./pdfWorkerUrl";

describe("pdf.js worker URL", () => {
  it("is versioned by the pdf.js API version", () => {
    expect(pdfWorkerPath("4.8.69")).toBe("/pdf.worker.min.mjs?v=4.8.69");
    expect(pdfWorkerPath("5.0.0")).not.toBe(pdfWorkerPath("4.8.69"));
  });

  it("src/lib/pdf.ts pins it fully qualified, from pdfjs.version", () => {
    const src = readFileSync(resolve(__dirname, "pdf.ts"), "utf8");
    expect(src).toContain("new URL(pdfWorkerPath(pdfjs.version), window.location.origin).href");
    expect(src).toMatch(/Object\.defineProperty\(pdfjs\.GlobalWorkerOptions, "workerSrc"/);
  });

  it("the worker copied from pdfjs-dist is the version react-pdf runs", () => {
    const version = JSON.parse(readFileSync(resolve(__dirname, "../../node_modules/pdfjs-dist/package.json"), "utf8")).version;
    const reactPdfDeps = resolve(__dirname, "../../node_modules/react-pdf/node_modules/pdfjs-dist/package.json");
    // react-pdf must use the hoisted pdfjs-dist, the one scripts/copy-pdf-worker.mjs copies.
    expect(() => readFileSync(reactPdfDeps)).toThrow();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
