// @vitest-environment node
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain Node script without type declarations.
import { OCR_FILES, ocrSources } from "../../../scripts/copy-ocr-assets.mjs";
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
});
