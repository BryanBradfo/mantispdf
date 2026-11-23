import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * A new deploy, simulated by changing the bytes of dist/sw.js that `vite preview` serves (Playwright's routing
 * cannot reach a service worker's own script). It runs in its own project ("pwa-update" in playwright.config.ts),
 * after every other spec, so no other test meets the edited file.
 */
const SW_FILE = fileURLToPath(new URL("../dist/sw.js", import.meta.url));

test.describe("new version", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ serviceWorkers: "allow" });

  test("a waiting service worker shows Reload and Later; Reload switches to it", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/merge");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await expect(page.getByTestId("pwa-update")).toHaveCount(0);

    // A new deploy: the same worker with different bytes, in the dist/ that `vite preview` serves (restored
    // after; the extra comment changes nothing for the other specs). Routing cannot reach the worker's script.
    const original = await readFile(SW_FILE, "utf8");
    await writeFile(SW_FILE, `${original}\n// next deploy ${Date.now()}\n`);
    try {
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
    } finally {
      await writeFile(SW_FILE, original);
    }
    const panel = page.getByTestId("pwa-update");
    await expect(panel).toContainText("A new version of MantisPDF is ready");
    await panel.getByRole("button", { name: "Later" }).click();
    await expect(panel).toHaveCount(0);

    await page.reload();
    await expect(panel).toBeVisible();
    const before = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    await Promise.all([page.waitForEvent("load"), panel.getByRole("button", { name: "Reload" }).click()]);
    await expect(panel).toHaveCount(0);
    expect(before).toMatch(/\/sw\.js$/);
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting ?? null)).toBeNull();
  });
});
