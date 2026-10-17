import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const PDFJS = fileURLToPath(new URL("../node_modules/pdfjs-dist/build/pdf.mjs", import.meta.url));

/** Fails the test if the page requests anything outside its own origin (blob:/data: are local). */
function watchOrigin(page: Page, origin: string): string[] {
  const foreign: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith("blob:") && !u.startsWith("data:")) foreign.push(u);
  });
  return foreign;
}

async function download(page: Page, name: string | RegExp): Promise<Uint8Array> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name }).click()]);
  return new Uint8Array(await readFile(await dl.path()));
}

interface Box { x0: number; y0: number; x1: number; y1: number }
interface Sample {
  width: number;
  height: number;
  /** Bounding box of non-white pixels (null if the page is blank). */
  ink: Box | null;
  /** Mean RGB of a region given in canvas pixels. */
  mean: (b: Box) => [number, number, number];
}
interface RenderedPage {
  width: number;
  height: number;
  ink: Box | null;
  means: Record<string, [number, number, number]>;
}

/**
 * Renders page `n` of `bytes` with pdf.js into a canvas inside the browser (white page, scale 4)
 * and returns the ink bounding box plus the mean colour of the regions asked for. Regions are
 * fractions of the ink box ("ink") or of the whole page ("page").
 */
async function renderPage(
  page: Page,
  bytes: Uint8Array,
  n: number,
  regions: Record<string, { of: "ink" | "page"; x0: number; y0: number; x1: number; y1: number }>,
): Promise<RenderedPage> {
  return page.evaluate(
    async ({ data, n, regions }) => {
      const pdfjs = (await import("/__pdfjs/pdf.mjs")) as typeof import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("/pdf.worker.min.mjs", location.origin).href;
      const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
      const pg = await doc.getPage(n);
      const vp = pg.getViewport({ scale: 4 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d context");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      const { width, height } = canvas;
      const px = ctx.getImageData(0, 0, width, height).data;
      let x0 = width, y0 = height, x1 = -1, y1 = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (px[i] < 235 || px[i + 1] < 235 || px[i + 2] < 235) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      const ink = x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
      const means: Record<string, [number, number, number]> = {};
      for (const [k, r] of Object.entries(regions)) {
        const base = r.of === "ink" && ink ? ink : { x0: 0, y0: 0, x1: width, y1: height };
        const w = base.x1 - base.x0;
        const h = base.y1 - base.y0;
        const ax = Math.floor(base.x0 + r.x0 * w);
        const bx = Math.max(ax + 1, Math.floor(base.x0 + r.x1 * w));
        const ay = Math.floor(base.y0 + r.y0 * h);
        const by = Math.max(ay + 1, Math.floor(base.y0 + r.y1 * h));
        let sr = 0, sg = 0, sb = 0, c = 0;
        for (let y = ay; y < by; y++) {
          for (let x = ax; x < bx; x++) {
            const i = (y * width + x) * 4;
            sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; c++;
          }
        }
        means[k] = [sr / c, sg / c, sb / c];
      }
      await doc.destroy();
      const pt = (v: number) => v / 4;
      return {
        width: pt(width),
        height: pt(height),
        ink: ink && { x0: pt(ink.x0), y0: pt(ink.y0), x1: pt(ink.x1), y1: pt(ink.y1) },
        means,
      };
    },
    { data: Array.from(bytes), n, regions },
  );
}

const isRed = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;
const isBlue = ([r, g, b]: number[]) => b > 200 && r < 60 && g < 60;
const isGreen = ([r, g, b]: number[]) => g > 120 && r < 60 && b < 60;
const isWhite = ([r, g, b]: number[]) => r > 250 && g > 250 && b > 250;

/** A same-origin page that can import pdf.js (served from node_modules through a route). */
async function openRenderer(page: Page) {
  await page.route("**/__pdfjs/pdf.mjs", async (route) =>
    route.fulfill({ contentType: "text/javascript", body: await readFile(PDFJS) }),
  );
  // The browser's ImageDecoder applies a JPEG's EXIF orientation on top of the PDF's own transform;
  // Acrobat, poppler and friends ignore EXIF inside PDFs. Hide ImageDecoder so pdf.js uses its
  // plain JS JPEG decoder and the pixels mean what the PDF says.
  await page.route("**/pdf.worker.min.mjs", async (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "globalThis.ImageDecoder = undefined;\n" + (await readFile(PDFJS.replace("pdf.mjs", "pdf.worker.min.mjs"), "utf8")),
    }),
  );
  await page.goto("/robots.txt"); // any document in the origin can import() the stub
}

test("images to pdf: EXIF orientation, alpha over white, reorder, A4 pages", async ({ page, baseURL }) => {
  const foreign = watchOrigin(page, baseURL ?? "");
  await page.goto("/images-to-pdf");
  const cards = page.getByTestId("image-card");
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles([fx("photo-exif6.jpg"), fx("alpha.png")]);
    await expect(cards).toHaveCount(2, { timeout: 3000 });
  }).toPass({ timeout: 20000 });
  await expect(cards.nth(0)).toContainText("photo-exif6.jpg");
  await expect(cards.nth(1)).toContainText("alpha.png");

  // Drag the PNG card (second) onto the JPEG card (first) so the PNG becomes page 1.
  const a = await cards.nth(1).boundingBox();
  const b = await cards.nth(0).boundingBox();
  if (!a || !b) throw new Error("cards not visible");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 - 10, a.y + a.height * 0.35, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2 - 5, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect.poll(async () => (await cards.allInnerTexts()).map((t) => t.match(/(photo-exif6|alpha)\.(jpg|png)/)?.[1])).toEqual(["alpha", "photo-exif6"]);

  const bytes = await download(page, "Create PDF");

  await openRenderer(page);
  // Images keep their natural size (96 dpi: 1 px = 0.75 pt) and sit centred inside the margins.
  const PX = 0.75;
  const centreX = 595.28 / 2;
  const r1 = await renderPage(page, bytes, 1, {
    // alpha.png is 20x20 px = 15x15 pt: opaque green left half, transparent right half.
    left: { of: "page", x0: (centreX - 7.5 + 1) / 595.28, y0: 0.5 - 6 / 841.89, x1: (centreX - 1) / 595.28, y1: 0.5 + 6 / 841.89 },
    right: { of: "page", x0: (centreX + 1) / 595.28, y0: 0.5 - 6 / 841.89, x1: (centreX + 7.5 - 1) / 595.28, y1: 0.5 + 6 / 841.89 },
  });
  const r2 = await renderPage(page, bytes, 2, {
    top: { of: "ink", x0: 0.1, y0: 0.05, x1: 0.9, y1: 0.45 },
    bottom: { of: "ink", x0: 0.1, y0: 0.55, x1: 0.9, y1: 0.95 },
  });

  // Two A4 portrait pages (595.28 x 841.89 pt).
  for (const r of [r1, r2]) {
    expect(Math.abs(r.width - 595.28)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.height - 841.89)).toBeLessThanOrEqual(1);
  }

  // Page 1 = alpha.png after the drag: left half green, right half is the white page showing through.
  expect(r1.ink).not.toBeNull();
  expect(Math.abs(r1.ink!.x1 - r1.ink!.x0 - (20 * PX) / 2)).toBeLessThanOrEqual(1.5);
  expect(isGreen(r1.means.left)).toBe(true);
  expect(isWhite(r1.means.right)).toBe(true);

  // Page 2 = photo-exif6.jpg: stored 40x20, EXIF 6 makes it 20 wide x 40 tall.
  // Upright: the stored left (red) half is now on TOP and the right (blue) half at the BOTTOM.
  expect(r2.ink).not.toBeNull();
  const ink2 = r2.ink!;
  expect(Math.abs(ink2.x1 - ink2.x0 - 20 * PX)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(ink2.y1 - ink2.y0 - 40 * PX)).toBeLessThanOrEqual(1.5);
  expect(isRed(r2.means.top)).toBe(true);
  expect(isBlue(r2.means.bottom)).toBe(true);

  expect(foreign).toEqual([]);
});

