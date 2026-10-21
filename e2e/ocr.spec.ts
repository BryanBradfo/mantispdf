import { test, expect, type Download, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const PDFJS_NODE = fileURLToPath(new URL("../node_modules/pdfjs-dist/legacy/build/pdf.mjs", import.meta.url));

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/**
 * Fixtures from scripts/make-ocr-fixtures.py: scan.pdf (a 300 dpi scan of "MANTIS OCR TEST 2026"
 * and "SEARCHABLE SCANNED PAGE", no text), scan-mixed.pdf (p1 real text, p2 that scan),
 * scan-rotated.pdf (/Rotate 90 over an offset CropBox, upright scan). ocr-expected.json holds
 * each drawn word's ink box `[x, y, w, h]` and baseline in visible points (y up).
 */
interface ExpectedWord {
  text: string;
  box: [number, number, number, number];
  baseline: number;
}
type Expected = Record<string, Record<string, ExpectedWord[]>>;

/** Recognition runs real tesseract workers: generous, but no fixed sleeps. */
const OCR_TIMEOUT = 120_000;
/** Points a recognised word may sit away from where the fixture drew it. */
const TOLERANCE = 3;

test.use({ viewport: { width: 1400, height: 1200 } });

/** Requests that leave the app origin, and the /ocr-runtime/ responses, from every page and worker. */
function watchNetwork(page: Page, origin: string) {
  const foreign: string[] = [];
  const ocrAssets: { path: string; status: number }[] = [];
  page.context().on("request", (r) => {
    const u = r.url();
    if (u.startsWith("blob:") || u.startsWith("data:")) return;
    if (new URL(u).origin !== origin) foreign.push(u);
  });
  page.context().on("response", (r) => {
    const u = new URL(r.url());
    if (u.origin === origin && u.pathname.startsWith("/ocr-runtime/")) ocrAssets.push({ path: u.pathname, status: r.status() });
  });
  return { foreign, ocrAssets };
}

/**
 * Console errors, uncaught page errors and failed responses. Vercel Analytics' script only
 * exists on Vercel: its 404 under `vite preview` is not ours.
 */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && !new URL(r.url()).pathname.startsWith("/_vercel/")) errors.push(`${r.status()} ${r.url()}`);
  });
  return errors;
}

async function upload(page: Page, fixture: string) {
  await page.goto("/ocr");
  const input = page.locator('input[type="file"][data-engine-ready="true"]');
  await input.waitFor({ state: "attached", timeout: 20000 });
  await input.setInputFiles(fx(fixture));
  await expect(page.getByRole("button", { name: "Run OCR" })).toBeEnabled({ timeout: 20000 });
  // English only, whatever the browser's language.
  for (const lang of ["French", "German", "Spanish", "Italian", "Portuguese", "Dutch"]) {
    const chip = page.getByRole("button", { name: lang, exact: true });
    if ((await chip.getAttribute("aria-pressed")) === "true") await chip.click();
  }
  await expect(page.getByRole("button", { name: "English", exact: true })).toHaveAttribute("aria-pressed", "true");
}

/** Run OCR and wait for the summary. */
async function runOcr(page: Page) {
  await page.getByRole("button", { name: "Run OCR" }).click();
  await expect(page.getByText(/^Text recognised on \d+ pages?/)).toBeVisible({ timeout: OCR_TIMEOUT });
}

async function downloadOf(page: Page, button: string): Promise<{ download: Download; bytes: Uint8Array }> {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: button }).click()]);
  return { download, bytes: new Uint8Array(await readFile(await download.path())) };
}

interface PlacedItem {
  str: string;
  /** Baseline start in visible points (y up), and the advance length. */
  x: number;
  y: number;
  width: number;
}

/** Each page's non-blank text items (pdf.js), positioned in visible space. */
async function textItems(bytes: Uint8Array): Promise<PlacedItem[][]> {
  const { getDocument } = (await import(PDFJS_NODE)) as Pdfjs;
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const pages: PlacedItem[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: PlacedItem[] = [];
    for (const i of content.items) {
      if (!("str" in i) || i.str.trim() === "") continue;
      // Viewport space is visible space with y down.
      const [vx, vy] = viewport.convertToViewportPoint(i.transform[4], i.transform[5]);
      items.push({ str: i.str, x: vx, y: viewport.height - vy, width: i.width });
    }
    pages.push(items);
  }
  await doc.destroy();
  return pages;
}

const expected = async (): Promise<Expected> => JSON.parse(await readFile(fx("ocr-expected.json"), "utf8")) as Expected;

/**
 * pdf.js reads every expected word, in order, on its baseline. It merges words whose space
 * glyphs close the gaps into one item, so an item's start is checked against its first word's
 * ink box and its end against its last word's.
 */
