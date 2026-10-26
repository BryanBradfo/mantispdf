/**
 * Unicode text in Edit PDF and Fill form (spec 2026-10-22, section 2): text in any common script is
 * drawn with self-hosted Noto fonts, extracted exactly by pdf.js, placed where the preview shows it,
 * and every request (fonts included) stays on the app's origin.
 */
import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const PDFJS_NODE = fileURLToPath(new URL("../node_modules/pdfjs-dist/legacy/build/pdf.mjs", import.meta.url));
type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

test.use({ viewport: { width: 1600, height: 1500 } });

/**
 * Every request of the context (pages and workers) that leaves the app origin, and the font files
 * fetched from it.
 */
function watchNetwork(page: Page, origin: string): { foreign: string[]; fonts: string[] } {
  const seen = { foreign: [] as string[], fonts: [] as string[] };
  page.context().on("request", (r) => {
    const u = r.url();
    if (u.startsWith("blob:") || u.startsWith("data:")) return;
    const url = new URL(u);
    // Compare origins, not prefixes: "http://localhost:5181.evil" starts with the app origin.
    if (url.origin !== origin) seen.foreign.push(u);
    else if (url.pathname.startsWith("/fonts-runtime/")) seen.fonts.push(url.pathname);
  });
  return seen;
}

async function open(page: Page, route: string, file: string, label: string) {
  await page.goto(route);
  const input = page.locator('input[type="file"][data-engine-ready="true"]');
  await input.waitFor({ state: "attached", timeout: 20000 });
  await input.setInputFiles(fx(file));
  await expect(page.getByText(label)).toBeVisible({ timeout: 20000 });
}

async function download(page: Page): Promise<Uint8Array> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download PDF" }).click()]);
  return new Uint8Array(await readFile(await dl.path()));
}

interface Item {
  str: string;
  /** Display space (origin top-left), points. */
  x: number;
  y: number;
  width: number;
}

/** pdf.js text items of page `n`, in display space. */
async function textItems(bytes: Uint8Array, n = 1): Promise<Item[]> {
  const { getDocument, Util } = (await import(PDFJS_NODE)) as Pdfjs;
  const doc = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const p = await doc.getPage(n);
  const viewport = p.getViewport({ scale: 1 });
  const out: Item[] = [];
  for (const it of (await p.getTextContent()).items) {
    if (!("str" in it) || it.str.trim() === "") continue;
    const m = Util.transform(viewport.transform, it.transform);
    out.push({ str: it.str, x: m[4], y: m[5], width: it.width });
  }
  await doc.destroy();
  return out;
}

const bare = (s: string) => s.replace(/\s+/g, "");

