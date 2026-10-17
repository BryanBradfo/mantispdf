import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
const loadPdfjs = (): Promise<Pdfjs> => import("pdfjs-dist/legacy/build/pdf.mjs");

async function uploadOne(page: Page, file: string, ready: () => Promise<void>) {
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles(file);
    await ready();
  }).toPass({ timeout: 20000 });
}

async function download(page: Page, name: string | RegExp): Promise<Uint8Array> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name }).click()]);
  return new Uint8Array(await readFile(await dl.path()));
}

interface Item { str: string; x: number; y: number }
interface PageText { width: number; height: number; items: Item[] }

async function pageTexts(bytes: Uint8Array): Promise<PageText[]> {
  const { getDocument, Util } = await loadPdfjs();
  const doc = await getDocument({ data: bytes }).promise;
  const out: PageText[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const viewport = p.getViewport({ scale: 1 });
    const c = await p.getTextContent();
    const items: Item[] = [];
    for (const it of c.items) {
      if (!("str" in it) || it.str.trim() === "") continue;
      const m = Util.transform(viewport.transform, it.transform);
      items.push({ str: it.str, x: m[4], y: m[5] });
    }
    out.push({ width: viewport.width, height: viewport.height, items });
  }
  return out;
}

test("page numbers land bottom-right on every rotation", async ({ page }) => {
  await page.goto("/page-numbers");
  await uploadOne(page, fx("rotated.pdf"), () =>
    expect(page.getByText("rotated.pdf (4 pages)")).toBeVisible({ timeout: 3000 }));
  await page.getByRole("radio", { name: "Bottom right" }).click();
  const bytes = await download(page, "Add numbers and download");
  const pages = await pageTexts(bytes);
  expect(pages).toHaveLength(4);
  const rots = [0, 90, 180, 270];
  pages.forEach((p, i) => {
    expect(p.items.some((it) => it.str === `R${rots[i]}`)).toBe(true);
    const num = p.items.find((it) => it.str === String(i + 1));
    expect(num, `page ${i + 1} number`).toBeDefined();
    expect(num!.x).toBeGreaterThan(0.8 * p.width);
    expect(num!.y).toBeGreaterThan(0.9 * p.height);
  });
});

test("header and footer render {filename} and {n}", async ({ page }) => {
  await page.goto("/header-footer");
  await uploadOne(page, fx("four-pages.pdf"), () =>
    expect(page.getByText("four-pages.pdf (4 pages)")).toBeVisible({ timeout: 3000 }));
  await page.getByLabel("Header left").fill("{filename}");
  await page.getByLabel("Footer center").fill("Page {n} of {total}");
  const pages = await pageTexts(await download(page, "Add and download"));
  expect(pages).toHaveLength(4);
  pages.forEach((p, i) => {
    const strs = p.items.map((it) => it.str);
    expect(strs).toContain("four-pages");
    expect(strs).toContain(`Page ${i + 1} of 4`);
    const header = p.items.find((it) => it.str === "four-pages")!;
    const footer = p.items.find((it) => it.str === `Page ${i + 1} of 4`)!;
    expect(header.y).toBeLessThan(0.2 * p.height);
    expect(footer.y).toBeGreaterThan(0.8 * p.height);
  });
});

test("bates: two files give a ZIP that continues the count", async ({ page }) => {
  await page.goto("/bates");
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles([fx("four-pages.pdf"), fx("alpha.pdf")]);
    await expect(page.getByText("2 files.")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20000 });
  await page.getByLabel("Prefix").fill("ACME-");
  await page.getByLabel("Digits").fill("4");
  const zip = unzipSync(await download(page, "Add Bates numbers and download ZIP"));
  expect(Object.keys(zip).sort()).toEqual(["alpha_bates.pdf", "four-pages_bates.pdf"]);
  const first = await pageTexts(zip["four-pages_bates.pdf"]);
  const second = await pageTexts(zip["alpha_bates.pdf"]);
  const stamp = (p: PageText) => p.items.map((it) => it.str).filter((s) => s.startsWith("ACME-"));
  expect(first.map(stamp)).toEqual([["ACME-0001"], ["ACME-0002"], ["ACME-0003"], ["ACME-0004"]]);
  expect(second.map(stamp)).toEqual([["ACME-0005"]]);
});

test("sign: the signature lands on page 2 only", async ({ page }) => {
  await page.goto("/sign");
  await uploadOne(page, fx("four-pages.pdf"), () =>
    expect(page.getByLabel("Signature drawing area")).toBeVisible({ timeout: 3000 }));
  const pad = page.getByLabel("Signature drawing area");
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(
      box.x + box.width * (0.15 + 0.06 * i),
      box.y + box.height * (0.5 + 0.25 * Math.sin(i)),
    );
  }
  await page.mouse.up();

  await page.getByRole("button", { name: "Page 2" }).click();
  await expect(page.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-pressed", "true");
  const sig = page.getByRole("group", { name: "Signature position" });
  await expect(sig).toBeVisible();
  await sig.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");

  const bytes = await download(page, "Sign and download");
  const { getDocument, OPS } = await loadPdfjs();
  const doc = await getDocument({ data: bytes }).promise;
  expect(doc.numPages).toBe(4);
  const imageOps: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const ops = await (await doc.getPage(i)).getOperatorList();
    imageOps.push(ops.fnArray.filter((f) => f === OPS.paintImageXObject).length);
  }
  expect(imageOps[1]).toBeGreaterThanOrEqual(1);
  expect(imageOps[0]).toBe(0);
  expect(imageOps[2]).toBe(0);
  expect(imageOps[3]).toBe(0);
});
