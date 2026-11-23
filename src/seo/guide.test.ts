import { describe, it, expect } from "vitest";
import { en } from "../i18n/locales/en";
import fr from "../i18n/locales/fr/fr";
import { TOOLS } from "../lib/tools";
import { homeFaq, relatedTools, toolGuide, toolPage } from "./guide";

const dicts = [
  ["en", en],
  ["fr", fr],
] as const;

describe("tool guides", () => {
  it.each(dicts.flatMap(([locale, dict]) => TOOLS.map((t) => [locale, t.id, dict] as const)))(
    "%s %s has a title, a what line, 3 or 4 steps and 3 FAQ entries",
    (_locale, id, dict) => {
      const g = toolGuide(dict, id);
      expect(g.howTo.length).toBeGreaterThan(5);
      expect(g.what.length).toBeGreaterThan(20);
      expect(g.steps.length).toBeGreaterThanOrEqual(3);
      expect(g.steps.length).toBeLessThanOrEqual(4);
      expect(g.faq).toHaveLength(3);
      for (const { q, a } of g.faq) {
        expect(q.length).toBeGreaterThan(5);
        expect(a.length).toBeGreaterThan(5);
      }
    },
  );

  it("gives French the same number of steps as English for every tool", () => {
    for (const { id } of TOOLS) expect(toolGuide(fr, id).steps.length, id).toBe(toolGuide(en, id).steps.length);
  });

  it("never says open source, names the license, or uses a middle dot", () => {
    const all = JSON.stringify([en.howto, fr.howto]);
    expect(all).not.toMatch(/open[ -]?source|\bMIT\b|·/i);
  });

  it("reads every tool page's own strings", () => {
    for (const { id } of TOOLS) {
      const p = toolPage(en, id);
      expect(p.title, id).toContain("MantisPDF");
      expect(p.heading.length, id).toBeGreaterThan(2);
    }
  });
});

describe("home FAQ", () => {
  it.each(dicts)("%s has 5 questions, with the tool count filled in", (_locale, dict) => {
    const faq = homeFaq(dict);
    expect(faq).toHaveLength(5);
    expect(faq[0].a).toContain(String(TOOLS.length));
    expect(JSON.stringify(faq)).not.toContain("{count}");
  });
});

describe("related tools", () => {
  it("lists the other tools of the same section", () => {
    expect(relatedTools("encrypt")).toEqual(["unlock", "redact", "sanitize", "removeMetadata", "editMetadata"]);
    expect(relatedTools("compare")).toEqual(["ocr"]);
  });
});