function expectWordsAt(items: PlacedItem[], words: ExpectedWord[]) {
  expect(items.map((i) => i.str.trim()).join(" ")).toBe(words.map((w) => w.text).join(" "));
  let k = 0;
  for (const item of items) {
    const tokens = item.str.trim().split(/\s+/);
    const first = words[k];
    const last = words[k + tokens.length - 1];
    k += tokens.length;
    const at = `"${item.str}" at ${item.x.toFixed(2)}, ${item.y.toFixed(2)} w ${item.width.toFixed(2)}`;
    expect(Math.abs(item.x - first.box[0]), `${at}: start vs ${first.text} ${first.box}`).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(item.x + item.width - (last.box[0] + last.box[2])), `${at}: end vs ${last.text} ${last.box}`).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(item.y - first.baseline), `${at}: baseline vs ${first.baseline}`).toBeLessThanOrEqual(TOLERANCE);
  }
}

/**
 * Each word's box through poppler (`pdftotext -bbox -cropbox`: visible space with y down from
 * the top of the page as displayed; it splits words at the space glyphs) within `TOLERANCE` of
 * the ink box the fixture drew. Poppler's `<page height>` stays unrotated, hence `visibleHeight`.
 */
function expectPopplerWordsAt(bytes: Uint8Array, pageNumber: number, visibleHeight: number, words: ExpectedWord[]) {
  const dir = mkdtempSync(join(tmpdir(), "ocr-e2e-"));
  writeFileSync(join(dir, "in.pdf"), bytes);
  let html: string;
  try {
    html = execFileSync("pdftotext", ["-bbox", "-cropbox", "-f", String(pageNumber), "-l", String(pageNumber), join(dir, "in.pdf"), "-"], { encoding: "utf8" });
  } catch {
    throw new Error("ocr.spec.ts needs pdftotext (poppler-utils) for its per-word checks: install it");
  }
  const height = visibleHeight;
  const found = [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
    text: m[5],
    box: [Number(m[1]), height - Number(m[4]), Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])],
  }));
  expect(found.map((f) => f.text)).toEqual(words.map((w) => w.text));
  words.forEach((w, i) => {
    const [x, y, width, h] = found[i].box;
    const [ex, ey, ew, eh] = w.box;
    const at = `${w.text}: poppler ${found[i].box.map((v) => v.toFixed(2))} vs ink ${w.box}`;
    expect(Math.abs(x - ex), at).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(x + width - (ex + ew)), at).toBeLessThanOrEqual(TOLERANCE);
    // The layer's glyph boxes span the whole word box (descent 0.2 h below the baseline).
    expect(y, at).toBeLessThanOrEqual(ey + TOLERANCE);
    expect(Math.abs(y + h - (ey + eh)), at).toBeLessThanOrEqual(TOLERANCE + 0.25 * eh);
  });
}

const ocrWorkers = (page: Page) => page.workers().filter((w) => w.url().includes("/ocr-runtime/worker.min.js"));
/** Most tesseract workers the engine runs (min(2, cores - 1)). */
const MAX_OCR_WORKERS = 2;

/** No tesseract worker, and none coming back: 0 reached, then 0 at every look for `stableMs`. */
async function expectNoOcrWorkers(page: Page, stableMs = 2000) {
  await expect.poll(() => ocrWorkers(page).length, { timeout: 20000 }).toBe(0);
  const until = Date.now() + stableMs;
  while (Date.now() < until) {
    expect(ocrWorkers(page).length).toBe(0);
    await page.waitForTimeout(100);
  }
}

/** Page `n` rendered by poppler (pdftoppm, 72 dpi, PPM bytes). */
function renderPage(bytes: Uint8Array, n: number): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "ocr-e2e-"));
  writeFileSync(join(dir, "in.pdf"), bytes);
  try {
    execFileSync("pdftoppm", ["-r", "72", "-f", String(n), "-l", String(n), "-singlefile", join(dir, "in.pdf"), join(dir, "out")]);
  } catch {
    throw new Error("ocr.spec.ts needs pdftoppm (poppler-utils) for its render checks: install it");
  }
  return readFileSync(join(dir, "out.ppm"));
}

test("makes a scan searchable where the words are, exports the text, all from the origin", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const origin = new URL(baseURL ?? "http://localhost").origin;
  const net = watchNetwork(page, origin);
  await upload(page, "scan.pdf");
  await runOcr(page);
  await expect(page.getByText("Text recognised on 1 page (7 words).")).toBeVisible();

  const { download, bytes } = await downloadOf(page, "Download searchable PDF");
  expect(download.suggestedFilename()).toBe("scan_ocr.pdf");
  const [items] = await textItems(bytes);
  expectWordsAt(items, (await expected())["scan.pdf"]["1"]);
  expectPopplerWordsAt(bytes, 1, 792, (await expected())["scan.pdf"]["1"]);

  const text = await downloadOf(page, "Download text");
  expect(text.download.suggestedFilename()).toBe("scan_ocr.txt");
  expect(new TextDecoder().decode(text.bytes)).toBe("--- Page 1 ---\nMANTIS OCR TEST 2026\n\nSEARCHABLE SCANNED PAGE\n");

  // Worker, one core build and the English model, all served by this origin.
  const paths = net.ocrAssets.map((a) => a.path);
  expect(paths).toContain("/ocr-runtime/worker.min.js");
  expect(paths.some((p) => /^\/ocr-runtime\/core\/tesseract-core-[a-z-]*lstm\.wasm\.js$/.test(p))).toBe(true);
  expect(paths).toContain("/ocr-runtime/lang/eng.traineddata.gz");
  expect(net.ocrAssets.every((a) => a.status === 200 || a.status === 304), JSON.stringify(net.ocrAssets)).toBe(true);
  expect(net.foreign).toEqual([]);
});

