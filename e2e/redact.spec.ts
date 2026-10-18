import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const PDFJS_NODE = fileURLToPath(new URL("../node_modules/pdfjs-dist/legacy/build/pdf.mjs", import.meta.url));

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

// Room for the page preview (up to 900 px tall) and the side panel.
test.use({ viewport: { width: 1600, height: 1400 } });

/**
 * redact.pdf (scripts/make-redact-fixtures.py): four US Letter pages, no crop or rotation, so
 * visible space is user space. Helvetica 12 on page 1: "Account number: 4417 1234 5678 9113" at
 * y 720 ("number" spans x 118.7..162.1), "JOHN SMITH, a tall man" at y 700, "Public line
 * stays" at y 680; a JPEG drawn at x 72..232, y 520..600 (left half red, right half blue).
 * Page 2 and 3 draw one form ("Form secret: CONFIDENTIAL"); page 4 uses a Type3 font.
 */
const PAGE_H = 792;
/** Visible-space areas `[x, y, w, h]`. */
const NUMBER: Box = [120, 718, 40, 10];
const JPEG_LEFT: Box = [72, 520, 80, 80];
const TYPE3: Box = [70, 595, 80, 34];
type Box = [number, number, number, number];

/** Collects requests that leave the app origin, from every page and worker of the context. */
function watchOrigin(page: Page, origin: string): string[] {
  const foreign: string[] = [];
  page.context().on("request", (r) => {
    const u = r.url();
    if (u.startsWith("blob:") || u.startsWith("data:")) return;
    if (new URL(u).origin !== origin) foreign.push(u);
  });
  return foreign;
}

/** Drag a box on the page preview, in visible points. */
async function drawArea(page: Page, [x, y, w, h]: Box) {
  const svg = page.locator('[data-testid="redact-canvas"] svg');
  const box = await svg.boundingBox();
  if (!box) throw new Error("no canvas");
  const s = box.width / 612;
  const at = (vx: number, vy: number) => [box.x + vx * s, box.y + (PAGE_H - vy) * s] as const;
  const [x0, y0] = at(x, y + h);
  const [x1, y1] = at(x + w, y);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
}

async function goToPage(page: Page, n: number) {
  await page.getByRole("group", { name: "Pages" }).getByRole("button", { name: new RegExp(`^Page ${n}\\b`) }).click();
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
}

/** Each page's text items (pdf.js, like the browser would read them). */
async function textItems(bytes: Uint8Array): Promise<TextItemLike[][]> {
  const { getDocument } = (await import(PDFJS_NODE)) as Pdfjs;
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const pages: TextItemLike[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.filter((i): i is TextItemLike & { str: string } => "str" in i && i.str.length > 0));
  }
  await doc.destroy();
  return pages;
}

const joined = (items: TextItemLike[]) => items.map((i) => i.str).join(" ");

/** Centres of the characters of `items` (item width split by character count; good to a few points). */
function charCentres(items: TextItemLike[]): { ch: string; x: number; y: number }[] {
  return items.flatMap((i) =>
    [...i.str].map((ch, k) => ({ ch, x: i.transform[4] + (i.width * (k + 0.5)) / i.str.length, y: i.transform[5] + 4 })),
  );
}

const inside = ([x, y, w, h]: Box, px: number, py: number, margin = 0) =>
  px > x + margin && px < x + w - margin && py > y + margin && py < y + h - margin;

/** RGB of page `n` at 72 dpi (1 px per point) through pdftoppm (poppler-utils, required). */
function render(bytes: Uint8Array, n: number): (x: number, y: number) => [number, number, number] {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
  } catch {
    throw new Error("redact.spec.ts needs pdftoppm (poppler-utils) for its pixel checks: install it");
  }
  const dir = mkdtempSync(join(tmpdir(), "redact-e2e-"));
  writeFileSync(join(dir, "in.pdf"), bytes);
  execFileSync("pdftoppm", ["-r", "72", "-f", String(n), "-l", String(n), "-singlefile", join(dir, "in.pdf"), join(dir, "out")]);
  const ppm = readFileSync(join(dir, "out.ppm"));
  // P6 header: "P6\n<w> <h>\n255\n".
  const header = ppm.subarray(0, 32).toString("latin1").split(/\s+/);
  const width = Number(header[1]);
  const offset = ppm.indexOf(0x0a, ppm.indexOf(0x0a, ppm.indexOf(0x0a) + 1) + 1) + 1;
  // Visible (x, y) with y up from the bottom.
  return (x, y) => {
    const row = Math.floor(PAGE_H - y);
    const i = offset + 3 * (row * width + Math.floor(x));
    return [ppm[i], ppm[i + 1], ppm[i + 2]];
  };
}

