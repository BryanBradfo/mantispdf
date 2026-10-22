import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const PDFJS_NODE = fileURLToPath(new URL("../node_modules/pdfjs-dist/legacy/build/pdf.mjs", import.meta.url));
const PDFJS_BROWSER = fileURLToPath(new URL("../node_modules/pdfjs-dist/build/pdf.mjs", import.meta.url));

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

// The A4 preview is 900 px tall: give the page room so every pointer position is on screen.
test.use({ viewport: { width: 1600, height: 1500 } });

/** Collects requests that leave the app origin (blob: and data: stay local). */
function watchOrigin(page: Page, origin: string): string[] {
  const foreign: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.startsWith("blob:") || u.startsWith("data:")) return;
    // Compare origins, not prefixes: "http://localhost:5181.evil" starts with the app origin.
    if (new URL(u).origin !== origin) foreign.push(u);
  });
  return foreign;
}

/** Display-space baseline of a 16 pt Helvetica text box placed by a click at `top`. */
const HELVETICA_ASCENT = 0.718;
const baselineBelow = (top: number, size = 16) => top + HELVETICA_ASCENT * size;

async function openEditor(page: Page, file: string, label: string) {
  await page.goto("/edit-pdf");
  // The drop zone says when the engine can take a file: one pick, no retries.
  const input = page.locator('input[type="file"][data-engine-ready="true"]');
  await input.waitFor({ state: "attached", timeout: 20000 });
  await input.setInputFiles(file);
  await expect(page.getByText(label)).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("editor-overlay")).toBeVisible();
}

async function download(page: Page): Promise<Uint8Array> {
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download PDF" }).click(),
  ]);
  return new Uint8Array(await readFile(await dl.path()));
}

/** Drives the overlay with real pointer input, in display-space points (origin top-left). */
class Canvas {
  constructor(private readonly page: Page, private readonly pageSize: [number, number]) {}

  private async box() {
    const b = await this.page.getByTestId("editor-overlay").boundingBox();
    if (!b) throw new Error("editor overlay is not visible");
    return b;
  }

  async at(x: number, y: number): Promise<[number, number]> {
    const b = await this.box();
    return [b.x + (x / this.pageSize[0]) * b.width, b.y + (y / this.pageSize[1]) * b.height];
  }

  async tool(name: string) {
    await this.page.getByRole("button", { name }).click();
  }

  async click(x: number, y: number) {
    const [px, py] = await this.at(x, y);
    await this.page.mouse.move(px, py);
    await this.page.mouse.down();
    await this.page.mouse.up();
  }

  async drag(from: [number, number], to: [number, number]) {
    await this.stroke([from, to]);
  }

  /** Press at the first point, move through the others in small steps, release at the last. */
  async stroke(points: [number, number][]) {
    const [sx, sy] = await this.at(...points[0]);
    await this.page.mouse.move(sx, sy);
    await this.page.mouse.down();
    for (const p of points.slice(1)) {
      const [px, py] = await this.at(...p);
      await this.page.mouse.move(px, py, { steps: 8 });
    }
    await this.page.mouse.up();
  }

  /** Baseline start of the rendered preview text `str`, converted to display-space points. */
  async previewText(str: string): Promise<[number, number]> {
    const b = await this.box();
    const loc = this.page.getByTestId("editor-overlay").locator("text", { hasText: str });
    const [x, y] = await loc.first().evaluate((el) => [Number(el.getAttribute("x")), Number(el.getAttribute("y"))]);
    return [(x / b.width) * this.pageSize[0], (y / b.height) * this.pageSize[1]];
  }
}

interface TextItem { str: string; x: number; y: number; upright: boolean }

/** Text items of page `n` in display space (origin top-left, scale 1). */
async function textItems(bytes: Uint8Array, n: number): Promise<TextItem[]> {
  const { getDocument, Util } = (await import(PDFJS_NODE)) as Pdfjs;
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const p = await doc.getPage(n);
  const viewport = p.getViewport({ scale: 1 });
  const content = await p.getTextContent();
  const out: TextItem[] = [];
  for (const it of content.items) {
    if (!("str" in it) || it.str.trim() === "") continue;
    const m = Util.transform(viewport.transform, it.transform);
    out.push({ str: it.str, x: m[4], y: m[5], upright: Math.abs(m[1]) < 1e-3 && Math.abs(m[2]) < 1e-3 && m[0] > 0 && m[3] < 0 });
  }
  await doc.destroy();
  return out;
}