test("unicode text: Edit PDF boxes in seven scripts are real text where the preview shows them", async ({ page, baseURL }) => {
  const net = watchNetwork(page, new URL(baseURL ?? "").origin);
  await open(page, "/edit-pdf", "one-page.pdf", "one-page.pdf (1 page)");
  const overlay = page.getByTestId("editor-overlay");
  const ob = (await overlay.boundingBox())!;
  const [pw, ph] = [612, 792];
  const toPt = (x: number, y: number): [number, number] => [(x / ob.width) * pw, (y / ob.height) * ph];

  const boxes = ["Привет мир", "مرحبا بالعالم", "你好世界", "Ελληνικά", "नमस्ते", "שלום!", "مرحبا\nبالعالم"];
  for (const [i, text] of boxes.entries()) {
    await page.getByRole("button", { name: "Text (T)" }).click();
    await page.mouse.click(ob.x + (80 / pw) * ob.width, ob.y + ((60 + 90 * i) / ph) * ob.height);
    await page.getByRole("textbox", { name: "Text box content" }).fill(text);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
  const groups = overlay.getByTestId("noto-text");
  await expect(groups).toHaveCount(boxes.length, { timeout: 60000 });
  // Every line of the two-line box shows (the box grows to its engine layout).
  await expect(groups.nth(6).locator("text")).toHaveCount(2, { timeout: 30000 });

  // Preview: first baseline and its left edge for each box, in points.
  const preview = await groups.evaluateAll((gs) =>
    gs.map((g) => {
      const texts = Array.from(g.querySelectorAll("text")) as SVGTextElement[];
      // The first line: its baseline and its left edge.
      const baseline = Math.min(...texts.map((t) => Number(t.getAttribute("y"))));
      const first = texts.filter((t) => Math.abs(Number(t.getAttribute("y")) - baseline) < 0.5);
      const left = Math.min(...first.map((t) => t.getBBox().x));
      return [left, baseline];
    }),
  );

  const bytes = await download(page);
  const items = await textItems(bytes);
  const all = items.map((i) => i.str).join("");
  // Every word in reading order. pdf.js reorders each text item on its own: punctuation drawn
  // with the family font is an item of its own ("!" before "שלום"), so it is checked apart.
  for (const text of boxes) {
    for (const word of text.split(/\s+/)) {
      const letters = word.replace(/[!.,]/g, "");
      expect(all, word).toContain(letters);
      if (letters !== word) expect(all, word).toContain(word.replace(letters, ""));
    }
  }

  for (const [i, [px, py]] of preview.entries()) {
    const [x, y] = toPt(px, py);
    const onLine = items.filter((it) => Math.abs(it.y - y) <= 3);
    expect(onLine.length, `box ${i} (${boxes[i]}): text on the previewed baseline`).toBeGreaterThan(0);
    const left = Math.min(...onLine.map((it) => it.x));
    expect(Math.abs(left - x), `box ${i} (${boxes[i]}): left edge ${left} vs preview ${x}`).toBeLessThanOrEqual(3);
  }

  expect(net.foreign).toEqual([]);
  expect(net.fonts).toContain("/fonts-runtime/fonts.json");
  expect(net.fonts.some((f) => /NotoSansSC/.test(f))).toBe(true);
});

test("unicode text: a long Devanagari sentence loses no character in pdf.js", async ({ page }) => {
  await open(page, "/edit-pdf", "one-page.pdf", "one-page.pdf (1 page)");
  const overlay = page.getByTestId("editor-overlay");
  const ob = (await overlay.boundingBox())!;
  const sentence = "यह एक लंबा हिंदी वाक्य है जिसमें संयुक्ताक्षर क्ष त्र ज्ञ और मात्राएँ हैं";
  await page.getByRole("button", { name: "Text (T)" }).click();
  await page.mouse.click(ob.x + ob.width * 0.1, ob.y + ob.height * 0.1);
  await page.getByRole("textbox", { name: "Text box content" }).fill(sentence);
  await page.keyboard.press("Escape");
  await expect(overlay.getByTestId("noto-text")).toHaveCount(1, { timeout: 60000 });
  const items = await textItems(await download(page));
  const text = items.map((i) => i.str).join(" ");
  // Every character comes out, in order; spaces are not compared.
  expect(bare(text)).toBe(bare(sentence));
  // Known limit: pdf.js may add spaces inside long clusters (it splits text items at glyph offsets).
  const exact = text.replace(/\s+/g, " ").trim() === sentence;
  test.info().annotations.push({ type: "pdf.js spacing", description: exact ? "exact" : `extra spaces: ${text}` });
});

test("unicode text: Fill form takes Cyrillic and Chinese values, editable and flattened", async ({ page, baseURL }) => {
  const net = watchNetwork(page, new URL(baseURL ?? "").origin);
  await open(page, "/fill-form", "form.pdf", "form.pdf (11 fields, 2 pages)");
  const canvas = page.getByTestId("form-canvas");
  await canvas.getByLabel("Full name").fill("Иван Петров");
  await canvas.getByLabel("Notes").fill("你好世界\nПривет");
  await canvas.getByLabel("I agree").check();
  await canvas.getByLabel("Colour: green").check();
  await expect(page.getByText("Uses Noto Sans for these characters").first()).toBeVisible({ timeout: 30000 });
  // No red flag: Noto covers every character.
  await expect(page.getByText(/No font can show these characters/)).toHaveCount(0);

  const { getDocument } = (await import(PDFJS_NODE)) as Pdfjs;
  const editable = await download(page);
  const doc = await getDocument({ data: editable.slice(), verbosity: 0 }).promise;
  const fields = (await doc.getFieldObjects()) as Record<string, { value: unknown }[]>;
  const values = Object.values(fields).flatMap((ws) => ws.map((w) => w.value));
  expect(values).toContain("Иван Петров");
  expect(values).toContain("你好世界\nПривет");
  await doc.destroy();

  await page.getByLabel(/Flatten/).check();
  const flat = await download(page);
  const flatDoc = await getDocument({ data: flat.slice(), verbosity: 0 }).promise;
  expect(await flatDoc.getFieldObjects()).toBeNull();
  await flatDoc.destroy();
  const flatText = (await textItems(flat)).map((i) => i.str).join(" ");
  for (const word of ["Иван", "Петров", "你好世界", "Привет"]) expect(flatText).toContain(word);

  expect(net.foreign).toEqual([]);
  expect(net.fonts.some((f) => /NotoSansSC/.test(f))).toBe(true);
});
