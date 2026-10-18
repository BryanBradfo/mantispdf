import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const PDFJS_NODE = fileURLToPath(new URL("../node_modules/pdfjs-dist/legacy/build/pdf.mjs", import.meta.url));
const PDFJS_BROWSER = fileURLToPath(new URL("../node_modules/pdfjs-dist/build/pdf.mjs", import.meta.url));

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

// The A4 preview is 900 px tall: give the page room for the preview and the field list.
test.use({ viewport: { width: 1600, height: 1500 } });

/**
 * form.pdf (scripts/make-form-fixtures.py), A4 (595.28 x 841.89 pt). Field rectangles in user
 * space (origin bottom-left): full_name [150 755 400 777] on page 1, comments [150 755 450 777]
 * on page 2.
 */
const PAGE_HEIGHT = 841.89;

/**
 * Collects requests that leave the app origin from every page and worker of the context
 * (blob: and data: stay local).
 */
function watchOrigin(page: Page, origin: string): string[] {
  const foreign: string[] = [];
  page.context().on("request", (r) => {
    const u = r.url();
    if (u.startsWith("blob:") || u.startsWith("data:")) return;
    // Compare origins, not prefixes: "http://localhost:5181.evil" starts with the app origin.
    if (new URL(u).origin !== origin) foreign.push(u);
  });
  return foreign;
}

/** Opens `file` in the Fill PDF form page; `opened` is what shows once it is read. */
async function openForm(page: Page, file: string, opened: string) {
  await page.goto("/fill-form");
  // The drop zone says when the engine can take a file: one pick, no retries.
  const input = page.locator('input[type="file"][data-engine-ready="true"]');
  await input.waitFor({ state: "attached", timeout: 20000 });
  await input.setInputFiles(file);
  await expect(page.getByText(opened)).toBeVisible({ timeout: 20000 });
}

async function download(page: Page): Promise<{ bytes: Uint8Array; name: string }> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download PDF" }).click()]);
  return { bytes: new Uint8Array(await readFile(await dl.path())), name: dl.suggestedFilename() };
}

type FieldObjects = Record<string, { value: unknown; type?: string; exportValues?: unknown }[]>;

/** pdf.js's view of the form: field name -> widgets (null when there is no form). */
async function fieldObjects(bytes: Uint8Array): Promise<FieldObjects | null> {
  const { getDocument } = (await import(PDFJS_NODE)) as Pdfjs;
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const fields = (await doc.getFieldObjects()) as FieldObjects | null;
  await doc.destroy();
  return fields;
}

interface Annotation {
  subtype?: string;
  fieldName?: string;
  fieldValue?: unknown;
  buttonValue?: unknown;
  radioButton?: boolean;
}

async function annotations(bytes: Uint8Array, n: number): Promise<Annotation[]> {
  const { getDocument } = (await import(PDFJS_NODE)) as Pdfjs;
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const annots = (await (await doc.getPage(n)).getAnnotations()) as Annotation[];
  await doc.destroy();
  return annots;
}

/** Every value of each field widget on page `n` (getFieldObjects keeps only the first of a list box). */
async function widgetValues(bytes: Uint8Array, n: number): Promise<Record<string, unknown>> {
  const annots = await annotations(bytes, n);
  return Object.fromEntries(annots.filter((a) => a.fieldName).map((a) => [a.fieldName, a.fieldValue]));
}

/** Whether `bytes` contain `text` (latin1). */
const contains = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text, "latin1"));

async function pageText(bytes: Uint8Array, n: number): Promise<string> {
  const { getDocument } = (await import(PDFJS_NODE)) as Pdfjs;
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const content = await (await doc.getPage(n)).getTextContent();
  await doc.destroy();
  return content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
}

/**
 * Renders page `n` in the browser (white background, 2 px per pt, form appearances drawn) and
 * returns the darkest luminance (0 black .. 255 white) inside each user-space rectangle.
 */