test("jpg-to-pdf redirects to images-to-pdf", async ({ page }) => {
  await page.goto("/jpg-to-pdf");
  await expect(page).toHaveURL(/\/images-to-pdf$/);
  await expect(page.getByRole("heading", { name: "Images to PDF" })).toBeVisible();
});

test("extract images: ZIP holds the JPEG byte-for-byte once, plus a PNG", async ({ page, baseURL }) => {
  const foreign = watchOrigin(page, baseURL ?? "");
  await page.goto("/extract-images");
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles(fx("images.pdf"));
    await expect(page.getByRole("button", { name: "Extract images" })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20000 });
  await page.getByRole("button", { name: "Extract images" }).click();

  // The 2x2 Flate image is below the 32 px threshold: it is hidden until the filter is off.
  await page.getByLabel(/Skip images smaller than 32 px/).uncheck();
  await expect(page.getByText("2 of 2 selected")).toBeVisible();

  const zip = unzipSync(await download(page, "Download ZIP"));
  const names = Object.keys(zip).sort();
  expect(names).toHaveLength(2);
  const jpgs = names.filter((n) => n.toLowerCase().endsWith(".jpg"));
  const pngs = names.filter((n) => n.toLowerCase().endsWith(".png"));
  expect(jpgs).toHaveLength(1);
  expect(pngs).toHaveLength(1);
  const original = new Uint8Array(await readFile(fx("photo-exif6.jpg")));
  expect(Buffer.from(zip[jpgs[0]]).equals(Buffer.from(original))).toBe(true);
  expect(Array.from(zip[pngs[0]].slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(foreign).toEqual([]);
});
