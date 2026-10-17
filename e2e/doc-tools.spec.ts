import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

type Doc = { texts: string[]; title: string | undefined };

async function pdfInfo(bytes: Uint8Array, password?: string): Promise<Doc> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: bytes, password }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    texts.push(c.items.map((it) => ("str" in it ? it.str : "")).join("").replace(/\s+/g, " ").trim());
  }
  const meta = await doc.getMetadata();
  const info = meta.info as Record<string, unknown>;
  const title = typeof info.Title === "string" && info.Title !== "" ? info.Title : undefined;
  return { texts, title };
}

async function download(page: Page, name: string | RegExp): Promise<Uint8Array> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name }).click()]);
  return new Uint8Array(await readFile(await dl.path()));
}

/** Retry the upload until the WASM engine is ready and the page reacts. */
async function uploadUntil(page: Page, file: string, ready: () => Promise<void>) {
  await expect(async () => {
    await page.locator('input[type="file"]').setInputFiles(file);
    await ready();
  }).toPass({ timeout: 20000 });
}

const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");

test("remove pages: leak regression on raw bytes", async ({ page }) => {
  await page.goto("/remove-pages");
  await uploadUntil(page, fx("secret-form.pdf"), () =>
    expect(page.getByLabel("Pages to remove")).toBeVisible({ timeout: 3000 }),
  );
  await page.getByLabel("Pages to remove").fill("2");
  await expect(page.getByText("1 of 2 pages in the result")).toBeVisible();
  const bytes = await download(page, "Download");
  const doc = await pdfInfo(bytes);
  expect(doc.texts).toEqual(["KEEPPAGE"]);
  expect(doc.title).toBeUndefined();
  const raw = latin1(bytes);
  for (const s of ["SECRETFIELD", "SECRETAP", "DROPPAGE", "SECRETTITLE"]) {
    expect(raw, s).not.toContain(s);
  }
});

test("sanitize: flattens the form and drops metadata", async ({ page }) => {
  await page.goto("/sanitize");
  await uploadUntil(page, fx("secret-form.pdf"), () =>
    expect(page.getByRole("button", { name: "Sanitize and download" })).toBeVisible({ timeout: 3000 }),
  );
  const bytes = await download(page, "Sanitize and download");
  await expect(page.getByText("Fields flattened: 1")).toBeVisible();
  const doc = await pdfInfo(bytes);
  expect(doc.title).toBeUndefined();
  expect(doc.texts[0]).toContain("KEEPPAGE");
  expect(latin1(bytes)).not.toContain("SECRETTITLE");
});

test("edit metadata: non-ASCII title round-trips", async ({ page }) => {
  await page.goto("/edit-metadata");
  await uploadUntil(page, fx("secret-form.pdf"), () =>
    expect(page.getByLabel("Title")).toBeVisible({ timeout: 3000 }),
  );
  await page.getByLabel("Title").fill("Hello été");
  const doc = await pdfInfo(await download(page, "Save and download"));
  expect(doc.title).toBe("Hello été");
});

test("remove metadata: shows the title, output has none", async ({ page }) => {
  await page.goto("/remove-metadata");
  await uploadUntil(page, fx("secret-form.pdf"), () =>
    expect(page.getByText("SECRETTITLE")).toBeVisible({ timeout: 3000 }),
  );
  const doc = await pdfInfo(await download(page, "Remove metadata and download"));
  expect(doc.title).toBeUndefined();
  expect(doc.texts.length).toBe(2);
});

test("unlock: wrong password errors, right password opens", async ({ page }, testInfo) => {
  // Build the encrypted input with the app's own /encrypt tool.
  await page.goto("/encrypt");
  await uploadUntil(page, fx("one-page.pdf"), () =>
    expect(page.getByPlaceholder("Enter password", { exact: true })).toBeVisible({ timeout: 3000 }),
  );
  await page.getByPlaceholder("Enter password", { exact: true }).fill("u");
  await page.getByPlaceholder("Re-enter password").fill("u");
  await page.getByPlaceholder("Leave blank to use the same password").fill("o");
  await page.getByRole("button", { name: "Encrypt PDF" }).click();
  const enc = await download(page, "Download encrypted PDF");
  const encPath = testInfo.outputPath("encrypted.pdf");
  await (await import("node:fs/promises")).writeFile(encPath, enc);

  await page.goto("/unlock");
  await uploadUntil(page, encPath, () =>
    expect(page.getByRole("button", { name: "Unlock and download" })).toBeVisible({ timeout: 3000 }),
  );
  const pw = page.getByLabel("Password (leave empty if the PDF opens without one)");
  await pw.fill("x");
  await page.getByRole("button", { name: "Unlock and download" }).click();
  await expect(page.getByText("Wrong password")).toBeVisible();
  await pw.fill("u");
  const bytes = await download(page, "Unlock and download");
  const doc = await pdfInfo(bytes); // no password supplied
  expect(doc.texts.length).toBe(1);
});