async function darkest(page: Page, bytes: Uint8Array, n: number, rects: [number, number, number, number][]): Promise<number[]> {
  const origin = new URL(page.url()).origin;
  const renderer = await page.context().newPage();
  await renderer.route("**/__pdfjs/pdf.mjs", async (route) =>
    route.fulfill({ contentType: "text/javascript", body: await readFile(PDFJS_BROWSER) }),
  );
  await renderer.goto(`${origin}/robots.txt`);
  try {
    return await renderer.evaluate(
      async ({ data, n, rects, height }) => {
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
        const out = rects.map(([x0, y0, x1, y1]) => {
          // Inside the rectangle, clear of its 1 pt border.
          const left = Math.round((x0 + 3) * 2);
          const top = Math.round((height - y1 + 3) * 2);
          const w = Math.round((x1 - x0 - 6) * 2);
          const h = Math.round((y1 - y0 - 6) * 2);
          const px = ctx.getImageData(left, top, w, h).data;
          let min = 255;
          for (let i = 0; i < px.length; i += 4) min = Math.min(min, (px[i] + px[i + 1] + px[i + 2]) / 3);
          return min;
        });
        await doc.destroy();
        return out;
      },
      { data: Array.from(bytes), n, rects, height: PAGE_HEIGHT },
    );
  } finally {
    await renderer.close();
  }
}

const FULL_NAME: [number, number, number, number] = [150, 755, 400, 777];
const COMMENTS: [number, number, number, number] = [150, 755, 450, 777];

test("fill form: every kind on the page and in the list, editable download", async ({ page, baseURL }) => {
  const foreign = watchOrigin(page, new URL(baseURL ?? "").origin);
  await openForm(page, fx("form.pdf"), "form.pdf (11 fields, 2 pages)");
  const canvas = page.getByTestId("form-canvas");
  const list = page.getByRole("list", { name: "Form fields" });

  // On the page.
  await canvas.getByLabel("Full name").fill("Ada Lovelace");
  await canvas.getByLabel("Notes").fill("Line one\nLine two");
  await canvas.getByLabel("PIN").fill("123456");
  await canvas.getByLabel("I agree").check();
  await canvas.getByLabel("Colour: green").check();
  await canvas.getByLabel("Country").selectOption("Spain");
  await canvas.getByLabel("Vertical").fill("Up");
  // The read-only field shows its value and cannot be edited, here or in the list.
  await expect(canvas.getByRole("note", { name: "Reference (read-only): MP-2026" })).toBeVisible();
  await expect(list.getByRole("textbox", { name: "Reference" })).toBeDisabled();

  // In the side list: the list box, and the page 2 field.
  await list.getByRole("listbox", { name: "Fruits" }).selectOption(["Apple", "Cherry"]);
  await list.getByRole("textbox", { name: "Comments" }).fill("Page two");
  await list.getByLabel("Password").fill("hunter2-secret");
  // Both places show the same values.
  await expect(list.getByRole("textbox", { name: "Full name" })).toHaveValue("Ada Lovelace");
  await list.getByRole("listitem").filter({ hasText: "Comments" }).getByRole("button", { name: "Show page 2" }).click();
  await expect(canvas.getByLabel("Comments")).toHaveValue("Page two");

  const { bytes, name } = await download(page);
  expect(name).toBe("form_filled.pdf");

  const fields = await fieldObjects(bytes);
  expect(fields).not.toBeNull();
  const value = (n: string) => fields?.[n]?.[0]?.value;
  expect(value("full_name")).toBe("Ada Lovelace");
  expect(value("notes")).toBe("Line one\nLine two");
  expect(value("pin")).toBe("123456");
  expect(value("agree")).toBe("Yes");
  expect(fields?.color?.map((w) => w.value)).toContain("green");
  expect(value("country")).toBe("Spain");
  expect(value("fruits")).toBe("Apple");
  expect((await widgetValues(bytes, 1)).fruits).toEqual(["Apple", "Cherry"]);
  expect(value("ref_code")).toBe("MP-2026");
  expect(value("vertical")).toBe("Up");
  expect(value("comments")).toBe("Page two");
  // A password is never stored.
  expect(value("secret") ?? "").toBe("");
  expect(contains(bytes, "hunter2")).toBe(false);

  // Radio: pdf.js sees the group value on the green widget only, and the file turns that one on.
  const radios = (await annotations(bytes, 1)).filter((a) => a.fieldName === "color");
  expect(radios.map((a) => a.buttonValue)).toEqual(["red", "green", "blue"]);
  expect(radios.every((a) => a.fieldValue === "green")).toBe(true);
  const states = Buffer.from(bytes).toString("latin1").match(/\/AS\s*\/(red|green|blue|Off)\b/g) ?? [];
  expect(states.filter((x) => /green/.test(x))).toHaveLength(1);
  expect(states.some((x) => /red|blue/.test(x))).toBe(false);

  // The typed text is drawn: dark pixels where the empty fixture field was white.
  const original = new Uint8Array(await readFile(fx("form.pdf")));
  const [before] = await darkest(page, original, 1, [FULL_NAME]);
  const [after] = await darkest(page, bytes, 1, [FULL_NAME]);
  expect(before, "empty field is blank").toBeGreaterThan(200);
  expect(after, "typed text is drawn").toBeLessThan(80);
  const [onPage2] = await darkest(page, bytes, 2, [COMMENTS]);
  expect(onPage2).toBeLessThan(80);

  await page.waitForLoadState("networkidle");
  expect(foreign).toEqual([]);
});

