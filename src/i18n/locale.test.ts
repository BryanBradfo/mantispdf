import { describe, it, expect } from "vitest";
import { localeFromPath, localePath, localizeRoutes, stripLocale } from "./locale";

describe("localeFromPath", () => {
  it.each([
    ["/", "en"],
    ["/merge", "en"],
    ["/fr", "fr"],
    ["/fr/", "fr"],
    ["/fr/merge", "fr"],
    ["/fr?x=1", "fr"],
    ["/french", "en"],
    ["/frmerge", "en"],
    ["/merge/fr", "en"],
  ] as const)("%s -> %s", (path, locale) => {
    expect(localeFromPath(path)).toBe(locale);
  });
});

describe("stripLocale", () => {
  it.each([
    ["/fr", "/"],
    ["/fr/", "/"],
    ["/fr/merge", "/merge"],
    ["/fr?x=1", "/?x=1"],
    ["/fr#top", "/#top"],
    ["/merge", "/merge"],
    ["/french", "/french"],
  ])("%s -> %s", (path, bare) => {
    expect(stripLocale(path)).toBe(bare);
  });
});

describe("localePath", () => {
  it("keeps English at the root", () => {
    expect(localePath("/merge", "en")).toBe("/merge");
    expect(localePath("/", "en")).toBe("/");
  });

  it("prefixes French paths with /fr", () => {
    expect(localePath("/merge", "fr")).toBe("/fr/merge");
    expect(localePath("/", "fr")).toBe("/fr");
    expect(localePath("/merge?x=1#a", "fr")).toBe("/fr/merge?x=1#a");
    expect(localePath("/?x=1", "fr")).toBe("/fr?x=1");
  });

  it("switches an already prefixed path (no double prefix)", () => {
    expect(localePath("/fr/merge", "fr")).toBe("/fr/merge");
    expect(localePath("/fr/merge", "en")).toBe("/merge");
  });

  it("leaves relative paths alone", () => {
    expect(localePath("merge", "fr")).toBe("merge");
  });
});

describe("localizeRoutes", () => {
  it("mirrors every route under each non-default locale", () => {
    const routes = [
      { path: "/", id: "home" },
      { path: "/merge", id: "merge" },
      { path: "*", id: "404" },
    ];
    expect(localizeRoutes(routes)).toEqual([
      { path: "/", id: "home" },
      { path: "/merge", id: "merge" },
      { path: "*", id: "404" },
      { path: "/fr", id: "home" },
      { path: "/fr/merge", id: "merge" },
      { path: "/fr/*", id: "404" },
    ]);
  });
});

describe("protocol-relative inputs (open redirect guard)", () => {
  it.each([
    ["//evil.com", "en", "/evil.com"],
    ["//evil.com", "fr", "/fr/evil.com"],
    ["/\\evil.com", "en", "/evil.com"],
    ["/\\evil.com", "fr", "/fr/evil.com"],
    ["/fr//evil.com", "en", "/evil.com"],
    ["/fr//evil.com", "fr", "/fr/evil.com"],
    ["/fr/\\evil.com", "en", "/evil.com"],
    ["\\\\evil.com", "en", "/evil.com"],
    ["\\\\evil.com", "fr", "/fr/evil.com"],
    ["///evil.com/x?y#z", "fr", "/fr/evil.com/x?y#z"],
  ] as const)("localePath(%j, %s) -> %s", (path, locale, expected) => {
    expect(localePath(path, locale)).toBe(expected);
  });

  it.each([
    ["//evil.com", "/evil.com"],
    ["/\\evil.com", "/evil.com"],
    ["/fr//evil.com", "/evil.com"],
    ["/fr/\\evil.com", "/evil.com"],
    ["\\\\evil.com", "/evil.com"],
  ])("stripLocale(%j) -> %s", (path, expected) => {
    expect(stripLocale(path)).toBe(expected);
  });

  it.each([
    ["/\t/evil.com", "fr", "/fr/evil.com"],
    [" //evil.com", "en", "/evil.com"],
    ["\u0000//evil.com", "fr", "/fr/evil.com"],
    ["/fr/\n/evil.com", "en", "/evil.com"],
  ] as const)("strips controls: localePath(%j, %s) -> %s", (path, locale, expected) => {
    expect(localePath(path, locale)).toBe(expected);
  });

  it("never returns a protocol-relative value", () => {
    const nasty = [
      "//a", "/\\a", "\\/a", "\\\\a", "/fr//a", "/fr/\\a", "/fr\\\\a", "//fr//a", "/fr/", "/fr",
      // Browsers drop tabs and newlines anywhere and leading C0 controls and spaces.
      "/\t/a", "/\n/a", "/\r\n/a", "\t//a", " //a", "\u0000//a", "\u001f/\\a", "/fr/\t/a", "/f\tr//a",
    ];
    for (const p of nasty) {
      for (const out of [stripLocale(p), localePath(p, "en"), localePath(p, "fr")]) {
        const asBrowserReads = out.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
        expect(asBrowserReads, `${JSON.stringify(p)} -> ${JSON.stringify(out)}`).not.toMatch(/^[/\\]{2}/);
      }
    }
  });
});
