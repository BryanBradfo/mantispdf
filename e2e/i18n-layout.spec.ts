import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

/** Every French page, from the sitemap (src/sitemap.test.ts keeps it equal to the app's routes). */
const FR_ROUTES = [...readFileSync(fileURLToPath(new URL("../public/sitemap.xml", import.meta.url)), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => new URL(m[1]).pathname)
  .filter((path) => path === "/fr" || path.startsWith("/fr/"));

/** Horizontal overflow of the page, in CSS pixels (0 when nothing sticks out). */
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("French pages on a 375 px phone", () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test("no page scrolls sideways", async ({ page }) => {
    expect(FR_ROUTES.length).toBe(28);
    const wide: string[] = [];
    for (const path of FR_ROUTES) {
      await page.goto(path);
      await expect(page.locator("h1").first()).toBeVisible();
      const px = await overflow(page);
      if (px > 0) wide.push(`${path}: ${px}px`);
    }
    expect(wide).toEqual([]);
  });

  test("PDF to Images settings fit once a file is chosen", async ({ page }) => {
    await page.goto("/fr/pdf-to-image");
    await page.locator('input[type="file"]').setInputFiles(fx("four-pages.pdf"));
    await expect(page.getByRole("button", { name: "Convertir en images" })).toBeVisible();
    expect(await overflow(page)).toBe(0);
  });
});
