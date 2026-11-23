import { describe, it, expect } from "vitest";
import { dropPrerenderedHead } from "./prerenderedHead";

function page(): Document {
  const doc = document.implementation.createHTMLDocument("");
  doc.head.innerHTML = `
    <title data-prerender>Static title</title>
    <meta data-prerender name="description" content="x" />
    <link data-prerender rel="canonical" href="https://example.com/" />
    <script data-prerender type="application/ld+json">{}</script>
    <meta name="viewport" content="width=device-width" />`;
  return doc;
}

describe("dropPrerenderedHead", () => {
  it("removes the static tags but keeps the title until the app sets its own", async () => {
    const doc = page();
    dropPrerenderedHead(doc);
    expect(doc.head.querySelectorAll("[data-prerender]:not(title)")).toHaveLength(0);
    expect(doc.title).toBe("Static title");
    expect(doc.querySelector('meta[name="viewport"]')).not.toBeNull();

    const own = doc.createElement("title");
    own.textContent = "App title";
    doc.head.append(own);
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.head.querySelectorAll("title")).toHaveLength(1);
    expect(doc.title).toBe("App title");
  });

  it("leaves a page without prerendered tags alone", () => {
    const doc = document.implementation.createHTMLDocument("Shell");
    dropPrerenderedHead(doc);
    expect(doc.title).toBe("Shell");
  });
});
