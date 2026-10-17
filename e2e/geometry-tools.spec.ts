import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

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
interface PageInfo { width: number; height: number; items: Item[] }

/** Display-space (origin top-left, scale 1) size and text items of every page. */
async function pages(bytes: Uint8Array): Promise<PageInfo[]> {
  const { getDocument, Util } = await loadPdfjs();
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const out: PageInfo[] = [];
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

test("crop: dragging the box on a rotated page gives a page of the dragged size", async ({ page }) => {
  await page.goto("/crop");
  await uploadOne(page, fx("rotated.pdf"), () =>
    expect(page.getByText("rotated.pdf (4 pages)")).toBeVisible({ timeout: 3000 }));
  await page.getByRole("button", { name: "Page 2" }).click();
  await expect(page.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("radio", { name: /This page/ }).check();

  const area = page.getByRole("group", { name: "Crop area" });
  await expect(area).toBeVisible();
  // The preview frame: the box is drawn to its scale.
  const frame = (await page.locator("[data-crop-frame]").boundingBox())!;
  const before = (await area.boundingBox())!;
  // Real mouse drag of the south-east handle, up and to the left: the box shrinks.
  const handle = (await area.locator('[data-handle="se"]').boundingBox())!;
  const [hx, hy] = [handle.x + handle.width / 2, handle.y + handle.height / 2];
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx - 90, hy - 70, { steps: 12 });
  await page.mouse.up();
  const after = (await area.boundingBox())!;
  expect(after.width).toBeLessThan(before.width - 60);
  expect(after.height).toBeLessThan(before.height - 50);

  const bytes = await download(page, "Crop and download");
  const out = await pages(bytes);
  expect(out).toHaveLength(4);
  // Page 2 is /Rotate 90: its displayed size is 792 x 612 pt; the frame shows it in full.
  const k = 792 / frame.width;
  expect(Math.abs(out[1].width - after.width * k), "width").toBeLessThan(2);
  expect(Math.abs(out[1].height - after.height * k), "height").toBeLessThan(2);
  // The other pages are untouched.
  expect([out[0].width, out[0].height]).toEqual([612, 792]);
  expect([out[2].width, out[2].height]).toEqual([612, 792]);
});

test("crop: auto-detect trims both pages to the content, with no foreign request", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (new URL(url).origin !== origin) foreign.push(url);
  });
  await page.goto("/crop");
  await uploadOne(page, fx("margins.pdf"), () =>
    expect(page.getByText("margins.pdf (2 pages)")).toBeVisible({ timeout: 3000 }));
  await page.getByRole("button", { name: "Auto-detect margins on all pages" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Detected margins on 2 pages" })).toBeVisible({ timeout: 20000 });
  const out = await pages(await download(page, "Crop and download"));
  expect(out).toHaveLength(2);
  // Content 300 x 450 pt plus the default 6 pt padding on each side.
  for (const p of out) {
    expect(Math.abs(p.width - 312), "width").toBeLessThan(4);
    expect(Math.abs(p.height - 462), "height").toBeLessThan(4);
  }
  await page.waitForLoadState("networkidle");
  expect(foreign).toEqual([]);
});

/** pdf.js browser build, injected into the page to render a PDF to a real canvas. */
const PDFJS_BROWSER = fileURLToPath(new URL("../node_modules/pdfjs-dist/build/pdf.min.mjs", import.meta.url));

/**
 * Render page 1 of `bytes` in the browser at scale 1 (1 px per pt) on white and return the
 * luminance (0 black .. 255 white) at each display-space point (origin top-left).
 */
async function renderedLuminance(page: Page, bytes: Uint8Array, points: [number, number][]): Promise<number[]> {
  await page.addScriptTag({ path: PDFJS_BROWSER, type: "module" });
  await page.waitForFunction(() => "pdfjsLib" in globalThis);
  return page.evaluate(async ({ data, points }) => {
    const lib = (globalThis as unknown as { pdfjsLib: Pdfjs }).pdfjsLib;
    // The app may already have pinned the worker URL on its own copy; set it only when unset.
    if (!lib.GlobalWorkerOptions.workerSrc) {
      lib.GlobalWorkerOptions.workerSrc = new URL("/pdf.worker.min.mjs", location.origin).href;
    }
    const doc = await lib.getDocument({ data: new Uint8Array(data) }).promise;
    const p = await doc.getPage(1);
    const viewport = p.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvasContext: ctx, viewport }).promise;
    return points.map(([x, y]) => {
      const [r, g, b] = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return (r + g + b) / 3;
    });
  }, { data: Array.from(bytes), points });
}

