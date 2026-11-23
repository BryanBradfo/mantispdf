import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SW_FILE = fileURLToPath(new URL("../dist/sw.js", import.meta.url));

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/** Fires Chromium's install prompt as the browser would, with a double that records the dialog. */
async function offerInstall(page: Page, outcome: "accepted" | "dismissed") {
  await page.evaluate((o) => {
    const e = new Event("beforeinstallprompt", { cancelable: true });
    const w = window as unknown as { promptShown: number };
    w.promptShown = 0;
    Object.assign(e, {
      prompt: () => {
        w.promptShown++;
        return Promise.resolve();
      },
      userChoice: Promise.resolve({ outcome: o }),
    });
    window.dispatchEvent(e);
  }, outcome);
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("/download: the web app card comes first, and Install app opens the browser's dialog", async ({ page }) => {
  await page.goto("/download");
  const card = page.getByTestId("install-card");
  await expect(card.getByRole("heading", { name: "Install in your browser" })).toBeVisible();
  // Above the desktop installers.
  const cardBox = (await card.boundingBox())!;
  const tabsBox = (await page.getByRole("tablist").boundingBox())!;
  expect(cardBox.y + cardBox.height).toBeLessThan(tabsBox.y);
  await expect(card).toContainText("address bar or menu");

  await offerInstall(page, "accepted");
  await card.getByRole("button", { name: "Install app" }).click();
  expect(await page.evaluate(() => (window as unknown as { promptShown: number }).promptShown)).toBe(1);
  await expect(card).toContainText("Installed. Open MantisPDF from your apps.");
});

test("the footer offers Install app while the prompt is ready", async ({ page }) => {
  await page.goto("/fr");
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("button", { name: "Installer l’app" })).toHaveCount(0);
  await offerInstall(page, "dismissed");
  await footer.getByRole("button", { name: "Installer l’app" }).click();
  await expect(footer.getByRole("button", { name: "Installer l’app" })).toHaveCount(0);
});

test.describe("iPhone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    hasTouch: true,
  });

  test("/download at 390 px: Share, then Add to Home Screen, and no overflow", async ({ page }) => {
    await page.goto("/download");
    await expect(page.getByTestId("install-card")).toContainText("tap Share, then Add to Home Screen");
    expect(await overflow(page)).toBe(0);
    await page.goto("/fr/download");
    await expect(page.getByTestId("install-card")).toContainText("Sur l’écran d’accueil");
    expect(await overflow(page)).toBe(0);
  });
});

test.describe("installed app", () => {
  test.use({ userAgent: CHROME_UA });
  test("no install card when already running standalone", async ({ page }) => {
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q: string) =>
        q === "(display-mode: standalone)" ? ({ ...real(q), matches: true } as MediaQueryList) : real(q);
    });
    await page.goto("/download");
    await expect(page.getByRole("tablist")).toBeVisible();
    await expect(page.getByTestId("install-card")).toHaveCount(0);
  });
});

test.describe("new version", () => {
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
