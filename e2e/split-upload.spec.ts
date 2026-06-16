import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const ONE_PAGE = fileURLToPath(new URL("./fixtures/one-page.pdf", import.meta.url));

// Regression test for the production-only react-pdf "fake worker" bug: react-pdf
// reset GlobalWorkerOptions.workerSrc to its bare default in the prod bundle,
// so pdf.js fell back to a broken main-thread worker and every PDF showed
// "Failed to load PDF file." This MUST run against the production build (see
// playwright.config.ts) — it passed in dev even when prod was broken.
test("uploading a PDF loads it (no fake-worker fallback) and shows the page count", async ({ page }) => {
  const sawFakeWorker: string[] = [];
  page.on("console", (m) => {
    if (/fake worker|Failed to resolve module specifier/i.test(m.text())) sawFakeWorker.push(m.text());
  });

  await page.goto("/split");
  await expect(page.getByRole("heading", { name: "Split PDF" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(ONE_PAGE);

  // The page count resolves...
  await expect(page.getByText(/·\s*1 page\b/)).toBeVisible({ timeout: 10000 });
  // ...the document loads (react-pdf's error UI must NOT appear)...
  await expect(page.getByText("Failed to load PDF file.")).toHaveCount(0);
  await expect(page.getByText("Loading PDF…")).toHaveCount(0);
  // ...and pdf.js used a real worker, not the broken fake fallback.
  expect(sawFakeWorker, `pdf.js fell back to a fake worker: ${sawFakeWorker.join(" | ")}`).toHaveLength(0);
});
