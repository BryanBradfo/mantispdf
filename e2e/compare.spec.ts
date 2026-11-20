import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

/**
 * Fixtures from scripts/make-compare-fixtures.py: compare-a.pdf (2 pages) and compare-b.pdf
 * (quick -> swift, an added sentence replacing a line, a moved paragraph, a third page), and
 * compare-scan.pdf (one image, no text).
 */
const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

test.use({ viewport: { width: 1440, height: 1000 } });

/** Requests that leave the app origin, from every page and worker. */
function watchForeign(page: Page, origin: string): string[] {
  const foreign: string[] = [];
  page.context().on("request", (r) => {
    const u = r.url();
    if (u.startsWith("blob:") || u.startsWith("data:")) return;
    if (new URL(u).origin !== origin) foreign.push(u);
  });
  return foreign;
}

async function load(page: Page, a: string, b: string, path = "/compare") {
  await page.goto(path);
  await page.locator('[data-testid="compare-slot-a"] input[type="file"][data-engine-ready="true"]').waitFor({ state: "attached", timeout: 20000 });
  await page.getByTestId("compare-slot-a").locator('input[type="file"]').setInputFiles(fx(a));
  await page.getByTestId("compare-slot-b").locator('input[type="file"]').setInputFiles(fx(b));
}

const changes = (page: Page) => page.getByTestId("compare-changes").getByRole("button");