test("crop then resize: content outside the crop stays hidden on the new sheet", async ({ page }, testInfo) => {
  // margins.pdf: a black rectangle x 100..400, y 150..600 (pt, origin bottom-left) on Letter pages.
  await page.goto("/crop");
  await uploadOne(page, fx("margins.pdf"), () =>
    expect(page.getByText("margins.pdf (2 pages)")).toBeVisible({ timeout: 3000 }));
  const area = page.getByRole("group", { name: "Crop area" });
  await expect(area).toBeVisible();
  // The preview frame: the box is drawn to its scale.
  const frame = (await page.locator("[data-crop-frame]").boundingBox())!;
  // Drag the left edge (north-west handle, horizontally only) about 220 pt right, into the rectangle.
  const handle = (await area.locator('[data-handle="nw"]').boundingBox())!;
  const [hx, hy] = [handle.x + handle.width / 2, handle.y + handle.height / 2];
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + (220 * frame.width) / 612, hy, { steps: 12 });
  await page.mouse.up();
  const cropped = await download(page, "Crop and download");

  const { getDocument } = await loadPdfjs();
  const view = async (bytes: Uint8Array) => (await (await getDocument({ data: bytes.slice() }).promise).getPage(1)).view;
  const [cx0, cy0, cx1, cy1] = await view(cropped);
  expect(cx0, "the crop cuts into the rectangle").toBeGreaterThan(150);
  expect(cx0).toBeLessThan(350);

  const croppedPath = testInfo.outputPath("cropped.pdf");
  await writeFile(croppedPath, cropped);
  await page.goto("/resize");
  await uploadOne(page, croppedPath, () =>
    expect(page.getByText("cropped.pdf (2 pages)")).toBeVisible({ timeout: 3000 }));
  const resized = await download(page, "Resize and download");
  const [, , sw, sh] = await view(resized);

  // Where a user-space point of the old page lands on the new sheet (Fit, centered), in display space.
  const [w, h] = [cx1 - cx0, cy1 - cy0];
  const s = Math.min(sw / w, sh / h);
  const [tx, ty] = [(sw - s * w) / 2, (sh - s * h) / 2];
  const onSheet = (x: number, y: number): [number, number] => [(x - cx0) * s + tx, sh - ((y - cy0) * s + ty)];
  // A point of the rectangle just left of the old crop, inside the new sheet's side margin, and one just inside.
  const hiddenX = cx0 - tx / (2 * s);
  expect(hiddenX, "the hidden point is on the rectangle").toBeGreaterThan(105);
  const [hidden, shown] = await renderedLuminance(page, resized, [onSheet(hiddenX, 375), onSheet(cx0 + 20, 375)]);
  expect(shown, "content inside the old crop is drawn").toBeLessThan(80);
  expect(hidden, "content outside the old crop stays hidden").toBeGreaterThan(200);
});

