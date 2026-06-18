import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const ONE_PAGE = fileURLToPath(new URL("./fixtures/one-page.pdf", import.meta.url));

test("home page renders the AI-parser landing and the tool grid", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/MantisPDF/i);
  // New hero headline (the AI doc-prep positioning).
  await expect(
    page.getByRole("heading", { name: /Extract clean Markdown/i }),
  ).toBeVisible();
  // The interactive dropzone is present.
  await expect(page.getByText(/Drop research papers here/i)).toBeVisible();
  // The existing toolkit is still reachable: a core tool card links to /split.
  await expect(page.getByRole("heading", { name: "PDF Tools" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Split PDF/i })).toBeVisible();
});

test("Parse a PDF opens a file picker and renders the chosen file", async ({ page }) => {
  await page.goto("/");
  // The hero button now opens a native file picker (no bundled demo PDF).
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: /Parse a PDF/i }).click(),
  ]);
  await chooser.setFiles(ONE_PAGE);
  // The split-screen workspace appears with the chosen file.
  await expect(page.getByText("Source Document")).toBeVisible({ timeout: 8000 });
  await expect(page.getByText("one-page.pdf")).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("No document to preview")).toHaveCount(0);
  // The code panel defaults to Markdown; switching tabs retargets the export.
  await expect(page.getByRole("button", { name: /Export \.md/i })).toBeVisible();
  await page.getByRole("button", { name: "LaTeX" }).click();
  await expect(page.getByRole("button", { name: /Export \.tex/i })).toBeVisible();
});

test("dropping a PDF renders it in the Workspace source panel", async ({ page }) => {
  await page.goto("/");
  // Set the file on the dropzone's hidden input (the last file input on the
  // page; the first belongs to the hero "Parse a PDF" picker).
  await page.locator('input[type="file"]').last().setInputFiles(ONE_PAGE);
  // The workspace opens with the real filename.
  await expect(page.getByText("Source Document")).toBeVisible({ timeout: 8000 });
  await expect(page.getByText("one-page.pdf")).toBeVisible();
  // react-pdf actually rendered the document: a page canvas is present...
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 10000 });
  // ...and the empty-state is NOT shown when a real file is loaded.
  await expect(page.getByText("No document to preview")).toHaveCount(0);
});

test("split page loads and the WASM engine initializes without error", async ({ page }) => {
  await page.goto("/split");

  // The page heading renders (lazy route + Suspense resolved).
  await expect(page.getByRole("heading", { name: "Split PDF" })).toBeVisible();

  // The drop zone is shown when no file is loaded.
  await expect(page.getByText(/drop|upload|choose/i).first()).toBeVisible();

  // The WASM engine must initialize: the init-error alert must never appear.
  // Give the worker a moment to load and run its init handshake.
  await page.waitForTimeout(1500);
  await expect(page.getByText(/WASM engine failed to load/i)).toHaveCount(0);
});

test("unknown route shows a 404 page, not a blank screen", async ({ page }) => {
  await page.goto("/this-route-does-not-exist");
  await expect(page.getByText("404")).toBeVisible();
  await expect(page.getByRole("link", { name: /back to all tools/i })).toBeVisible();
});
