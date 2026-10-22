import { describe, it, expect, beforeEach } from "vitest";
import { readStoredLocale, resolveLocale, shouldOfferFrench, storeLocale } from "./localeChoice";

beforeEach(() => localStorage.clear());

describe("stored locale choice", () => {
  it("is null until the visitor picks a language", () => {
    expect(readStoredLocale()).toBeNull();
  });

  it("round-trips a choice", () => {
    storeLocale("fr");
    expect(readStoredLocale()).toBe("fr");
    storeLocale("en");
    expect(readStoredLocale()).toBe("en");
  });

  it("ignores a stored value that is not a locale", () => {
    localStorage.setItem("locale", "de");
    expect(readStoredLocale()).toBeNull();
  });
});

describe("shouldOfferFrench", () => {
  const base = { locale: "en", stored: null, languages: ["fr-FR", "en"] } as const;

  it("offers French to a French browser on an English page with no stored choice", () => {
    expect(shouldOfferFrench(base)).toBe(true);
    expect(shouldOfferFrench({ ...base, languages: ["fr"] })).toBe(true);
  });

  it("does not offer it once a choice is stored, on a French page, or to other browsers", () => {
    expect(shouldOfferFrench({ ...base, stored: "en" })).toBe(false);
    expect(shouldOfferFrench({ ...base, locale: "fr" })).toBe(false);
    expect(shouldOfferFrench({ ...base, languages: ["en-US", "fr"] })).toBe(false);
    expect(shouldOfferFrench({ ...base, languages: [] })).toBe(false);
  });
});

describe("resolveLocale", () => {
  it("takes the locale from the /fr prefix first", () => {
    expect(resolveLocale("/fr/merge", null)).toBe("fr");
    expect(resolveLocale("/fr/merge", "en")).toBe("fr");
  });

  it("uses the stored choice for an unprefixed path (desktop app)", () => {
    expect(resolveLocale("/merge", "fr")).toBe("fr");
    expect(resolveLocale("/", "fr")).toBe("fr");
  });

  it("defaults to English", () => {
    expect(resolveLocale("/merge", null)).toBe("en");
    expect(resolveLocale("/merge", "en")).toBe("en");
  });
});