test("fill form: flattened download has no fields and keeps the text", async ({ page }) => {
  await openForm(page, fx("form.pdf"), "form.pdf (11 fields, 2 pages)");
  const canvas = page.getByTestId("form-canvas");
  await canvas.getByLabel("Full name").fill("Flat Ada");
  // Both required fields filled: no "download anyway" question.
  await canvas.getByLabel("I agree").check();
  await canvas.getByLabel("Colour: blue").check();
  await page.getByLabel(/^Flatten/).check();
  const { bytes, name } = await download(page);
  expect(name).toBe("form_flattened.pdf");

  const fields = await fieldObjects(bytes);
  expect(fields === null || Object.keys(fields).length === 0).toBe(true);
  for (const n of [1, 2]) {
    expect((await annotations(bytes, n)).filter((a) => a.subtype === "Widget"), `page ${n}`).toEqual([]);
  }
  const text = await pageText(bytes, 1);
  expect(text).toContain("Flat Ada");
  expect(text).toContain("MP-2026");
  const [drawn] = await darkest(page, bytes, 1, [FULL_NAME]);
  expect(drawn).toBeLessThan(80);
});

test("fill form: pure XFA is refused, hybrid XFA is filled with a note", async ({ page }) => {
  await openForm(page, fx("xfa-pure.pdf"), "This form uses XFA, which is not supported.");
  await expect(page.getByRole("status")).toHaveText("This form uses XFA, which is not supported.");
  await expect(page.getByRole("button", { name: "Download PDF" })).toHaveCount(0);

  await openForm(page, fx("xfa-hybrid.pdf"), "xfa-hybrid.pdf (1 field, 1 page)");
  await expect(page.getByText("This form also carries XFA data, which is removed from the downloaded file.")).toBeVisible();
  await page.getByTestId("form-canvas").getByLabel("name").fill("Hybrid");
  const { bytes } = await download(page);
  const fields = await fieldObjects(bytes);
  expect(fields?.name?.[0]?.value).toBe("Hybrid");
  expect(contains(new Uint8Array(await readFile(fx("xfa-hybrid.pdf"))), "/XFA")).toBe(true);
  expect(contains(bytes, "/XFA")).toBe(false);
});