interface Rendered {
  /** Mean RGB of a 3x3 pixel window at each requested display-space point. */
  samples: [number, number, number][];
  /** Checksum of the whole page raster. */
  hash: number;
}

/** Renders page `n` in the browser (white background, 2 px per pt) and samples it. */
async function render(page: Page, bytes: Uint8Array, n: number, points: [number, number][] = []): Promise<Rendered> {
  const origin = new URL(page.url()).origin;
  const renderer = await page.context().newPage();
  await renderer.route("**/__pdfjs/pdf.mjs", async (route) =>
    route.fulfill({ contentType: "text/javascript", body: await readFile(PDFJS_BROWSER) }),
  );
  await renderer.goto(`${origin}/robots.txt`);
  try {
    return await renderer.evaluate(
      async ({ data, n, points }) => {
        const pdfjs = (await import("/__pdfjs/pdf.mjs")) as typeof import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("/pdf.worker.min.mjs", location.origin).href;
        const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
        const pg = await doc.getPage(n);
        const vp = pg.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2d context");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await pg.render({ canvasContext: ctx, viewport: vp }).promise;
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 0;
        for (let i = 0; i < px.length; i++) hash = (Math.imul(hash, 31) + px[i]) | 0;
        const samples = points.map(([x, y]): [number, number, number] => {
          let r = 0, g = 0, b = 0, c = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const i = ((Math.round(y * 2) + dy) * canvas.width + Math.round(x * 2) + dx) * 4;
              r += px[i]; g += px[i + 1]; b += px[i + 2]; c++;
            }
          }
          return [r / c, g / c, b / c];
        });
        await doc.destroy();
        return { samples, hash };
      },
      { data: Array.from(bytes), n, points },
    );
  } finally {
    await renderer.close();
  }
}

const lum = ([r, g, b]: number[]) => (r + g + b) / 3;
const isDark = (c: number[]) => lum(c) < 70;
const isWhite = (c: number[]) => lum(c) > 245;
const isYellow = ([r, g, b]: number[]) => r > 240 && g > 220 && b > 120 && b < 190;
const isGreen = ([r, g, b]: number[]) => g > 120 && r < 60 && b < 60;

