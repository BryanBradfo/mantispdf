import { test, expect } from "@playwright/test";

/**
 * The web app never loads the desktop updater: its chunk exists in the build (the Tauri shell lazy-loads
 * it) but no script the browser runs carries the updater or process plugin, and no update panel shows.
 */
test("the web build never loads the updater", async ({ page }) => {
  const scripts: { url: string; body: string }[] = [];
  page.on("response", async (res) => {
    if (res.request().resourceType() !== "script") return;
    scripts.push({ url: res.url(), body: await res.text().catch(() => "") });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto("/fr");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");

  expect(scripts.length).toBeGreaterThan(0);
  // The main chunk names the lazy chunks (their import() paths), so chunk names are checked on URLs only.
  const offenders = scripts.filter(
    (s) => /desktopUpdate|DesktopUpdateBanner/.test(s.url) || /plugin:(updater|process)\|/.test(s.body),
  );
  expect(offenders.map((s) => s.url)).toEqual([]);
  await expect(page.getByRole("status", { name: /update|mise à jour/i })).toHaveCount(0);
});
