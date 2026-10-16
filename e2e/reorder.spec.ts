import { test, expect, type Page, type Locator } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const BLOB_ERRORS = /ERR_FILE_NOT_FOUND|UnexpectedResponseException/;

function watchConsole(page: Page): string[] {
  const bad: string[] = [];
  page.on("console", (m) => { if (BLOB_ERRORS.test(m.text())) bad.push(m.text()); });
  page.on("requestfailed", (r) => { if (r.url().startsWith("blob:")) bad.push(`requestfailed ${r.url()}`); });
  return bad;
}

async function cardTexts(cards: Locator): Promise<string[]> {
  return (await cards.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
}

/** Drag `from` by its body (bottom area, away from any button) onto `to`'s centre. */
async function dragByBody(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("card not visible");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height * 0.35, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2 + 5, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
}

/** Upload once the WASM engine is ready (pages reject uploads until then). */
async function upload(page: Page, files: string[], testId: string, count: number) {
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles(files);
    await expect(page.getByTestId(testId)).toHaveCount(count, { timeout: 3000 });
  }).toPass({ timeout: 20000 });
}

async function waitForThumbs(page: Page, n: number) {
  await expect(page.locator('img[data-thumb="ready"]')).toHaveCount(n, { timeout: 15000 });
}

test.describe("merge", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/merge");
    await upload(page, [fx("alpha.pdf"), fx("bravo.pdf"), fx("charlie.pdf")], "merge-card", 3);
  });

  test("dragging a card by its body reorders, with no blob errors", async ({ page }) => {
    const bad = watchConsole(page);
    await waitForThumbs(page, 3);
    const cards = page.getByTestId("merge-card");
    await dragByBody(page, cards.nth(0), cards.nth(2));
    await expect.poll(async () => (await cardTexts(cards)).map((t) => t.match(/(alpha|bravo|charlie)\.pdf/)?.[1]))
      .toEqual(["bravo", "charlie", "alpha"]);
    expect(bad).toEqual([]);
  });

  test("remove button still works (clicks are not drags)", async ({ page }) => {
    const cards = page.getByTestId("merge-card");
    await cards.nth(1).getByTitle("Remove file").click();
    await expect(cards).toHaveCount(2);
    expect((await cardTexts(cards)).join(" ")).not.toContain("bravo.pdf");
  });

  test("keyboard reorder: Space, ArrowRight, Space", async ({ page }) => {
    const cards = page.getByTestId("merge-card");
    await cards.nth(0).locator("xpath=../..").focus(); // SortableCell (focus + listeners) > slot div > card
    const live = (text: string) => page.locator("[aria-live]").filter({ hasText: text });
    await page.keyboard.press("Space");
    await expect(live("alpha.pdf is over position 1")).toHaveCount(1);
    await page.keyboard.press("ArrowRight");
    await expect(live("is over position 2")).toHaveCount(1);
    await page.keyboard.press("Space");
    await expect.poll(async () => (await cardTexts(cards))[1]).toContain("alpha.pdf");
  });

  test("Space on an inner button does not lift the card", async ({ page }) => {
    const cards = page.getByTestId("merge-card");
    await cards.nth(0).getByTitle("Move right").focus();
    await page.keyboard.press("Space"); // activates the button: alpha moves right once
    await expect.poll(async () => (await cardTexts(cards))[1]).toContain("alpha.pdf");
    await page.keyboard.press("ArrowRight"); // must NOT move anything (no drag active)
    await page.waitForTimeout(300);
    expect((await cardTexts(cards))[1]).toContain("alpha.pdf");
  });

  test("no long task over 200 ms while dragging", async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles([fx("dense.pdf"), fx("four-pages.pdf")]);
    await expect(page.getByTestId("merge-card")).toHaveCount(5);
    await waitForThumbs(page, 5);
    await page.evaluate(() => {
      const w = window as unknown as { __long: number[] };
      w.__long = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push(e.duration)))
        .observe({ type: "longtask", buffered: false });
    });
    const cards = page.getByTestId("merge-card");
    await dragByBody(page, cards.nth(3), cards.nth(0));
    await page.waitForTimeout(500);
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    expect(Math.max(0, ...long)).toBeLessThan(200);
  });
});

test("organize: drag page 1 after page 3, download keeps the new order", async ({ page }) => {
  const bad = watchConsole(page);
  await page.goto("/organize");
  await upload(page, [fx("four-pages.pdf")], "planner-card", 4);
  const cards = page.getByTestId("planner-card");
  await waitForThumbs(page, 4);
  await dragByBody(page, cards.nth(0), cards.nth(2));
  await expect.poll(async () => (await cardTexts(cards)).map((t) => t.match(/Page (\d)/)?.[1]))
    .toEqual(["2", "3", "1", "4"]);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download PDF" }).click(),
  ]);
  const bytes = new Uint8Array(await readFile(await download.path()));
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: bytes }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    texts.push(c.items.map((it) => ("str" in it ? it.str : "")).join("").replace(/\s+/g, " ").trim());
  }
  expect(texts).toEqual(["Page 2", "Page 3", "Page 1", "Page 4"]);
  expect(bad).toEqual([]);
});
