import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

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

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

/** Upload once the WASM engine is ready (pages reject uploads until then). */
async function upload(page: Page, files: string[], testId: string, count: number) {
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles(files);
    await expect(page.getByTestId(testId)).toHaveCount(count, { timeout: 3000 });
  }).toPass({ timeout: 20000 });
}

test("French Merge: full flow in French", async ({ page }) => {
  await page.goto("/fr/merge");
  await expect(page.getByRole("heading", { name: "Fusionner PDF" })).toBeVisible();
  await expect(page).toHaveTitle("Fusionner des PDF | MantisPDF");
  await expect(page.getByText("Glissez vos PDF ici ou parcourez vos fichiers")).toBeVisible();
  await upload(page, [fx("alpha.pdf"), fx("bravo.pdf")], "merge-card", 2);
  await expect(page.getByText("2 fichiers · 2 pages au total")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Fusionner 2 fichiers" }).click();
  expect((await download).suggestedFilename()).toBe("merged.pdf");
  await expect(page.getByRole("link", { name: "← Tous les outils" })).toHaveAttribute("href", "/fr");
});

test("French Remove pages: range errors and the result count are in French", async ({ page }) => {
  await page.goto("/fr/remove-pages");
  await upload(page, [fx("four-pages.pdf")], "planner-card", 4);
  const range = page.getByLabel("Pages à supprimer");
  await range.fill("2-3");
  await expect(page.getByText("résultat : 2 sur 4 pages")).toBeVisible();
  await range.fill("2, 9");
  await expect(page.getByText("La page 9 n’existe pas (le document compte 4 pages)")).toBeVisible();
});

test("French Page numbers: positions, formats and the printed text are French", async ({ page }) => {
  await page.goto("/fr/page-numbers");
  await expect(page.getByRole("heading", { name: "Numéros de page" })).toBeVisible();
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles(fx("four-pages.pdf"));
    await expect(page.getByText("four-pages.pdf (4 pages)")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20000 });
  await page.getByRole("radio", { name: "En bas à droite" }).click();
  await page.getByLabel("Format").selectOption({ label: "Page 1 sur 12" });
  const summary = page.getByTestId("settings-summary");
  await expect(summary).toContainText("En bas à droite");
  await expect(summary).toContainText("Les 4 pages");
  await expect(summary).toContainText('"Page 1 sur 4"');
});

test("French Encrypt: a non-PDF file is refused in French", async ({ page }) => {
  await page.goto("/fr/encrypt");
  await page.locator('input[type="file"]').setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(page.getByText("Veuillez choisir un fichier PDF.")).toBeVisible();
});
