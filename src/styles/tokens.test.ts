import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOKENS } from "./tokens";
import { contrastRatio } from "./contrast";

const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");

/** Reads `--name: r g b;` declarations from the first block opened by `selector`. */
function cssVars(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(\d+ \d+ \d+);/g)].map((m) => [m[1], m[2]]));
}
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

describe("design tokens", () => {
  for (const theme of ["dark", "light"] as const) {
    const t = TOKENS[theme];
    it(`${theme}: ink and ink-2 reach 4.5:1 on paper and surface, paper on ink too`, () => {
      expect(contrastRatio(t.ink, t.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.ink, t.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t["ink-2"], t.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t["ink-2"], t.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.paper, t.ink)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: line-strong reaches 3:1 on paper`, () => {
      expect(contrastRatio(t["line-strong"], t.paper)).toBeGreaterThanOrEqual(3);
    });
    it(`${theme}: index.css variables match TOKENS`, () => {
      const vars = cssVars(theme === "dark" ? ".dark" : ":root");
      for (const [name, hex] of Object.entries(t)) expect(vars[name], name).toBe(channels(hex));
    });
  }
});
