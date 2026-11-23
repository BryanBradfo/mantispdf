import { describe, it, expect } from "vitest";
import { en } from "../i18n/locales/en";
import fr from "../i18n/locales/fr/fr";
import { TOOLS } from "../lib/tools";
import { downloadJsonLd, homeJsonLd, jsonLdScript, pageJsonLd, toolJsonLd } from "./structuredData";

type Node = Record<string, unknown>;
const types = (doc: { "@graph": Node[] }) => doc["@graph"].map((n) => n["@type"]);
const node = (doc: { "@graph": Node[] }, type: string) => doc["@graph"].find((n) => n["@type"] === type)!;

describe("home JSON-LD", () => {
  const doc = homeJsonLd(en, "en");

  it("has WebSite, Organization, SoftwareApplication and FAQPage", () => {
    expect(doc["@context"]).toBe("https://schema.org");
    expect(types(doc)).toEqual(["WebSite", "Organization", "SoftwareApplication", "FAQPage"]);
  });

  it("describes the app: every tool as a feature, free, on every platform", () => {
    const app = node(doc, "SoftwareApplication");
    expect(app.featureList).toHaveLength(TOOLS.length);
    expect(app.offers).toEqual({ "@type": "Offer", price: "0", priceCurrency: "USD" });
    expect(app.operatingSystem).toBe("Web, Windows, macOS, Linux");
    expect(app.downloadUrl).toBe("https://mantispdf.bradfo.me/download");
    expect(node(doc, "Organization")).toMatchObject({ name: "MantisPDF", url: "https://mantispdf.bradfo.me/" });
  });

  it("answers the five home questions", () => {
    expect((node(doc, "FAQPage").mainEntity as Node[]).length).toBe(5);
  });
});

describe("tool JSON-LD", () => {
  it.each(TOOLS.map((t) => t.id))("%s has WebApplication, HowTo, FAQPage and BreadcrumbList", (id) => {
    const doc = toolJsonLd(en, "en", id);
    expect(types(doc)).toEqual(["WebApplication", "HowTo", "FAQPage", "BreadcrumbList"]);
    const steps = node(doc, "HowTo").step as Node[];
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0]).toMatchObject({ "@type": "HowToStep", position: 1 });
    expect((node(doc, "FAQPage").mainEntity as Node[]).length).toBe(3);
    expect((node(doc, "BreadcrumbList").itemListElement as Node[]).map((i) => i.position)).toEqual([1, 2, 3]);
    expect(node(doc, "WebApplication")).toMatchObject({ isAccessibleForFree: true });
  });

  it("uses the French URL and text under /fr", () => {
    const doc = toolJsonLd(fr, "fr", "merge");
    expect(node(doc, "WebApplication")).toMatchObject({ url: "https://mantispdf.bradfo.me/fr/merge", name: "Fusionner PDF" });
    expect(node(doc, "HowTo").name).toBe("Comment fusionner des PDF");
    const crumbs = node(doc, "BreadcrumbList").itemListElement as Node[];
    expect(crumbs[0]).toMatchObject({ name: "Accueil", item: "https://mantispdf.bradfo.me/fr" });
  });
});

describe("download JSON-LD", () => {
  it("lists every installer", () => {
    const app = node(downloadJsonLd(en, "en"), "SoftwareApplication");
    expect(app.downloadUrl).toHaveLength(7);
    expect((app.downloadUrl as string[]).every((u) => u.startsWith("https://github.com/BryanBradfo/mantispdf/releases/download/v"))).toBe(true);
  });
});

describe("every page's JSON-LD", () => {
  const all = ["/", ...TOOLS.map((t) => t.href), "/download"].flatMap((path) => [
    pageJsonLd(en, "en", path),
    pageJsonLd(fr, "fr", path),
  ]);

  it("never says open source, names the license, or uses a middle dot or em-dash", () => {
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/open[ -]?source|\bMIT\b|·|—/i);
  });

  it("leaves no {placeholder} unfilled", () => {
    expect(JSON.stringify(all)).not.toMatch(/\{(count|version)\}/);
  });

  it("escapes < so the script element cannot be closed early", () => {
    const doc = { "@context": "https://schema.org" as const, "@graph": [{ name: "</script><b>" }] };
    expect(jsonLdScript(doc)).not.toContain("</script>");
    expect(JSON.parse(jsonLdScript(doc))["@graph"][0].name).toBe("</script><b>");
  });
});