test("lists the text changes and highlights them on both columns", async ({ page, baseURL }) => {
  const foreign = watchForeign(page, new URL(baseURL!).origin);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await load(page, "compare-a.pdf", "compare-b.pdf");

  await expect(page.getByTestId("compare-headline")).toHaveText(/\d+ changes/, { timeout: 20000 });
  await expect(page.getByTestId("compare-status")).toContainText("changes:");
  await expect(page.getByRole("button", { name: "Page 1: removed “quick”, added “swift”" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Page 1: removed “line will be removed”, added “sentence was added”" })).toBeVisible();
  // The third page exists only in the modified copy: its words are added there.
  await expect(changes(page).filter({ hasText: "modified copy." })).not.toHaveCount(0);
  // Read like a person would: the moved paragraph removed on page 1 and added on page 2, no word confetti.
  await expect(page.getByRole("button", { name: "Page 1: removed “Paragraph two moves to the bottom later.”" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Page 2: added “Paragraph two moves to the bottom later.”" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Page 3: added “Third page exists only in the modified copy.”" })).toBeVisible();
  await expect(changes(page)).toHaveCount(5);
  await expect(page.getByTestId("compare-headline")).toHaveText("5 changes");

  const colA = page.getByTestId("compare-column-a");
  const colB = page.getByTestId("compare-column-b");
  await expect(colA.locator("[data-page]")).toHaveCount(2);
  await expect(colB.locator("[data-page]")).toHaveCount(3);
  await expect(colA.locator('[data-page="1"] [data-mark="removed"]')).not.toHaveCount(0);
  await expect(colB.locator('[data-page="1"] [data-mark="added"]')).not.toHaveCount(0);
  await expect(colB.locator('[data-page="3"] [data-mark="added"]')).not.toHaveCount(0);
  // Highlights only where they belong: no added marks on the original, no removed marks on the modified copy.
  await expect(colA.locator('[data-mark="added"]')).toHaveCount(0);
  await expect(colB.locator('[data-mark="removed"]')).toHaveCount(0);
  // The pages render (through the thumbnail store).
  await expect(colA.locator('[data-page="1"] img[data-thumb="ready"]')).toBeVisible({ timeout: 20000 });

  // The "quick" mark sits over the first text lines of page 1, left of centre.
  const pageBox = (await colA.locator('[data-page="1"]').boundingBox())!;
  const quick = (await colA.locator('[data-page="1"] [data-mark="removed"][data-change="0"]').first().boundingBox())!;
  expect(quick.y - pageBox.y).toBeLessThan(pageBox.height * 0.2);
  expect(quick.x - pageBox.x).toBeLessThan(pageBox.width * 0.5);

  expect(errors).toEqual([]);
  expect(foreign).toEqual([]);
});

test("clicking a change scrolls both columns to it and marks it", async ({ page }) => {
  await load(page, "compare-a.pdf", "compare-b.pdf");
  await expect(changes(page).first()).toBeVisible({ timeout: 20000 });
  const colA = page.getByTestId("compare-column-a");
  const colB = page.getByTestId("compare-column-b");
  expect(await colB.evaluate((el) => el.scrollTop)).toBe(0);

  const last = changes(page).last();
  await last.click();
  await expect(last).toHaveAttribute("aria-current", "true");
  const index = (await changes(page).count()) - 1;
  await expect.poll(() => colB.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await expect.poll(() => colA.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  const active = colB.locator(`[data-change="${index}"][data-active="true"]`).first();
  await expect(active).toBeAttached();
  const inView = await active.evaluate((m) => {
    const col = m.closest('[data-testid="compare-column-b"]')!.getBoundingClientRect();
    const r = m.getBoundingClientRect();
    return r.top >= col.top && r.bottom <= col.bottom;
  });
  expect(inView).toBe(true);
});

test("scrolling one column scrolls the other by matched text", async ({ page }) => {
  await load(page, "compare-a.pdf", "compare-b.pdf");
  await expect(changes(page).first()).toBeVisible({ timeout: 20000 });
  const colA = page.getByTestId("compare-column-a");
  const colB = page.getByTestId("compare-column-b");
  await colA.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect.poll(() => colB.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await colA.evaluate((el) => (el.scrollTop = 0));
  await expect.poll(() => colB.evaluate((el) => el.scrollTop)).toBeLessThan(100);
});

test("swap exchanges original and modified", async ({ page }) => {
  await load(page, "compare-a.pdf", "compare-b.pdf");
  await expect(page.getByRole("button", { name: "Page 1: removed “quick”, added “swift”" })).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Swap original and modified" }).click();
  await expect(page.getByTestId("compare-slot-a")).toContainText("compare-b.pdf");
  await expect(page.getByTestId("compare-slot-b")).toContainText("compare-a.pdf");
  await expect(page.getByRole("button", { name: "Page 1: removed “swift”, added “quick”" })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: "Page 1: removed “quick”, added “swift”" })).toHaveCount(0);
  await expect(page.getByTestId("compare-column-a").locator("[data-page]")).toHaveCount(3);
});

test("marks sit on their words on pages turned by /Rotate 0, 90, 180 and 270", async ({ page }) => {
  // rotated.pdf: 4 pages with /Rotate 0/90/180/270, each with one word (R0..R270). Against
  // compare-a.pdf every word of it is removed, so each page has one mark over its word.
  await load(page, "rotated.pdf", "compare-a.pdf");
  const col = page.getByTestId("compare-column-a");
  await expect(col.locator("[data-page]")).toHaveCount(4, { timeout: 20000 });
  for (let n = 1; n <= 4; n++) {
    const pg = col.locator(`[data-page="${n}"]`);
    await pg.scrollIntoViewIfNeeded();
    await expect(pg.locator('img[data-thumb="ready"]')).toBeVisible({ timeout: 20000 });
    await expect(pg.locator('[data-mark="removed"]')).toHaveCount(1);
    // Dark render pixels under the mark (the word), none in the same box moved to the far corner.
    const ink = await pg.evaluate(async (el) => {
      const img = el.querySelector("img") as HTMLImageElement;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const page = el.getBoundingClientRect();
      const m = (el.querySelector('[data-mark="removed"]') as HTMLElement).getBoundingClientRect();
      const sx = c.width / page.width;
      const sy = c.height / page.height;
      const dark = (left: number, top: number) => {
        const w = Math.max(1, Math.round(m.width * sx));
        const h = Math.max(1, Math.round(m.height * sy));
        const data = ctx.getImageData(Math.round(left * sx), Math.round(top * sy), w, h).data;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 300) n++;
        return n;
      };
      const left = m.left - page.left;
      const top = m.top - page.top;
      const far = { left: left < page.width / 2 ? page.width - m.width - 2 : 2, top: top < page.height / 2 ? page.height - m.height - 2 : 2 };
      return { under: dark(left, top), away: dark(far.left, far.top) };
    });
    expect(ink.under, `page ${n}`).toBeGreaterThan(20);
    expect(ink.away, `page ${n}`).toBe(0);
  }
});

test("identical files show No text differences", async ({ page }) => {
  await load(page, "compare-a.pdf", "compare-a.pdf");
  await expect(page.getByTestId("compare-headline")).toHaveText("No text differences", { timeout: 20000 });
  await expect(page.getByTestId("compare-status")).toHaveText("No text differences");
  await expect(page.getByTestId("compare-changes")).toHaveCount(0);
  await expect(page.locator("[data-mark]")).toHaveCount(0);
});

test("a scan without text gets a notice with a link to OCR", async ({ page }) => {
  await load(page, "compare-a.pdf", "compare-scan.pdf");
  const notice = page.getByTestId("compare-no-text");
  await expect(notice).toContainText("The modified file has no text layer", { timeout: 20000 });
  await expect(notice.getByRole("link", { name: "OCR PDF" })).toHaveAttribute("href", "/ocr");
  // Removing a file clears the comparison; a new one can be picked.
  await page.getByRole("button", { name: "Remove the modified file" }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByText("Add the modified PDF to compare.")).toBeVisible();
});

test("the French page lists the changes in French", async ({ page }) => {
  await load(page, "compare-a.pdf", "compare-b.pdf", "/fr/compare");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Comparer des PDF");
  await expect(page.getByTestId("compare-headline")).toHaveText(/\d+ modifications/, { timeout: 20000 });
  await expect(page.getByRole("button", { name: "Page 1 : supprimé « quick », ajouté « swift »" })).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("390 px: no horizontal overflow, list below the columns", async ({ page }) => {
    await load(page, "compare-a.pdf", "compare-b.pdf");
    await expect(changes(page).first()).toBeVisible({ timeout: 20000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const cols = (await page.getByTestId("compare-column-a").boundingBox())!;
    const list = (await page.getByTestId("compare-changes").boundingBox())!;
    expect(list.y).toBeGreaterThan(cols.y + cols.height);
    // Picking a change from the list brings the columns back into view.
    await changes(page).last().click();
    await expect.poll(async () => (await page.getByTestId("compare-column-b").boundingBox())!.y).toBeLessThan(844);
  });
});
