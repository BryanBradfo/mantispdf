import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PixelIcon, { glyphPath } from "./PixelIcon";
import { PIXEL_ICONS } from "../../lib/pixelIcons";

const row = (s: string) => s.padEnd(16, ".");
const glyph = [row("##.#"), row(".###"), ...Array.from({ length: 14 }, () => row(""))];

describe("glyphPath", () => {
  it("merges horizontal runs into one rect each, row by row", () => {
    expect(glyphPath(glyph)).toBe("M0 0h2v1h-2zM3 0h1v1h-1zM1 1h3v1h-3z");
  });

  it("covers exactly the inked pixels of every tool glyph", () => {
    for (const [id, g] of Object.entries(PIXEL_ICONS)) {
      const inked = g.join("").split("").filter((c) => c === "#").length;
      const area = [...glyphPath(g).matchAll(/h(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
      expect(area, id).toBe(inked);
    }
  });
});

describe("PixelIcon", () => {
  it("renders one crisp currentColor path, hidden from assistive tech by default", () => {
    const html = renderToStaticMarkup(<PixelIcon icon={glyph} className="h-6 w-6" />);
    expect(html).toContain('viewBox="0 0 16 16"');
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="h-6 w-6"');
    expect(html.match(/<path/g)).toHaveLength(1);
  });

  it("is an image with a name when given a title", () => {
    const html = renderToStaticMarkup(<PixelIcon icon={glyph} title="Merge" />);
    expect(html).toContain('role="img"');
    expect(html).toContain("<title>Merge</title>");
    expect(html).not.toContain("aria-hidden");
  });
});
