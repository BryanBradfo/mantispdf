// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain Node script without type declarations.
import { OCR_FILES, OCR_LICENSE_FILES, missingInDist, ocrLicenseSources, ocrSources } from "../../../scripts/copy-ocr-assets.mjs";
import { ocrAssetFiles } from "./assets";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("self-hosted OCR assets", () => {
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
      const all = ["pdf.worker.min.mjs.LICENSE", ...[...OCR_FILES, ...OCR_LICENSE_FILES].map((f: string) => `ocr/${f}`)];
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
});