test("edit pdf: every tool, undo and redo, position and render of the saved page", async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? "").origin;
  const foreign = watchOrigin(page, origin);
  await openEditor(page, fx("four-pages.pdf"), "four-pages.pdf (4 pages)");
  const canvas = new Canvas(page, [595, 842]);

  // "Page 1" is 72 pt black Helvetica at baseline (150, 442): the P stem is at x ~ 159, y ~ 420.
  const original = await readFile(fx("four-pages.pdf"));
  const [stemBefore] = (await render(page, new Uint8Array(original), 1, [[159, 420]])).samples;
  expect(isDark(stemBefore), "fixture glyph pixel is black").toBe(true);

  // Text box: a click, typing, Escape commits.
  await canvas.tool("Text (T)");
  await canvas.click(300, 100);
  const field = page.getByRole("textbox", { name: "Text box content" });
  await expect(field).toBeFocused();
  await page.keyboard.type("Hello MantisPDF");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);

  // Rectangle (outline only), a drag.
  await canvas.tool("Rectangle (R)");
  await canvas.drag([60, 560], [260, 660]);

  // Highlight over the existing "Page 1" text.
  await canvas.tool("Highlight (H)");
  await canvas.drag([140, 380], [390, 470]);

  // Freehand stroke (the Draw tool is sticky): a wave, through many pointer moves.
  await canvas.tool("Draw (D)");
  const wave: [number, number][] = [];
  for (let i = 0; i <= 20; i++) wave.push([300 + i * 12, 560 + Math.sin(i / 2) * 40]);
  await canvas.stroke(wave);

  // Arrow, a drag along y = 740.
  await canvas.tool("Arrow (A)");
  await canvas.drag([60, 740], [260, 740]);

  // Image: the picker opens from the toolbar, then a drag places it (100 pt wide).
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Image (I)" }).click()]);
  await chooser.setFiles(fx("alpha.png"));
  await expect(page.getByText("Click or drag on the page to place the image.")).toBeVisible();
  await canvas.drag([400, 700], [500, 800]);

  // Undo removes the image (the last item), redo brings it back.
  const undo = page.getByRole("button", { name: "Undo (Ctrl+Z)" });
  const redo = page.getByRole("button", { name: "Redo (Ctrl+Shift+Z)" });
  await expect(redo).toBeDisabled();
  const overlay = page.getByTestId("editor-overlay");
  await expect(overlay.locator("image")).toHaveCount(1);
  await undo.click();
  await expect(redo).toBeEnabled();
  // Only the image went away: every other item is still drawn.
  await expect(overlay.locator("image")).toHaveCount(0);
  await expect(overlay.locator("text", { hasText: "Hello MantisPDF" })).toHaveCount(1);
  await expect(overlay.locator('rect[stroke="rgb(0 0 0)"]')).toHaveCount(1);
  await expect(overlay.locator("polyline")).toHaveCount(1);
  await expect(overlay.locator("polygon")).toHaveCount(1);
  await expect(overlay.locator('rect[style*="multiply"]')).toHaveCount(1);
  const [imgEdgeUndone] = (await render(page, await download(page), 1, [[425, 750]])).samples;
  expect(isWhite(imgEdgeUndone), "the undone image is not saved").toBe(true);
  await redo.click();
  await expect(redo).toBeDisabled();

  // The text box is shown by the preview where the saved page must show it.
  const [previewX, previewY] = await canvas.previewText("Hello MantisPDF");

  const bytes = await download(page);

  // Text: present, at the previewed position (3 pt), upright, placed where the click was.
  const items = await textItems(bytes, 1);
  const hello = items.find((i) => i.str.includes("Hello MantisPDF"));
  expect(hello, "text box content is saved as real text").toBeTruthy();
  expect(Math.abs(hello!.x - previewX), "text x").toBeLessThanOrEqual(3);
  expect(Math.abs(hello!.y - previewY), "text baseline").toBeLessThanOrEqual(3);
  expect(Math.abs(hello!.x - 300), "text starts at the click").toBeLessThanOrEqual(3);
  expect(Math.abs(hello!.y - baselineBelow(100)), "first baseline one ascent below the click").toBeLessThanOrEqual(3);
  expect(hello!.upright).toBe(true);
  // The page's own text is still there.
  expect(items.some((i) => i.str.includes("Page 1"))).toBe(true);

  // Pixels: rectangle outline and interior, highlight over text and over blank paper, image
  // border and (transparent, so white) interior, arrow shaft, freehand wave.
  const waveY = (i: number) => 560 + Math.sin(i / 2) * 40;
  const { samples } = await render(page, bytes, 1, [
    [60, 610], //   0 rectangle left edge
    [160, 610], //  1 rectangle interior
    [145, 455], //  2 highlight over blank paper
    [159, 420], //  3 black glyph stem under the highlight
    [425, 750], //  4 image, opaque green left half
    [475, 750], //  5 image, transparent right half
    [160, 740], //  6 arrow shaft
    [300 + 10 * 12, waveY(10)], // 7 freehand stroke
  ]);
  expect(isDark(samples[0]), "rectangle outline").toBe(true);
  expect(isWhite(samples[1]), "rectangle is not filled").toBe(true);
  expect(isYellow(samples[2]), `highlight tints blank paper (got ${samples[2]})`).toBe(true);
  expect(isDark(samples[3]), `multiply keeps the text dark under the highlight (got ${samples[3]})`).toBe(true);
  expect(isGreen(samples[4]), `image opaque half (got ${samples[4]})`).toBe(true);
  expect(isWhite(samples[5]), "image transparent half shows the paper").toBe(true);
  expect(isDark(samples[6]), "arrow shaft").toBe(true);
  expect(isDark(samples[7]), "freehand stroke").toBe(true);

  // Page 2 is untouched: same text, same raster.
  const originalPage2 = await render(page, new Uint8Array(original), 2);
  const savedPage2 = await render(page, bytes, 2);
  expect(savedPage2.hash).toBe(originalPage2.hash);
  expect((await textItems(bytes, 2)).map((i) => i.str)).toEqual(["Page 2"]);

  await page.waitForLoadState("networkidle");
  expect(foreign, "no request outside the app origin").toEqual([]);
});

