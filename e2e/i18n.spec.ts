import { test, expect } from "@playwright/test";

test("French home: French copy, html lang, cards link under /fr, hreflang alternates", async ({ page }) => {
  await page.goto("/fr");
  await expect(page.getByRole("heading", { name: "Outils PDF" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page).toHaveTitle("MantisPDF : outils PDF gratuits dans votre navigateur");
  await expect(page.getByRole("link", { name: /Fusionner PDF/ })).toHaveAttribute("href", "/fr/merge");
  await expect(page.locator('main a[href^="/"]:not([href^="/fr"])')).toHaveCount(0);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://mantispdf.vercel.app/fr");
  await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute("href", "https://mantispdf.vercel.app/");
  await expect(page.locator('link[rel="alternate"][hreflang="fr"]')).toHaveAttribute("href", "https://mantispdf.vercel.app/fr");
  await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1);
});

test("English home keeps lang=en and its own canonical", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://mantispdf.vercel.app/");
});

test("switcher round trip keeps the tool page", async ({ page }) => {
  await page.goto("/merge");
  const switcher = page.getByRole("navigation", { name: "Language" });
  await switcher.getByRole("link", { name: "Français" }).click();
  await expect(page).toHaveURL(/\/fr\/merge$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await page.getByRole("navigation", { name: "Langue" }).getByRole("link", { name: "English" }).click();
  await expect(page).toHaveURL(/\/merge$/);
  await expect(page).not.toHaveURL(/\/fr\//);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test.describe("French browser", () => {
  test.use({ locale: "fr-FR" });

  test("is offered the French version once, without a redirect", async ({ page }) => {
    await page.goto("/split");
    const banner = page.getByRole("region", { name: "Version française disponible." });
    await expect(banner).toBeVisible();
    await expect(page).toHaveURL(/\/split$/);
    await expect(banner.getByRole("link", { name: "Afficher en français" })).toHaveAttribute("href", "/fr/split");
    await banner.getByRole("button", { name: "Non merci" }).click();
    await expect(banner).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Split PDF" })).toBeVisible();
    await expect(banner).toHaveCount(0);
  });

  test("following the banner opens the same page in French", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Afficher en français" }).click();
    await expect(page).toHaveURL(/\/fr$/);
    await expect(page.getByRole("heading", { name: "Outils PDF" })).toBeVisible();
  });
});