test("crop: keyboard resizes with Ctrl (Cmd) + arrows and never navigates; handles are 24 px and not clipped", async ({ page }) => {
  await page.goto("/crop");
  await uploadOne(page, fx("margins.pdf"), () =>
    expect(page.getByText("margins.pdf (2 pages)")).toBeVisible({ timeout: 3000 }));
  const area = page.getByRole("group", { name: "Crop area" });
  await expect(area).toBeVisible();
  const url = page.url();
  const k = (await page.locator("[data-crop-frame]").boundingBox())!.width / 612;
  // Focus first: it may scroll the box into view, which moves its bounding box.
  await area.focus();
  const before = (await area.boundingBox())!;
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await page.keyboard.press("Control+ArrowUp");
  const resized = (await area.boundingBox())!;
  // 10 pt narrower from the right, 1 pt shorter from the bottom; the top-left corner stays.
  expect(Math.abs(before.width - resized.width - 10 * k)).toBeLessThan(1.5);
  expect(Math.abs(before.height - resized.height - 1 * k)).toBeLessThan(1.5);
  expect(Math.abs(resized.x - before.x)).toBeLessThan(0.5);
  expect(Math.abs(resized.y - before.y)).toBeLessThan(0.5);

  // Shift+arrows move by 10 pt without resizing.
  await page.keyboard.press("Shift+ArrowRight");
  const moved = (await area.boundingBox())!;
  expect(Math.abs(moved.x - resized.x - 10 * k)).toBeLessThan(1.5);
  expect(Math.abs(moved.width - resized.width)).toBeLessThan(0.5);

  // Cmd+Left is "back" in some browsers: the box handles it instead.
  await page.keyboard.press("Meta+ArrowLeft");
  expect(page.url()).toBe(url);
  await expect(page.getByText("margins.pdf (2 pages)")).toBeVisible();

  // Grow the box to the right page edge: the handle there keeps its full 24 px hit area.
  for (let i = 0; i < 6; i++) await page.keyboard.press("Control+Shift+ArrowRight");
  const se = area.locator('[data-handle="se"]');
  const box = (await se.boundingBox())!;
  expect(Math.round(box.width)).toBe(24);
  expect(Math.round(box.height)).toBe(24);
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest("[data-handle]")?.getAttribute("data-handle") ?? null,
    [box.x + box.width - 2, box.y + box.height / 2],
  );
  expect(hit, "the outer half of the edge handle is not clipped").toBe("se");
});

test("resize: Letter pages become A4 and keep their text inside", async ({ page }) => {
  await page.goto("/resize");
  await uploadOne(page, fx("four-pages.pdf"), () =>
    expect(page.getByText("four-pages.pdf (4 pages)")).toBeVisible({ timeout: 3000 }));
  await expect(page.getByLabel("Sheet size")).toHaveValue("A4");
  const out = await pages(await download(page, "Resize and download"));
  expect(out).toHaveLength(4);
  out.forEach((p, i) => {
    expect(Math.abs(p.width - 595), `page ${i + 1} width`).toBeLessThanOrEqual(1);
    expect(Math.abs(p.height - 842), `page ${i + 1} height`).toBeLessThanOrEqual(1);
    const t = p.items.find((it) => it.str === `Page ${i + 1}`);
    expect(t, `page ${i + 1} text`).toBeDefined();
    expect(t!.x).toBeGreaterThanOrEqual(0);
    expect(t!.x + t!.width).toBeLessThanOrEqual(p.width);
    expect(t!.y).toBeGreaterThanOrEqual(0);
    expect(t!.y).toBeLessThanOrEqual(p.height);
  });
});

test("n-up: 4 pages land on one sheet in reading order", async ({ page }) => {
  await page.goto("/n-up");
  await uploadOne(page, fx("four-pages.pdf"), () =>
    expect(page.getByText("four-pages.pdf (4 pages)")).toBeVisible({ timeout: 3000 }));
  await expect(page.getByRole("button", { name: "4", exact: true })).toHaveAttribute("aria-pressed", "true");
  const out = await pages(await download(page, "Arrange and download"));
  expect(out).toHaveLength(1);
  const [sheet] = out;
  const at = (n: number) => {
    const t = sheet.items.find((it) => it.str === `Page ${n}`);
    expect(t, `Page ${n} text`).toBeDefined();
    return t!;
  };
  const [p1, p2, p3, p4] = [1, 2, 3, 4].map(at);
  const [mx, my] = [sheet.width / 2, sheet.height / 2];
  expect(p1.x).toBeLessThan(mx); expect(p1.y).toBeLessThan(my);
  expect(p2.x).toBeGreaterThan(mx); expect(p2.y).toBeLessThan(my);
  expect(p3.x).toBeLessThan(mx); expect(p3.y).toBeGreaterThan(my);
  expect(p4.x).toBeGreaterThan(mx); expect(p4.y).toBeGreaterThan(my);
});

test("home lists the geometry tools", async ({ page }) => {
  await page.goto("/");
  for (const [name, href] of [["Crop PDF", "/crop"], ["Resize Pages", "/resize"], ["N-up Pages", "/n-up"]]) {
    await expect(page.locator(`a[href="${href}"]`).filter({ hasText: name })).toBeVisible();
  }
});
