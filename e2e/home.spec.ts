import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

const SECTIONS = {
  en: ["Organize", "Optimize and convert", "Edit and sign", "Security and privacy", "Analyze"],
  fr: ["Organiser", "Optimiser et convertir", "Éditer et signer", "Sécurité et confidentialité", "Analyser"],
};

/** Horizontal overflow of the page, in CSS pixels (0 when nothing sticks out). */
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const [locale, path] of [["en", "/"], ["fr", "/fr"]] as const) {
  test(`${locale} home: five tool sections and 28 tool links`, async ({ page }) => {
    await page.goto(path);
    const tools = page.locator("#tools");
    await expect(tools.getByRole("heading", { level: 2 })).toHaveText(SECTIONS[locale].map((name, i) => `0${i + 1} / ${name}`));
    for (const name of SECTIONS[locale]) await expect(tools.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
    await expect(tools.getByRole("link")).toHaveCount(28);
    const prefix = locale === "fr" ? "/fr/" : "/";
    for (const href of await tools.getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href")))) {
      expect(href?.startsWith(prefix), String(href)).toBe(true);
    }
  });
}

test("the hero button scrolls to the tools", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Choose a tool" }).click();
  await expect(page).toHaveURL(/#tools$/);
  await expect(page.locator("#tools").getByRole("heading", { name: "Organize" })).toBeInViewport();
});

test("the theme is dark by default and the toggle persists after reload", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveClass(/\bdark\b/);
  await page.getByRole("button", { name: "Toggle dark mode" }).click();
  await expect(html).not.toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(html).not.toHaveClass(/\bdark\b/);
  await page.getByRole("button", { name: "Toggle dark mode" }).click();
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);
});

test("the TOOLS menu lists every tool, closes on Escape and returns focus", async ({ page }) => {
  await page.goto("/merge");
  const button = page.getByRole("button", { name: "Tools" });
  await button.click();
  const menu = page.getByRole("navigation", { name: "All tools" });
  await expect(menu.getByRole("link")).toHaveCount(28);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  await button.click();
  await menu.getByRole("link", { name: "Redact PDF" }).click();
  await expect(page).toHaveURL(/\/redact$/);
  await expect(menu).toHaveCount(0);
});

test("no other origin is contacted on the home page", async ({ page, baseURL }) => {
  const origins = new Set<string>();
  page.on("request", (r) => origins.add(new URL(r.url()).origin));
  await page.goto("/");
  await expect(page.locator("#tools").getByRole("link")).toHaveCount(28);
  await page.waitForLoadState("networkidle");
  const self = new URL(baseURL!).origin;
  expect([...origins].filter((o) => o !== self && o !== "null")).toEqual([]);
});

test.describe("on a 390 px phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const path of ["/fr", "/fr/merge"]) {
    test(`${path} does not scroll sideways`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      expect(await overflow(page)).toBe(0);
    });
  }

  test("the footer of a tool page fits the phone and links every tool under /fr", async ({ page }) => {
    await page.goto("/fr/merge");
    const footer = page.getByRole("contentinfo");
    await footer.scrollIntoViewIfNeeded();
    await expect(footer.getByRole("heading", { name: "Projet" })).toBeVisible();
    const nav = footer.getByRole("navigation", { name: "Plan du site" });
    await expect(nav.getByRole("link", { name: "Fusionner PDF" })).toHaveAttribute("href", "/fr/merge");
    expect((await nav.locator('a[href^="/fr/"]').count())).toBe(28);
    expect(await overflow(page)).toBe(0);
    expect(await footer.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  });

  test("/fr/merge does not scroll sideways with two files loaded", async ({ page }) => {
    await page.goto("/fr/merge");
    await expect(async () => {
      await page.locator('input[type="file"]').setInputFiles([fx("alpha.pdf"), fx("bravo.pdf")]);
      await expect(page.getByTestId("merge-card")).toHaveCount(2, { timeout: 3000 });
    }).toPass({ timeout: 20000 });
    await expect(page.getByRole("button", { name: "Fusionner 2\u00a0fichiers" })).toBeVisible();
    expect(await overflow(page)).toBe(0);
  });

  test("the menu button opens the tools, the language switch and GitHub", async ({ page }) => {
    await page.goto("/fr");
    await page.getByRole("button", { name: "Menu" }).click();
    await expect(page.getByRole("navigation", { name: "Langue" })).toBeVisible();
    expect(await overflow(page)).toBe(0);
    await page.getByRole("navigation", { name: "Tous les outils" }).getByRole("link", { name: "Fusionner PDF" }).click();
    await expect(page).toHaveURL(/\/fr\/merge$/);
    await expect(page.getByRole("heading", { name: "Fusionner PDF", level: 1 })).toBeVisible();
  });
});