test("edit pdf: a freehand stroke is saved as one vector path", async ({ page }) => {
  await openEditor(page, fx("one-page.pdf"), "one-page.pdf (1 page)");
  const canvas = new Canvas(page, [612, 792]);
  await canvas.tool("Draw (D)");
  const wave: [number, number][] = [];
  for (let i = 0; i <= 24; i++) wave.push([100 + i * 15, 300 + Math.sin(i / 2.5) * 80]);
  await canvas.stroke(wave);
  const bytes = await download(page);

  const { getDocument, OPS } = (await import(PDFJS_NODE)) as Pdfjs;
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const list = await (await doc.getPage(1)).getOperatorList();
  const strokes = list.fnArray.filter((fn) => fn === OPS.stroke || fn === OPS.closeStroke);
  expect(strokes, "one stroke operator").toHaveLength(1);
  // The stroked path spans the drawn wave (user space: origin bottom-left, 612 x 792).
  const paths = list.fnArray.flatMap((fn, i) => (fn === OPS.constructPath ? [list.argsArray[i] as unknown[]] : []));
  expect(paths.length).toBeGreaterThanOrEqual(1);
  const minMax = paths[0][2] as ArrayLike<number>;
  expect(Math.abs(minMax[0] - 100)).toBeLessThan(4);
  expect(Math.abs(minMax[2] - 460)).toBeLessThan(4);
  expect(minMax[3] - minMax[1]).toBeGreaterThan(100);
  await doc.destroy();
});