const near = (a: [number, number, number], b: [number, number, number], tolerance = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

test("redacts an area, a search match and a whole page, rasterizing what it must", async ({ page, baseURL }) => {
  const foreign = watchOrigin(page, new URL(baseURL ?? "http://localhost").origin);
  const original = new Uint8Array(await readFile(fx("redact.pdf")));
  await page.goto("/redact");
  const input = page.locator('input[type="file"][data-engine-ready="true"]');
  await input.waitFor({ state: "attached", timeout: 20000 });
  await input.setInputFiles(fx("redact.pdf"));
  await expect(page.getByTestId("redact-canvas")).toBeVisible({ timeout: 20000 });

  // An area across a word, and one over half of the JPEG.
  await drawArea(page, NUMBER);
  await drawArea(page, JPEG_LEFT);

  // Engine search, then "Mark all".
  await page.getByRole("searchbox", { name: "Text to find" }).fill("SMITH");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByText(/1 match for "SMITH" on page 1/)).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Mark all" }).click();

  // The whole of page 3, and an area on the Type3 page.
  await goToPage(page, 3);
  await page.getByLabel("Redact whole page 3").check();
  await goToPage(page, 4);
  await drawArea(page, TYPE3);

  // The plan reports the Type3 page; continuing renders it (renderRaster) and redacts.
  await page.getByRole("button", { name: "Redact and download" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Page 4 will be converted to an image", { timeout: 30000 });
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), dialog.getByRole("button", { name: "Continue" }).click()]);
  expect(download.suggestedFilename()).toBe("redact_redacted.pdf");
  const out = new Uint8Array(await readFile(await download.path()));
  await expect(page.getByText("Converted to images: page 4.")).toBeVisible();

  const before = await textItems(original);
  const after = await textItems(out);
  expect(after.length).toBe(4);

  // Page 1: no character left inside a marked area; the rest unchanged.
  const page1 = joined(after[0]);
  expect(page1).toContain("JOHN");
  expect(page1).not.toContain("SMITH");
  expect(page1).toContain("Public line stays");
  expect(page1).toContain("Account");
  expect(page1).not.toContain("number");
  expect(page1).toContain("4417 1234 5678 9113");
  // (pdf.js adds a space where it sees a gap: not a glyph.)
  for (const c of charCentres(after[0]).filter((c) => c.ch.trim() !== "")) expect(inside(NUMBER, c.x, c.y, 3), `"${c.ch}" at ${c.x}`).toBe(false);
  // Pages 2 untouched (the shared form too); page 3 empty; page 4 a picture without text.
  expect(joined(after[1])).toBe(joined(before[1]));
  expect(joined(after[2])).toBe("");
  expect(after[3]).toEqual([]);
  // pdftotext-equivalent over the whole file.
  const all = after.map(joined).join("\n");
  expect(all).not.toContain("SMITH");
  expect(all).toContain("JOHN");

  // Pixels: the marked half of the JPEG is black, the other half still blue (one sample on
  // each side of the split at x 152); the boxes are black; page 4 shows its picture with the
  // area painted, and only the area.
  const p1 = render(out, 1);
  expect(near(p1(100, 560), [0, 0, 0])).toBe(true);
  expect(near(p1(148, 560), [0, 0, 0])).toBe(true);
  expect(near(p1(156, 560), [30, 30, 220])).toBe(true);
  expect(near(p1(200, 560), [30, 30, 220])).toBe(true);
  expect(near(p1(140, 722), [0, 0, 0])).toBe(true);
  expect(near(p1(400, 300), [255, 255, 255])).toBe(true);
  const original4 = render(original, 4);
  const p4 = render(out, 4);
  // (140, 625) was white (right of the squares) and is inside the area: painted.
  expect(near(original4(140, 625), [255, 255, 255])).toBe(true);
  expect(near(p4(140, 625), [0, 0, 0])).toBe(true);
  // Just outside the area (x 150): still white.
  expect(near(p4(155, 625), [255, 255, 255])).toBe(true);
  // "Type3 page" (Helvetica, at 72, 720) was rendered into the picture: some dark pixels.
  let dark = 0;
  for (let x = 72; x < 140; x++) if (p4(x, 723)[0] < 128) dark++;
  expect(dark).toBeGreaterThan(5);

  expect(foreign).toEqual([]);
});
