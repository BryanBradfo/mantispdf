import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const ONE_PAGE = fileURLToPath(new URL("./fixtures/one-page.pdf", import.meta.url));

test("uploading a 1-page PDF resolves the page count (not stuck on Loading)", async ({ page }) => {
  await page.goto("/split");
  await expect(page.getByRole("heading", { name: "Split PDF" })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles(ONE_PAGE);

  // Must escape the "Loading PDF…" state and report the page count within a few seconds.
  await expect(page.getByText(/—\s*1 page\b/)).toBeVisible({ timeout: 8000 });
  await expect(page.getByText("Loading PDF…")).toHaveCount(0);
});
