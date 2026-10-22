import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

test("French home: French copy, html lang, cards link under /fr, hreflang alternates", async ({ page }) => {
  await page.goto("/fr");
  await expect(page.getByRole("heading", { name: "Outils PDF" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page).toHaveTitle("MantisPDF\u00a0: outils PDF gratuits dans votre navigateur");
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
  await expect(page.getByText("2\u00a0fichiers · 2\u00a0pages au total")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Fusionner 2\u00a0fichiers" }).click();
  expect((await download).suggestedFilename()).toBe("merged.pdf");
  await expect(page.getByRole("link", { name: "← Tous les outils" })).toHaveAttribute("href", "/fr");
});

test("French Remove pages: range errors and the result count are in French", async ({ page }) => {
  await page.goto("/fr/remove-pages");
  await upload(page, [fx("four-pages.pdf")], "planner-card", 4);
  const range = page.getByLabel("Pages à supprimer");
  await range.fill("2-3");
  await expect(page.getByText("résultat\u00a0: 2 sur 4\u00a0pages")).toBeVisible();
  await range.fill("2, 9");
  await expect(page.getByText("La page 9 n’existe pas (le document compte 4\u00a0pages)")).toBeVisible();
});

test("French Page numbers: positions, formats and the printed text are French", async ({ page }) => {
  await page.goto("/fr/page-numbers");
  await expect(page.getByRole("heading", { name: "Numéros de page" })).toBeVisible();
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles(fx("four-pages.pdf"));
    await expect(page.getByText("four-pages.pdf (4\u00a0pages)")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20000 });
  await page.getByRole("radio", { name: "En bas à droite" }).click();
  await page.getByLabel("Format").selectOption({ label: "Page 1 sur 12" });
  const summary = page.getByTestId("settings-summary");
  await expect(summary).toContainText("En bas à droite");
  await expect(summary).toContainText("Les 4\u00a0pages");
  await expect(summary).toContainText('"Page 1 sur 4"');

  // The text printed in the PDF itself is French too.
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Numéroter et télécharger" }).click(),
  ]);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(await readFile(await dl.path())) }).promise;
  expect(doc.numPages).toBe(4);
  for (let i = 1; i <= doc.numPages; i++) {
    // The fixture prints its own "Page N"; the stamp is its own text item.
    const items = (await (await doc.getPage(i)).getTextContent()).items.map((it) => ("str" in it ? it.str : ""));
    expect(items).toContain(`Page ${i} sur 4`);
  }
});

test("French Encrypt: a non-PDF file is refused in French", async ({ page }) => {
  await page.goto("/fr/encrypt");
  await page.locator('input[type="file"]').setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(page.getByText("Veuillez choisir un fichier PDF.")).toBeVisible();
});

test("French Watermark: a narrow no-break space typed before ! is accepted", async ({ page }) => {
  await page.goto("/fr/watermark");
  await page.locator('input[type="file"]').setInputFiles(fx("four-pages.pdf"));
  await page.getByPlaceholder("CONFIDENTIEL").fill("Confidentiel\u202f!");
  await page.getByRole("button", { name: "Ajouter le filigrane" }).click();
  await expect(page.getByText("Filigrane ajouté.")).toBeVisible({ timeout: 20000 });
});

test("French Redact: search, review and marks read in French", async ({ page }) => {
  await page.goto("/fr/redact");
  await expect(page.getByRole("heading", { name: "Caviarder" })).toBeVisible();
  const input = page.locator('input[type="file"][data-engine-ready="true"]');
  await input.waitFor({ state: "attached", timeout: 20000 });
  await input.setInputFiles(fx("redact.pdf"));
  await expect(page.getByTestId("redact-canvas")).toBeVisible({ timeout: 20000 });
  await page.getByRole("searchbox", { name: "Texte à chercher" }).fill("SMITH");
  await page.getByRole("button", { name: "Chercher", exact: true }).click();
  await expect(page.getByText("1\u00a0résultat pour «\u00a0SMITH\u00a0» sur la page 1.")).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Tout marquer" }).click();
  await expect(page.getByRole("region", { name: "Marques" }).getByText("Résultat\u00a0: «\u00a0SMITH\u00a0»")).toBeVisible();
});

test("French Edit PDF: the toolbar and the empty panel are French", async ({ page }) => {
  await page.goto("/fr/edit-pdf");
  const input = page.locator('input[type="file"][data-engine-ready="true"]');
  await input.waitFor({ state: "attached", timeout: 20000 });
  await input.setInputFiles(fx("four-pages.pdf"));
  const toolbar = page.getByRole("toolbar", { name: "Outils de modification" });
  await expect(toolbar.getByRole("button", { name: "Texte (T)" })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("Choisissez un outil, puis cliquez ou glissez sur la page.", { exact: false })).toBeVisible();
});

test("French 404 page, linking back to the French home", async ({ page }) => {
  await page.goto("/fr/no-such-page");
  await expect(page.getByRole("heading", { name: "Page introuvable" })).toBeVisible();
  await expect(page.getByRole("link", { name: "← Retour à tous les outils" })).toHaveAttribute("href", "/fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
});

test("French engine errors: a wrong password reads in French", async ({ page }, testInfo) => {
  // Encrypt a file in French first, then unlock it with the wrong password.
  await page.goto("/fr/encrypt");
  await page.locator('input[type="file"]').setInputFiles(fx("four-pages.pdf"));
  await page.getByPlaceholder("Saisissez le mot de passe").fill("u");
  await page.getByPlaceholder("Saisissez-le à nouveau").fill("u");
  await page.getByRole("button", { name: "Chiffrer le PDF" }).click();
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Télécharger le PDF chiffré" }).click(),
  ]);
  const encrypted = testInfo.outputPath("encrypted.pdf");
  await dl.saveAs(encrypted);

  await page.goto("/fr/unlock");
  const submit = page.getByRole("button", { name: "Déverrouiller et télécharger" });
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles(encrypted);
    await expect(submit).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20000 });
  await page.getByLabel("Mot de passe (laissez vide si le PDF s’ouvre sans)").fill("x");
  await submit.click();
  await expect(page.getByText("Mot de passe incorrect")).toBeVisible();
});

test("French head: one title and one description, both French (no static English left)", async ({ page }) => {
  await page.goto("/fr/merge");
  await expect(page).toHaveTitle("Fusionner des PDF | MantisPDF");
  await expect(page.locator("head title")).toHaveCount(1);
  const description = page.locator('head meta[name="description"]');
  await expect(description).toHaveCount(1);
  await expect(description).toHaveAttribute("content", /^Combinez plusieurs PDF/);
  for (const selector of ['meta[property="og:title"]', 'meta[property="og:description"]', 'meta[name="twitter:title"]', 'meta[name="twitter:description"]', 'meta[property="og:url"]']) {
    await expect(page.locator(`head ${selector}`), selector).toHaveCount(1);
  }
  await expect(page.locator('head meta[property="og:title"]')).toHaveAttribute("content", "Fusionner des PDF | MantisPDF");
  await expect(page.locator('head meta[property="og:url"]')).toHaveAttribute("content", "https://mantispdf.vercel.app/fr/merge");
});

