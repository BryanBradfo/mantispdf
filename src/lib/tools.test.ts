import { describe, expect, it } from "vitest";
import { en } from "../i18n/locales/en";
import fr from "../i18n/locales/fr/fr";
import { APP_ROUTES, isRedirect } from "../routes";
import { SECTIONS, TOOLS, sectionNumber, toolById } from "./tools";

describe("the tool table", () => {
  it("lists 27 tools with unique ids and hrefs", () => {
    expect(TOOLS).toHaveLength(27);
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(27);
    expect(new Set(TOOLS.map((t) => t.href)).size).toBe(27);
  });

  it("has five sections, each non-empty, and every tool in one of them", () => {
    expect(SECTIONS).toEqual(["organize", "convert", "edit", "security", "recognize"]);
    for (const s of SECTIONS) expect(TOOLS.filter((t) => t.section === s).length, s).toBeGreaterThan(0);
    expect(TOOLS.every((t) => SECTIONS.includes(t.section))).toBe(true);
  });

  it("is ordered by section (spec 3.6), so a section's tools are contiguous", () => {
    const order = TOOLS.map((t) => SECTIONS.indexOf(t.section));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(TOOLS.filter((t) => t.section === "organize").map((t) => t.id)).toEqual([
      "merge", "split", "organize", "rotate", "removePages", "extractPages", "crop", "resize", "nUp",
    ]);
    expect(TOOLS.filter((t) => t.section === "recognize").map((t) => t.id)).toEqual(["ocr"]);
  });

  it("gives every tool a distinct 16x16 pixel glyph of # and . only, none empty", () => {
    for (const t of TOOLS) {
      expect(t.pixel, t.id).toHaveLength(16);
      for (const row of t.pixel) expect(row, t.id).toMatch(/^[#.]{16}$/);
      expect(t.pixel.join("").includes("#"), t.id).toBe(true);
    }
    expect(new Set(TOOLS.map((t) => t.pixel.join(""))).size).toBe(27);
  });

  it("covers every page route of the app once (home, 404 and redirects aside)", () => {
    const pages = APP_ROUTES.filter((r) => r.path !== "/" && r.path !== "*" && !isRedirect(r)).map((r) => r.path);
    expect([...TOOLS.map((t) => t.href)].sort()).toEqual([...pages].sort());
  });

  it("finds a tool by id and numbers sections from 01", () => {
    expect(toolById("merge").href).toBe("/merge");
    expect(toolById("ocr").section).toBe("recognize");
    expect(sectionNumber("organize")).toBe("01");
    expect(sectionNumber("recognize")).toBe("05");
  });
});

describe("tool and section names", () => {
  for (const [locale, dict] of [["en", en], ["fr", fr]] as const) {
    const home: Record<string, unknown> = dict.home;
    it(`${locale}: every tool has a title and a description`, () => {
      const missing = TOOLS.flatMap((t) => [`${t.id}.title`, `${t.id}.desc`]).filter((k) => typeof home[k] !== "string");
      expect(missing).toEqual([]);
    });
    it(`${locale}: every section has a name`, () => {
      expect(SECTIONS.map((s) => `sections.${s}`).filter((k) => typeof home[k] !== "string")).toEqual([]);
    });
  }
});
