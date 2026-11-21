import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

/** Drags `names` (fixture PDFs) over the page like a file manager would: a DataTransfer with files. */
async function dragFiles(page: Page, type: "dragenter" | "dragover" | "drop", names: string[], selector = "body") {
  const files = names.map((name) => ({ name, bytes: [...readFileSync(fx(name))] }));
  await page.evaluate(
    ({ type, files, selector }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: "application/pdf" }));
      document.querySelector(selector)!.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { type, files, selector },
  );
}

const overlay = (page: Page) => page.getByTestId("page-drop-overlay");

test("the empty drop zone is one big control with a real-looking button", async ({ page }) => {
  await page.goto("/merge");
  const zone = page.locator("label").filter({ has: page.locator('input[type="file"]') });
  await expect(zone.getByText("Choose PDF files")).toBeVisible();
  await expect(zone.getByText("or drop them here")).toBeVisible();
  expect((await zone.boundingBox())!.height).toBeGreaterThanOrEqual(320);
  // One control for assistive tech: the file input, named by the button text (the face is a span).
  await expect(page.getByRole("button", { name: /choose pdf files/i })).toHaveCount(1);
  await expect(page.locator('input[type="file"]')).toHaveAccessibleName(/Choose PDF files/);
  await expect(overlay(page)).toBeHidden();
});

test("files dragged anywhere show the overlay; a drop loads them into the tool", async ({ page }) => {
  await page.goto("/merge");
  await expect(overlay(page)).toBeAttached();
  // A text drag is not a file drag: no overlay.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "hello");
    document.body.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(overlay(page)).toBeHidden();

  await dragFiles(page, "dragenter", ["alpha.pdf", "bravo.pdf"]);
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page).getByText("Drop to open")).toBeVisible();

  // Pages reject uploads until the engine is up: drop again until the cards are there.
  await expect(async () => {
    await dragFiles(page, "dragenter", ["alpha.pdf", "bravo.pdf"]);
    await dragFiles(page, "drop", ["alpha.pdf", "bravo.pdf"], '[data-testid="page-drop-overlay"]');
    await expect(page.getByTestId("merge-card")).toHaveCount(2, { timeout: 3000 });
  }).toPass({ timeout: 20000 });
  await expect(overlay(page)).toBeHidden();
});

test("a single-file tool takes the dropped file", async ({ page }) => {
  await page.goto("/compress");
  await expect(page.getByText("Choose a PDF file")).toBeVisible();
  await expect(overlay(page)).toBeAttached();
  await expect(async () => {
    await dragFiles(page, "dragenter", ["alpha.pdf"]);
    await dragFiles(page, "drop", ["alpha.pdf"], '[data-testid="page-drop-overlay"]');
    await expect(page.getByText("Choose a PDF file")).toHaveCount(0, { timeout: 3000 });
  }).toPass({ timeout: 20000 });
});

test("Compare: no full-page overlay, both slots light up, a drop on slot B fills B; elsewhere fills A", async ({ page }) => {
  await page.goto("/compare");
  const slotA = page.getByTestId("compare-slot-a");
  const slotB = page.getByTestId("compare-slot-b");
  await slotA.locator('input[type="file"][data-engine-ready="true"]').waitFor({ state: "attached", timeout: 20000 });

  await dragFiles(page, "dragenter", ["compare-b.pdf"]);
  await expect(overlay(page)).toHaveCount(0);
  await expect(slotA.locator("label")).toHaveAttribute("data-dragging", "true");
  await expect(slotB.locator("label")).toHaveAttribute("data-dragging", "true");

  await dragFiles(page, "drop", ["compare-b.pdf"], '[data-testid="compare-slot-b"] label');
  await expect(slotB.getByText("compare-b.pdf")).toBeVisible({ timeout: 10000 });
  await expect(slotA.locator('input[type="file"]')).toHaveCount(1);
  await expect(slotA.locator("label")).not.toHaveAttribute("data-dragging", "true");

  // Only A is left: the page drop goes to it (through the overlay again).
  await dragFiles(page, "dragenter", ["compare-a.pdf"]);
  await expect(overlay(page)).toBeVisible();
  await dragFiles(page, "drop", ["compare-a.pdf"], '[data-testid="page-drop-overlay"]');
  await expect(slotA.getByText("compare-a.pdf")).toBeVisible({ timeout: 10000 });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const path of ["/merge", "/fr/merge", "/compress", "/fr/compress", "/compare"]) {
    test(`${path}: the drop zone fits without horizontal overflow`, async ({ page }) => {
      await page.goto(path);
      const zone = page.locator("label").filter({ has: page.locator('input[type="file"]') }).first();
      await expect(zone).toBeVisible();
      const box = (await zone.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(220);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    });
  }
});
