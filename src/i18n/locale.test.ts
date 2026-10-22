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
