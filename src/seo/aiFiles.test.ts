import { describe, it, expect } from "vitest";
import { en } from "../i18n/locales/en";
import { TOOLS } from "../lib/tools";
import { llmsFullTxt, llmsTxt } from "./aiFiles";
import { toolGuide } from "./guide";

const SITE = "https://mantispdf.bradfo.me";

describe("llms.txt", () => {
  const txt = llmsTxt(en);

  it("follows llmstxt.org: an H1, a blockquote summary, H2 sections", () => {
    const lines = txt.split("\n");
    expect(lines[0]).toBe("# MantisPDF");
    expect(lines[2]).toMatch(/^> \S/);
    expect(txt).toMatch(/^## Tools$/m);
    expect(txt).toMatch(/^## Desktop app$/m);
    expect(txt).toMatch(/^## Privacy$/m);
  });

  it.each(TOOLS.map((t) => [t.id, t.href]))("lists %s with its absolute URL", (id, href) => {
    expect(txt).toContain(`](${SITE}${href}): `);
    expect(txt).toContain(`[${en.home[`${id}.title` as keyof typeof en.home]}]`);
  });

  it("links the download page and the full guide", () => {
    expect(txt).toContain(`${SITE}/download`);
    expect(txt).toContain(`${SITE}/llms-full.txt`);
  });

  it("never says open source, names the license, or uses a middle dot", () => {
    expect(txt + llmsFullTxt(en)).not.toMatch(/open[ -]?source|\bMIT\b|·|—/i);
  });
});

describe("llms-full.txt", () => {
  const txt = llmsFullTxt(en);

  it.each(TOOLS.map((t) => t.id))("has the what, steps and FAQ of %s", (id) => {
    const g = toolGuide(en, id);
    expect(txt).toContain(g.what);
    expect(txt).toContain(`#### ${g.howTo}`);
    for (const s of g.steps) expect(txt).toContain(s);
    for (const { q } of g.faq) expect(txt).toContain(q);
  });
});
