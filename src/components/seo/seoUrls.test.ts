import { describe, it, expect } from "vitest";
import { seoUrls } from "./seoUrls";

describe("seoUrls", () => {
  it("gives each locale its own canonical URL", () => {
    expect(seoUrls("/merge", "en").canonical).toBe("https://mantispdf.bradfo.me/merge");
    expect(seoUrls("/merge", "fr").canonical).toBe("https://mantispdf.bradfo.me/fr/merge");
    expect(seoUrls("/", "fr").canonical).toBe("https://mantispdf.bradfo.me/fr");
  });

  it("lists en, fr and x-default alternates, whatever the current locale", () => {
    const expected = [
      { hrefLang: "en", href: "https://mantispdf.bradfo.me/merge" },
      { hrefLang: "fr", href: "https://mantispdf.bradfo.me/fr/merge" },
      { hrefLang: "x-default", href: "https://mantispdf.bradfo.me/merge" },
    ];
    expect(seoUrls("/merge", "en").alternates).toEqual(expected);
    expect(seoUrls("/merge", "fr").alternates).toEqual(expected);
  });

  it("gives the Open Graph locale", () => {
    expect(seoUrls("/", "en").ogLocale).toBe("en_US");
    expect(seoUrls("/", "fr").ogLocale).toBe("fr_FR");
  });
});
