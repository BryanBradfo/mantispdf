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

interface Item { str: string; x: number; y: number; width: number }
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
      items.push({ str: it.str, x: m[4], y: m[5], width: it.width });
    }
    out.push({ width: viewport.width, height: viewport.height, items });
  }
  return out;
}

// The app's defaults (src/lib/stampBuilders.ts DEFAULT_MARGIN / DEFAULT_STYLE) and the engine's
// bottom anchor: baseline = margin - Helvetica descent (-207/1000 em) above the bottom edge.
const DEFAULT_MARGIN = 28;
const DEFAULT_SIZE = 11;
const HELVETICA_DESCENT = -207;

/** Today as yyyy-mm-dd in the browser's local time (what the app stamps for {date}). */
const browserToday = (page: Page) =>
  page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });

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
    // Display coords (origin top-left): right edge at the margin, baseline at margin - descent.
    const baselineFromBottom = DEFAULT_MARGIN - (HELVETICA_DESCENT * DEFAULT_SIZE) / 1000;
    expect(Math.abs(num!.x + num!.width - (p.width - DEFAULT_MARGIN)), `page ${i + 1} right edge`).toBeLessThan(12);
    expect(Math.abs(num!.y - (p.height - baselineFromBottom)), `page ${i + 1} baseline`).toBeLessThan(12);
  });
});

test("header and footer render {filename}, {date} and {n}", async ({ page }) => {
  await page.goto("/header-footer");
  await uploadOne(page, fx("four-pages.pdf"), () =>
    expect(page.getByText("four-pages.pdf (4 pages)")).toBeVisible({ timeout: 3000 }));
  await page.getByLabel("Header left").fill("{filename}");
  await page.getByLabel("Header right").fill("{date}");
  await page.getByLabel("Footer center").fill("Page {n} of {total}");
  const today = await browserToday(page);
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const pages = await pageTexts(await download(page, "Add and download"));
  expect(pages).toHaveLength(4);
  pages.forEach((p, i) => {
    const strs = p.items.map((it) => it.str);
    expect(strs).toContain("four-pages");
    expect(strs).toContain(today);
    expect(strs).toContain(`Page ${i + 1} of 4`);
    const header = p.items.find((it) => it.str === "four-pages")!;
    const footer = p.items.find((it) => it.str === `Page ${i + 1} of 4`)!;
    expect(header.y).toBeLessThan(0.2 * p.height);
    expect(footer.y).toBeGreaterThan(0.8 * p.height);
  });
});

test("header and footer: First number and pages shift {n}; the preview matches", async ({ page }) => {
  await page.goto("/header-footer");
  await uploadOne(page, fx("four-pages.pdf"), () =>
    expect(page.getByText("four-pages.pdf (4 pages)")).toBeVisible({ timeout: 3000 }));
  await page.getByLabel("Footer center").fill("Page {n} of {total}");
  await page.getByLabel("Pages", { exact: true }).fill("2-");
  await page.getByLabel("First number").fill("10");
  const preview = page.getByTestId("hf-preview");
  await expect(preview).toContainText("On page 2:");
  await expect(preview).toContainText("Footer center: Page 10 of 12");
  const pages = await pageTexts(await download(page, "Add and download"));
  const footers = pages.map((p) => p.items.map((it) => it.str).filter((s) => /^Page \d+ of \d+$/.test(s)));
  expect(footers).toEqual([[], ["Page 10 of 12"], ["Page 11 of 12"], ["Page 12 of 12"]]);
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

type Matrix = [number, number, number, number, number, number];
interface Rect { left: number; top: number; right: number; bottom: number }

/**
 * Display-space boxes (scale 1, origin top-left) of every image painted on `pageNo`, tracking the
 * full CTM through save/restore, transform and form XObjects: an image fills the unit square.
 */
async function imageBoxes(bytes: Uint8Array, pageNo: number): Promise<{ boxes: Rect[]; width: number; height: number }> {
  const { getDocument, OPS, Util } = await loadPdfjs();
  // pdf.js transfers (detaches) the buffer it is given: pass a copy so `bytes` can be read again.
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const p = await doc.getPage(pageNo);
  const viewport = p.getViewport({ scale: 1 });
  const ops = await p.getOperatorList();
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const boxes: Rect[] = [];
  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args as Matrix) as Matrix;
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args[0] as Matrix | null;
      if (m) ctm = Util.transform(ctm, m) as Matrix;
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.paintImageXObject) {
      const full = Util.transform(viewport.transform, ctm) as Matrix;
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => Util.applyTransform([x, y], full));
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      boxes.push({ left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) });
    }
  });
  return { boxes, width: viewport.width, height: viewport.height };
}

