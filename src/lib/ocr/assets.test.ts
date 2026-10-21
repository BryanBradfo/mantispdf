// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain Node script without type declarations.
import { OCR_FILES, OCR_LICENSE_FILES, RUNTIME_DIR, missingInDist, ocrLicenseSources, ocrSources, removeStaleRuntime } from "../../../scripts/copy-ocr-assets.mjs";
import { OCR_BASE, ocrAssetFiles } from "./assets";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("self-hosted OCR assets", () => {
  it("are served from /ocr-runtime/, apart from the /ocr page route", () => {
    expect(OCR_BASE).toBe("/ocr-runtime");
    expect(`/${RUNTIME_DIR as string}`).toBe(OCR_BASE);
  });

  it("the copy script copies exactly the files the engine requests", () => {
    expect([...(OCR_FILES as string[])].sort()).toEqual(ocrAssetFiles().sort());
  });

  it("every source exists in the installed packages", () => {
    for (const [dest, src] of Object.entries(ocrSources(ROOT) as Record<string, string>)) {
      expect(existsSync(src), dest).toBe(true);
      expect(statSync(src).size, dest).toBeGreaterThan(0);
    }
  });

  it("licences and the notice are copied next to the runtime", () => {
    expect([...(OCR_LICENSE_FILES as string[])].sort()).toEqual(["NOTICE.md", "core/LICENSE", "tesseract.js.LICENSE.md", "worker.min.js.LICENSE.txt"]);
    for (const [dest, src] of Object.entries(ocrLicenseSources(ROOT) as Record<string, string>)) {
      expect(existsSync(src), dest).toBe(true);
      expect(statSync(src).size, dest).toBeGreaterThan(0);
    }
  });

  it("the postbuild check requires the runtime, its licences and the pdf.js licence", () => {
    const dist = mkdtempSync(join(tmpdir(), "ocr-dist-"));
    try {
      const all = ["pdf.worker.min.mjs.LICENSE", ...[...OCR_FILES, ...OCR_LICENSE_FILES].map((f: string) => `ocr-runtime/${f}`)];
      expect([...(missingInDist(dist) as string[])].sort()).toEqual([...all].sort());
      for (const f of all) {
        mkdirSync(dirname(join(dist, f)), { recursive: true });
        writeFileSync(join(dist, f), "x");
      }
      expect(missingInDist(dist)).toEqual([]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("the copy removes a stale runtime left at public/ocr/ by older builds", () => {
    const root = mkdtempSync(join(tmpdir(), "ocr-root-"));
    try {
      mkdirSync(join(root, "public/ocr/lang"), { recursive: true });
      writeFileSync(join(root, "public/ocr/lang/eng.traineddata.gz"), "x");
      mkdirSync(join(root, "public/ocr-runtime"), { recursive: true });
      writeFileSync(join(root, "public/ocr-runtime/worker.min.js"), "x");
      expect(removeStaleRuntime(root)).toBe(true);
      expect(existsSync(join(root, "public/ocr"))).toBe(false);
      expect(existsSync(join(root, "public/ocr-runtime/worker.min.js"))).toBe(true);
      // Nothing to remove the second time.
      expect(removeStaleRuntime(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("git ignores both the runtime and the old /ocr/ copy", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n");
    expect(ignore).toContain("public/ocr-runtime/");
    expect(ignore).toContain("public/ocr/");
  });
});
