import { test, expect, type Page } from "@playwright/test";

const BASE = "https://github.com/BryanBradfo/mantispdf/releases/download/v2.1.0";

/** Pretend to be a visitor on `platform` (User-Agent Client Hints, as the page reads them first). */
async function asPlatform(page: Page, platform: string) {
  await page.addInitScript((p) => {
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => ({ platform: p }), configurable: true });
  }, platform);
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const hrefs = (page: Page) =>
  page.getByRole("tabpanel").locator("a[download]").evaluateAll((as) => as.map((a) => a.getAttribute("href")));

test("EN /download: the visitor's OS is selected and the links are the 2.1.0 installers", async ({ page }) => {
  await asPlatform(page, "Windows");
  await page.goto("/download");
  await expect(page).toHaveTitle("Download MantisPDF for macOS, Windows and Linux | MantisPDF by Bradfo");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("MantisPDF for your desktop");
  await expect(page.getByRole("tab", { name: "Windows" })).toHaveAttribute("aria-selected", "true");
  expect(await hrefs(page)).toEqual([`${BASE}/MantisPDF_2.1.0_x64-setup.exe`, `${BASE}/MantisPDF_2.1.0_x64_en-US.msi`]);

  await page.getByRole("tab", { name: "Windows" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "macOS" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "macOS" })).toBeFocused();
  expect(await hrefs(page)).toEqual([`${BASE}/MantisPDF_2.1.0_aarch64.dmg`, `${BASE}/MantisPDF_2.1.0_x64.dmg`]);
  await expect(page.getByRole("link", { name: /All releases/ })).toHaveAttribute(
    "href",
    "https://github.com/BryanBradfo/mantispdf/releases",
  );
});

test("FR /fr/download: Linux selected from an X11 user agent, copy button copies the one-liner", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined, configurable: true });
    Object.defineProperty(Navigator.prototype, "userAgent", {
      get: () => "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      configurable: true,
    });
  });
  await page.goto("/fr/download");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("MantisPDF sur votre ordinateur");
  await expect(page.getByRole("tab", { name: "Linux" })).toHaveAttribute("aria-selected", "true");
  expect(await hrefs(page)).toEqual([
    `${BASE}/MantisPDF_2.1.0_amd64.AppImage`,
    `${BASE}/MantisPDF_2.1.0_amd64.deb`,
    `${BASE}/MantisPDF-2.1.0-1.x86_64.rpm`,
  ]);
  const command = `curl -LO ${BASE}/MantisPDF_2.1.0_amd64.AppImage && chmod +x MantisPDF_2.1.0_amd64.AppImage && ./MantisPDF_2.1.0_amd64.AppImage --appimage-extract-and-run`;
  await expect(page.locator("code")).toHaveText(command);
  await page.getByRole("button", { name: "Copier la commande" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copié" })).toHaveCount(1);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
});

test("the header DOWNLOAD box and the home hero lead to /download", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("link", { name: "Download the app" }).click();
  await expect(page).toHaveURL(/\/download$/);
  await page.goto("/fr/merge");
  await page.getByRole("banner").getByRole("link", { name: "Télécharger", exact: true }).click();
  await expect(page).toHaveURL(/\/fr\/download$/);
});

test("no other origin is contacted on the download page", async ({ page, baseURL }) => {
  const origins = new Set<string>();
  page.on("request", (r) => origins.add(new URL(r.url()).origin));
  await page.goto("/download");
  await expect(page.getByRole("tab")).toHaveCount(3);
  for (const os of ["macOS", "Windows", "Linux"]) await page.getByRole("tab", { name: os }).click();
  await page.waitForLoadState("networkidle");
  const self = new URL(baseURL!).origin;
  expect([...origins].filter((o) => o !== self && o !== "null")).toEqual([]);
});

test.describe("on a 390 px phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const path of ["/download", "/fr/download"]) {
    test(`${path} does not scroll sideways on any tab`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      for (const tab of await page.getByRole("tab").all()) {
        await tab.click();
        expect(await overflow(page), await tab.textContent()).toBe(0);
      }
    });
  }

  test("the DOWNLOAD button moves into the menu", async ({ page }) => {
    await page.goto("/fr");
    const banner = page.getByRole("banner");
    await expect(banner.getByRole("link", { name: "Télécharger", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Menu" }).click();
    await banner.getByRole("link", { name: "Télécharger", exact: true }).click();
    await expect(page).toHaveURL(/\/fr\/download$/);
    expect(await overflow(page)).toBe(0);
  });
});
