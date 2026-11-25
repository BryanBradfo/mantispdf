import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

// The one place the service worker runs (playwright.config.ts blocks it everywhere else).
test.use({ serviceWorkers: "allow" });

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

/** Upload once the WASM engine is ready (pages reject uploads until then). */
async function upload(page: Page, files: string[], testId: string, count: number) {
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles(files);
    await expect(page.getByTestId(testId)).toHaveCount(count, { timeout: 3000 });
  }).toPass({ timeout: 20000 });
}

/** Waits until a service worker is active, its precache filled, then reloads so that it controls the page. */
async function controlledBySw(page: Page) {
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.active) throw new Error("no active service worker");
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toMatch(/\/sw\.js$/);
}

test("every page links a valid, installable manifest", async ({ page, request }) => {
  for (const path of ["/", "/fr/merge", "/no-such-page"]) {
    await page.goto(path);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  }
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest).toMatchObject({
    name: "MantisPDF",
    short_name: "MantisPDF",
    start_url: "/",
    scope: "/",
    id: "/",
    display: "standalone",
    theme_color: "#000000",
    background_color: "#000000",
  });
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  for (const icon of [...manifest.icons, ...manifest.shortcuts.flatMap((s: { icons: unknown[] }) => s.icons)]) {
    const img = await request.get(icon.src);
    expect(img.ok(), icon.src).toBe(true);
    expect(img.headers()["content-type"]).toBe("image/png");
  }
  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBe(true);
  expect(await sw.text()).toContain("addEventListener(\"message\"");
});

test("the service worker takes over, then Merge loads and merges offline", async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await controlledBySw(page);

  await context.setOffline(true);
  // Never visited before: the precached shell renders the route, with the precached code and WASM.
  await page.goto("/merge");
  await expect(page.getByRole("heading", { level: 1, name: "Merge PDF" })).toBeVisible();
  await upload(page, [fx("alpha.pdf"), fx("bravo.pdf")], "merge-card", 2);
  await expect(page.locator('img[data-thumb="ready"]')).toHaveCount(2, { timeout: 15000 });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Merge 2 files" }).click();
  expect((await download).suggestedFilename()).toBe("merged.pdf");

  // A French page offline, through the same shell.
  await page.goto("/fr/compress");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Compresser/);
  await context.setOffline(false);
});

test("the pdf.js worker is requested under its versioned URL and served by the service worker", async ({ page }) => {
  const workerUrls: string[] = [];
  page.context().on("request", (r) => {
    if (r.url().includes("pdf.worker.min.mjs")) workerUrls.push(new URL(r.url()).pathname + new URL(r.url()).search);
  });
  await page.goto("/");
  await controlledBySw(page);
  await page.goto("/merge");
  await upload(page, [fx("alpha.pdf"), fx("bravo.pdf")], "merge-card", 2);
  await expect(page.locator('img[data-thumb="ready"]')).toHaveCount(2, { timeout: 15000 });
  expect(workerUrls.length).toBeGreaterThan(0);
  for (const u of workerUrls) expect(u).toMatch(/^\/pdf\.worker\.min\.mjs\?v=\d+\.\d+\.\d+$/);
});

test("Unicode text: the Noto font used online is cached and still works offline", async ({ page, context }) => {
  test.setTimeout(120_000);
  const fill = async () => {
    const input = page.locator('input[type="file"][data-engine-ready="true"]');
    await input.waitFor({ state: "attached", timeout: 20000 });
    await input.setInputFiles(fx("form.pdf"));
    const canvas = page.getByTestId("form-canvas");
    await canvas.getByLabel("Full name").fill("Иван Петров");
    // The required fields, so the download does not stop to ask.
    await canvas.getByLabel("I agree").check();
    await canvas.getByLabel("Colour: green").check();
    await expect(page.getByText("Uses Noto Sans for these characters").first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/No font can show these characters/)).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  };
  await page.goto("/");
  await controlledBySw(page);
  await page.goto("/fill-form");
  await fill();
  const cached = await page.evaluate(async () => {
    const name = (await caches.keys()).find((n) => n.startsWith("mantis-fonts-runtime-"));
    if (!name) return [];
    return (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
  });
  expect(cached).toEqual(expect.arrayContaining(["/fonts-runtime/fonts.json"]));
  expect(cached.some((p) => /^\/fonts-runtime\/NotoSans_/.test(p))).toBe(true);

  await context.setOffline(true);
  await page.goto("/fill-form");
  await fill();
  await context.setOffline(false);
});

test("no request leaves the origin, service worker included", async ({ page, baseURL }) => {
  const origins = new Set<string>();
  page.context().on("request", (r) => origins.add(new URL(r.url()).origin));
  await page.goto("/");
  await controlledBySw(page);
  await page.goto("/merge");
  await page.waitForLoadState("networkidle");
  const self = new URL(baseURL!).origin;
  expect([...origins].filter((o) => o !== self && o !== "null")).toEqual([]);
});