test("sign: a dragged signature lands where it was dropped, on page 2 only", async ({ page }) => {
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

  // Run 1: default placement.
  const before = await imageBoxes(await download(page, "Sign and download"), 2);
  expect(before.boxes).toHaveLength(1);

  // Run 2: a real mouse drag of the box, up and to the left.
  const preview = (await sig.locator("..").boundingBox())!;
  const start = (await sig.boundingBox())!;
  const [dx, dy] = [-150, -120];
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + dx, start.y + start.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
  const end = (await sig.boundingBox())!;
  expect(end.x).toBeLessThan(start.x - 100);
  expect(end.y).toBeLessThan(start.y - 80);

  const bytes = await download(page, "Sign and download");
  const after = await imageBoxes(bytes, 2);
  expect(after.boxes).toHaveLength(1);
  const [b0, b1] = [before.boxes[0], after.boxes[0]];
  const { width: w, height: h } = after;

  // Inside the page.
  expect(b1.left).toBeGreaterThanOrEqual(-0.5);
  expect(b1.top).toBeGreaterThanOrEqual(-0.5);
  expect(b1.right).toBeLessThanOrEqual(w + 0.5);
  expect(b1.bottom).toBeLessThanOrEqual(h + 0.5);
  // Moved in the dragged direction (left and up) by more than 20 pt.
  expect(b0.left - b1.left).toBeGreaterThan(20);
  expect(b0.top - b1.top).toBeGreaterThan(20);
  // And it is where the on-screen box was dropped (preview pixels scaled to points).
  const k = w / preview.width;
  expect(Math.abs(b1.left - (end.x - preview.x) * k)).toBeLessThan(3);
  expect(Math.abs(b1.top - (end.y - preview.y) * k)).toBeLessThan(3);
  expect(Math.abs(b1.right - b1.left - end.width * k)).toBeLessThan(3);

  // Only page 2 carries an image.
  for (const n of [1, 3, 4]) expect((await imageBoxes(bytes, n)).boxes, `page ${n}`).toHaveLength(0);
});

test("sign: no request leaves the app origin, and the script fonts are self-hosted", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (new URL(url).origin !== origin) foreign.push(url);
  });
  await page.goto("/sign");
  await uploadOne(page, fx("four-pages.pdf"), () =>
    expect(page.getByLabel("Signature drawing area")).toBeVisible({ timeout: 3000 }));
  await page.getByRole("tab", { name: "Type" }).click();
  await page.getByLabel("Your name").fill("Jane Doe");
  await expect(page.getByRole("group", { name: "Signature position" })).toBeVisible();
  for (const family of ["Caveat", "Dancing Script", "Homemade Apple"]) {
    const loaded = await page.evaluate(async (f) => {
      await document.fonts.load(`32px "${f}"`, "Jane Doe");
      return document.fonts.check(`32px "${f}"`, "Jane Doe") && [...document.fonts].some((ff) => ff.family.replace(/"/g, "") === f && ff.status === "loaded");
    }, family);
    expect(loaded, `${family} loaded`).toBe(true);
  }
  await page.waitForLoadState("networkidle");
  expect(foreign).toEqual([]);
});
