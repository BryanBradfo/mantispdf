import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

async function upload(page: Page, files: string[], count: number) {
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles(files);
    await expect(page.getByTestId("planner-card")).toHaveCount(count, { timeout: 3000 });
  }).toPass({ timeout: 20000 });
}

async function pdfInfo(bytes: Uint8Array): Promise<{ texts: string[]; rotations: number[] }> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: bytes }).promise;
  const texts: string[] = [];
  const rotations: number[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    rotations.push(p.rotate);
    const c = await p.getTextContent();
    texts.push(c.items.map((it) => ("str" in it ? it.str : "")).join("").replace(/\s+/g, " ").trim());
  }
  return { texts, rotations };
}

async function download(page: Page, name: string | RegExp): Promise<Uint8Array> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name }).click()]);
  return new Uint8Array(await readFile(await dl.path()));
}

test("organize: two files, duplicate, blank, rotate", async ({ page }) => {
  await page.goto("/organize");
  await upload(page, [fx("four-pages.pdf"), fx("alpha.pdf")], 5);
  await page.getByRole("button", { name: "Delete four-pages.pdf · 4" }).click();
  // multi-file captions are "<file> · <n>"
  await page.getByRole("button", { name: "Duplicate four-pages.pdf · 1" }).click();
  await page.getByRole("button", { name: "Rotate alpha.pdf · 1 right" }).click();
  await page.getByRole("button", { name: "Insert blank page after four-pages.pdf · 2" }).click();
  await expect(page.getByText("6 pages in the result")).toBeVisible();

  const { texts, rotations } = await pdfInfo(await download(page, "Download PDF"));
  expect(texts).toEqual(["Page 1", "Page 1", "Page 2", "", "Page 3", "alpha"]);
  expect(rotations).toEqual([0, 0, 0, 0, 0, 90]);
});

test("remove: typed ranges", async ({ page }) => {
  await page.goto("/remove-pages");
  await upload(page, [fx("four-pages.pdf")], 4);
  await page.getByLabel("Pages to remove").fill("2-3");
  await expect(page.getByText("2 of 4 pages in the result")).toBeVisible();
  await expect(page.locator('[aria-pressed="true"]')).toHaveCount(2);
  const { texts } = await pdfInfo(await download(page, "Download"));
  expect(texts).toEqual(["Page 1", "Page 4"]);
});

test("remove: invalid range keeps the selection and shows the error", async ({ page }) => {
  await page.goto("/remove-pages");
  await upload(page, [fx("four-pages.pdf")], 4);
  await page.getByLabel("Pages to remove").fill("2");
  await page.getByLabel("Pages to remove").fill("2, 9");
  await expect(page.getByText(/Page 9 does not exist/)).toBeVisible();
  await expect(page.locator('[aria-pressed="true"]')).toHaveCount(1);
});

test("extract: clicks update the range text; ZIP has one file per page", async ({ page }) => {
  await page.goto("/extract-pages");
  await upload(page, [fx("four-pages.pdf")], 4);
  await page.getByRole("button", { name: "Extract Page 2" }).click();
  await page.getByRole("button", { name: "Extract Page 4" }).click();
  await expect(page.getByLabel("Pages to extract")).toHaveValue("2, 4");
  await page.getByLabel("One file per page (ZIP)").check();
  const zip = unzipSync(await download(page, "Download"));
  const names = Object.keys(zip).sort();
  expect(names).toEqual(["four-pages_page_2.pdf", "four-pages_page_4.pdf"]);
  expect((await pdfInfo(zip["four-pages_page_4.pdf"])).texts).toEqual(["Page 4"]);
});

test("/edit redirects to /organize", async ({ page }) => {
  await page.goto("/edit");
  await expect(page).toHaveURL(/\/organize$/);
  await expect(page.getByRole("heading", { name: "Organize PDF" })).toBeVisible();
});
