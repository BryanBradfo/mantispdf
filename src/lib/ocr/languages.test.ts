import { describe, expect, it } from "vitest";
import { OCR_LANGUAGES, defaultLanguages, languageLabel } from "./languages";

describe("OCR languages", () => {
  it("offers the seven Latin-script languages with their tesseract codes", () => {
    expect(OCR_LANGUAGES.map((l) => l.code)).toEqual(["eng", "fra", "deu", "spa", "ita", "por", "nld"]);
    expect(OCR_LANGUAGES.find((l) => l.code === "fra")?.label).toBe("French");
  });

  it("defaults to English plus the first offered browser language", () => {
    expect(defaultLanguages(["fr-FR", "de"])).toEqual(["eng", "fra"]);
    expect(defaultLanguages(["pt-BR"])).toEqual(["eng", "por"]);
    expect(defaultLanguages(["NL"])).toEqual(["eng", "nld"]);
    expect(defaultLanguages(["ja", "es-419"])).toEqual(["eng", "spa"]);
  });

  it("is English alone for English or unoffered browser languages", () => {
    expect(defaultLanguages(["en-US", "fr"])).toEqual(["eng"]);
    expect(defaultLanguages(["ja", "zh-CN"])).toEqual(["eng"]);
    expect(defaultLanguages([])).toEqual(["eng"]);
  });
});

describe("languageLabel", () => {
  it("names each language in the UI language, capitalised", () => {
    expect(OCR_LANGUAGES.map((l) => languageLabel(l.code, "en"))).toEqual(OCR_LANGUAGES.map((l) => l.label));
    expect(languageLabel("fra", "fr")).toBe("Français");
    expect(languageLabel("eng", "fr")).toBe("Anglais");
    expect(languageLabel("nld", "fr")).toBe("Néerlandais");
  });
});