test("edit pdf: text on a rotated page is upright at the placed position", async ({ page, baseURL }) => {
  const foreign = watchOrigin(page, new URL(baseURL ?? "").origin);
  await openEditor(page, fx("rotated.pdf"), "rotated.pdf (4 pages)");
  // Page 2 is /Rotate 90: shown 792 x 612 pt.
  await page.getByRole("button", { name: "Page 2" }).click();
  await expect(page.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-pressed", "true");
  const canvas = new Canvas(page, [792, 612]);

  await canvas.tool("Text (T)");
  await canvas.click(100, 100);
  await expect(page.getByRole("textbox", { name: "Text box content" })).toBeFocused();
  await page.keyboard.type("Upright");
  await page.keyboard.press("Escape");
  const [previewX, previewY] = await canvas.previewText("Upright");

  const bytes = await download(page);
  const items = await textItems(bytes, 2);
  const mine = items.find((i) => i.str === "Upright");
  expect(mine, "text saved on page 2").toBeTruthy();
  expect(mine!.upright, "text reads upright on the displayed page").toBe(true);
  expect(Math.abs(mine!.x - 100), "x at the click").toBeLessThanOrEqual(3);
  expect(Math.abs(mine!.x - previewX), "x as previewed").toBeLessThanOrEqual(3);
  expect(Math.abs(mine!.y - previewY), "baseline as previewed").toBeLessThanOrEqual(3);
  expect(Math.abs(mine!.y - baselineBelow(100)), "first baseline one ascent below the click").toBeLessThanOrEqual(3);
  // The page's own rotated text is still where it was.
  const own = items.find((i) => i.str === "R90");
  expect(own).toBeTruthy();
  expect(Math.abs(own!.x - 400)).toBeLessThanOrEqual(1);
  expect(Math.abs(own!.y - 200)).toBeLessThanOrEqual(1);

  await page.waitForLoadState("networkidle");
  expect(foreign, "no request outside the app origin").toEqual([]);
});

test("edit pdf: a perfectly horizontal highlight drag still saves", async ({ page }) => {
  await openEditor(page, fx("one-page.pdf"), "one-page.pdf (1 page)");
  const canvas = new Canvas(page, [612, 792]);
  await canvas.tool("Highlight (H)");
  await canvas.drag([100, 200], [300, 200]);
  const bytes = await download(page);
  // The default 18 pt highlight height, centred on the drag line.
  const { samples } = await render(page, bytes, 1, [[200, 200], [200, 206], [200, 214]]);
  expect(isYellow(samples[0]), `on the drag line (got ${samples[0]})`).toBe(true);
  expect(isYellow(samples[1]), `inside the default height (got ${samples[1]})`).toBe(true);
  expect(isWhite(samples[2]), "outside the default height").toBe(true);
  await expect(page.getByText(/Invalid edit settings/)).toHaveCount(0);
});

test("edit pdf: keys typed right after placing a text box are all text", async ({ page }) => {
  await openEditor(page, fx("one-page.pdf"), "one-page.pdf (1 page)");
  const canvas = new Canvas(page, [612, 792]);
  await canvas.tool("Text (T)");
  const [x, y] = await canvas.at(100, 100);
  await page.mouse.move(x, y);
  await page.mouse.down();
  // The keys are sent right behind the release, before the page has rendered anything: "h" is
  // the Highlight shortcut and Backspace would delete the box if they reached the editor.
  const release = page.mouse.up();
  const typing = (async () => {
    await page.keyboard.type("hello");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("o world");
  })();
  await Promise.all([release, typing]);
  const field = page.getByRole("textbox", { name: "Text box content" });
  await expect(field).toHaveValue("hello world");
  await expect(page.getByRole("button", { name: "Select (V)" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(page.getByTestId("editor-overlay").locator("text", { hasText: "hello world" })).toHaveCount(1);
  // The box and its text are one undo step.
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();
  await expect(page.getByTestId("editor-overlay").locator("text")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo (Ctrl+Z)" })).toBeDisabled();
});

test("edit pdf: a text box with characters no font has is outlined in red", async ({ page }) => {
  await openEditor(page, fx("one-page.pdf"), "one-page.pdf (1 page)");
  const canvas = new Canvas(page, [612, 792]);
  const overlay = page.getByTestId("editor-overlay");
  // Characters the standard fonts lack switch the box to Noto: no warning.
  await canvas.tool("Text (T)");
  await canvas.click(100, 100);
  await page.getByRole("textbox", { name: "Text box content" }).fill("ok 日本");
  await page.keyboard.press("Escape");
  await expect(overlay.getByTestId("noto-text")).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId("font-switch-notice")).toHaveText("Uses Noto Sans for these characters");
  await page.keyboard.press("Escape"); // deselect: the warning must not depend on the selection
  const warning = overlay.locator('[data-warning="unsupported-text"]');
  await expect(warning).toHaveCount(0);
  // An emoji has no font: outlined in red.
  await canvas.tool("Text (T)");
  await canvas.click(110, 108);
  await page.getByRole("textbox", { name: "Text box content" }).fill("ok 😀");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(warning).toHaveCount(1);
  await expect(warning).toHaveAttribute("stroke", "#dc2626");
  // Fixing the text removes the outline.
  await canvas.tool("Text (T)");
  await canvas.click(110, 108);
  await page.getByRole("textbox", { name: "Text box content" }).fill("ok");
  await page.keyboard.press("Escape");
  await expect(warning).toHaveCount(0);
});

test("edit pdf: holding Shift between arrow nudges keeps them one undo step", async ({ page }) => {
  await openEditor(page, fx("one-page.pdf"), "one-page.pdf (1 page)");
  const canvas = new Canvas(page, [612, 792]);
  const overlay = page.getByTestId("editor-overlay");
  await canvas.tool("Rectangle (R)");
  await canvas.drag([100, 100], [200, 200]);
  const x = () => overlay.locator("rect[stroke]").first().getAttribute("x");
  const start = await x();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await page.keyboard.press("ArrowRight");
  expect(await x()).not.toBe(start);
  await page.keyboard.press("Control+z");
  await expect.poll(x).toBe(start);
});

test("edit pdf: five arrow nudges are one undo step", async ({ page }) => {
  await openEditor(page, fx("one-page.pdf"), "one-page.pdf (1 page)");
  const canvas = new Canvas(page, [612, 792]);
  const box = page.getByTestId("editor-overlay").locator('rect[stroke="rgb(0 0 0)"]');
  await canvas.tool("Rectangle (R)");
  await canvas.drag([100, 100], [200, 200]);
  const x = () => box.getAttribute("x");
  const start = await x();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  const moved = Number(await x());
  expect(moved - Number(start)).toBeGreaterThan(4);
  await page.keyboard.press("Control+z");
  await expect.poll(x).toBe(start);
  // The rectangle itself is still there: only the nudges were undone.
  await expect(box).toHaveCount(1);
});

test("edit pdf: Escape during a drag puts the item back", async ({ page }) => {
  await openEditor(page, fx("one-page.pdf"), "one-page.pdf (1 page)");
  const canvas = new Canvas(page, [612, 792]);
  const box = page.getByTestId("editor-overlay").locator('rect[stroke="rgb(0 0 0)"]');
  await canvas.tool("Rectangle (R)");
  await canvas.drag([100, 100], [200, 200]);
  const before = [await box.getAttribute("x"), await box.getAttribute("y")];
  // Grab the outline (an unfilled frame is hit on its edge) and drag it away.
  const [px, py] = await canvas.at(100, 150);
  await page.mouse.move(px, py);
  await page.mouse.down();
  const [qx, qy] = await canvas.at(300, 400);
  await page.mouse.move(qx, qy, { steps: 6 });
  expect(await box.getAttribute("x")).not.toBe(before[0]);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect([await box.getAttribute("x"), await box.getAttribute("y")]).toEqual(before);
  // Nothing to undo but the rectangle itself.
  await page.keyboard.press("Control+z");
  await expect(box).toHaveCount(0);
});

test("edit pdf: duplicating past the image limit shows a notice instead", async ({ page }) => {
  test.setTimeout(120_000);
  await openEditor(page, fx("one-page.pdf"), "one-page.pdf (1 page)");
  const canvas = new Canvas(page, [612, 792]);
  const images = page.getByTestId("editor-overlay").locator("image");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Image (I)" }).click()]);
  await chooser.setFiles(fx("alpha.png"));
  await canvas.click(100, 100);
  await expect(images).toHaveCount(1);
  // Each duplicate is selected, so Ctrl+D keeps duplicating the newest copy.
  for (let i = 1; i < 200; i++) await page.keyboard.press("Control+d");
  await expect(images).toHaveCount(200);
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.keyboard.press("Control+d");
  await expect(page.getByRole("status")).toHaveText("A document can hold at most 200 images.");
  await expect(images).toHaveCount(200);
  // The 200 placements share one image: the download still works.
  const bytes = await download(page);
  expect(bytes.length).toBeGreaterThan(0);
});

test("edit pdf: /edit still redirects to /organize and the home page lists the tool", async ({ page }) => {
  await page.goto("/edit");
  await expect(page).toHaveURL(/\/organize$/);
  await page.goto("/");
  await page.getByRole("link", { name: /Edit PDF/ }).click();
  await expect(page).toHaveURL(/\/edit-pdf$/);
  await expect(page.getByRole("heading", { name: "Edit PDF", level: 1 })).toBeVisible();
});

test("edit pdf: the preview draws right-to-left runs as the PDF does, punctuation included", async ({ page }) => {
  await openEditor(page, fx("one-page.pdf"), "one-page.pdf (1 page)");
  const canvas = new Canvas(page, [612, 792]);
  const overlay = page.getByTestId("editor-overlay");
  // In a right-to-left paragraph the final "!" or "." is drawn at the left end (the PDF's order).
  // The Arabic comma is drawn with the Arabic font: inside the right-to-left run, at its end.
  for (const [i, [text, mark, letter]] of [["שלום!", "!", "ש"], ["مرحبا.", ".", "م"], ["مرحبا،", "،", "م"]].entries()) {
    await canvas.tool("Text (T)");
    await canvas.click(100, 100 + 80 * i);
    await page.getByRole("textbox", { name: "Text box content" }).fill(text);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const box = overlay.getByTestId("noto-text").nth(i);
    await expect(box.locator("text", { hasText: letter })).toHaveCount(1, { timeout: 30000 });
    // The centre of each character on screen, whichever run holds it.
    const [markX, letterX] = await box.evaluate(
      (g, [m, l]) => {
        const at = (ch: string) => {
          for (const el of Array.from(g.querySelectorAll("text"))) {
            const chars = Array.from(el.textContent ?? "");
            const k = chars.indexOf(ch);
            if (k < 0) continue;
            const r = (el as SVGTextElement).getExtentOfChar(k);
            return r.x + r.width / 2;
          }
          return NaN;
        };
        return [at(m), at(l)];
      },
      [mark, letter],
    );
    expect(markX, `${text}: "${mark}" left of "${letter}"`).toBeLessThan(letterX);
  }
});

test("edit pdf: standard-font text never fetches the font list", async ({ page }) => {
  const fontRequests: string[] = [];
  await page.route("**/fonts-runtime/**", (route) => {
    fontRequests.push(route.request().url());
    return route.abort();
  });
  await openEditor(page, fx("one-page.pdf"), "one-page.pdf (1 page)");
  const canvas = new Canvas(page, [612, 792]);
  await canvas.tool("Text (T)");
  await canvas.click(100, 100);
  await page.getByRole("textbox", { name: "Text box content" }).fill("Plain café text");
  await page.keyboard.press("Escape");
  const bytes = await download(page);
  expect(bytes.length).toBeGreaterThan(0);
  expect(fontRequests).toEqual([]);
});