test("skips a page that already has text and leaves it as it was", async ({ page }) => {
  test.setTimeout(240_000);
  await upload(page, "scan-mixed.pdf");
  await expect(page.getByLabel("Skip pages that already contain text")).toBeChecked();
  await runOcr(page);
  await expect(page.getByText("Skipped (already had text): page 1.")).toBeVisible();
  await expect(page.getByText("Text recognised on 1 page (7 words).")).toBeVisible();

  const input = new Uint8Array(await readFile(fx("scan-mixed.pdf")));
  const original = await textItems(input);
  const { bytes } = await downloadOf(page, "Download searchable PDF");
  const out = await textItems(bytes);
  expect(out[0]).toEqual(original[0]);
  // The skipped page renders exactly as before.
  expect(renderPage(bytes, 1).equals(renderPage(input, 1))).toBe(true);
  expectWordsAt(out[1], (await expected())["scan-mixed.pdf"]["2"]);
  expectPopplerWordsAt(bytes, 2, 792, (await expected())["scan-mixed.pdf"]["2"]);

  const text = await downloadOf(page, "Download text");
  // The whole document: the skipped page's own text, then the recognised page.
  expect(new TextDecoder().decode(text.bytes)).toBe(
    "--- Page 1 ---\nThis page already has real text on it.\n\f--- Page 2 ---\nMANTIS OCR TEST 2026\n\nSEARCHABLE SCANNED PAGE\n",
  );
});

test("places words in visible space on a rotated, cropped page", async ({ page }) => {
  test.setTimeout(240_000);
  await upload(page, "scan-rotated.pdf");
  await runOcr(page);
  const { bytes } = await downloadOf(page, "Download searchable PDF");
  const [items] = await textItems(bytes);
  expectWordsAt(items, (await expected())["scan-rotated.pdf"]["1"]);
  expectPopplerWordsAt(bytes, 1, 540, (await expected())["scan-rotated.pdf"]["1"]);
});

test("cancel while the engine starts, and while pages are read, leaves no worker and no error", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const net = watchNetwork(page, new URL(baseURL ?? "http://localhost").origin);
  const errors = watchErrors(page);
  // 12 scanned pages: a run that lasts long enough to cancel in the middle.
  await upload(page, "scan-long.pdf");
  const run = page.getByRole("button", { name: "Run OCR" });

  // During startup (worker, core and model loading; a fresh context has no cached models).
  await run.click();
  await expect(page.getByText(/^(Starting the OCR engine|Loading language data)/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(run).toBeEnabled();
  await expectNoOcrWorkers(page);

  // Mid-run: workers up, a page done and more to go.
  await run.click();
  await expect(page.getByText(/^Reading page \d+ \([1-9]\d* of 12 done\)/)).toBeVisible({ timeout: OCR_TIMEOUT });
  expect(ocrWorkers(page).length).toBeGreaterThan(0);
  expect(ocrWorkers(page).length).toBeLessThanOrEqual(MAX_OCR_WORKERS);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(run).toBeEnabled();
  await expect(page.getByRole("progressbar", { name: "OCR progress" })).toHaveCount(0);
  await expect(page.getByText(/^Text recognised on/)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectNoOcrWorkers(page);
  expect(errors).toEqual([]);
  expect(net.foreign).toEqual([]);
});

test("Redact finds an OCR'd word by search and removes it in place", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const net = watchNetwork(page, new URL(baseURL ?? "http://localhost").origin);
  await upload(page, "scan.pdf");
  await runOcr(page);
  const { bytes: searchable } = await downloadOf(page, "Download searchable PDF");

  await page.goto("/redact");
  const input = page.locator('input[type="file"][data-engine-ready="true"]');
  await input.waitFor({ state: "attached", timeout: 20000 });
  await input.setInputFiles({ name: "scan_ocr.pdf", mimeType: "application/pdf", buffer: Buffer.from(searchable) });
  await expect(page.getByTestId("redact-canvas")).toBeVisible({ timeout: 20000 });
  await page.getByRole("searchbox", { name: "Text to find" }).fill("MANTIS");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByText(/1 match for "MANTIS" on page 1/)).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Mark all" }).click();

  // The OCR layer is ordinary text: the page is redacted in place, never converted to an image
  // (that would ask first in an alertdialog and the download would not start).
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: "Redact and download" }).click()]);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByText(/Converted to images/)).toHaveCount(0);
  const out = new Uint8Array(await readFile(await download.path()));

  const [items] = await textItems(out);
  const all = items.map((i) => i.str).join(" ");
  expect(all).not.toContain("MANTIS");
  expect(all).toContain("OCR");
  expect(all).toContain("SEARCHABLE");
  expect(net.foreign).toEqual([]);
});
