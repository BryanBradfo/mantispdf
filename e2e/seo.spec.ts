import { test, expect, type Page } from "@playwright/test";

/** What a crawler that runs no JavaScript gets for `path`: the raw HTML. */
async function rawHtml(page: Page, path: string): Promise<string> {
  const res = await page.request.get(path, { headers: { Accept: "text/html" } });
  expect(res.status(), path).toBe(200);
  return res.text();
}

const ldJson = (html: string) =>
  [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

const graphTypes = (docs: { "@graph": { "@type": string }[] }[]) => docs.flatMap((d) => d["@graph"].map((n) => n["@type"]));

test.describe("prerendered HTML, without JavaScript", () => {
  test("/fr/merge has the French title, description, canonical, h1, guide and JSON-LD", async ({ page }) => {
    const html = await rawHtml(page, "/fr/merge");
    expect(html).toContain('<html lang="fr"');
    expect(html).toMatch(/<title data-prerender>Fusionner des PDF \| MantisPDF by Bradfo<\/title>/);
    expect(html).toMatch(/<meta data-prerender name="description" content="[^"]+"/);
    expect(html).toContain('<link data-prerender rel="canonical" href="https://mantispdf.bradfo.me/fr/merge" />');
    expect(html).toMatch(/<div id="root"><main[^>]*>[\s\S]*<h1[^>]*>Fusionner PDF<\/h1>/);
    expect(html).toContain("Comment fusionner des PDF");
    expect(graphTypes(ldJson(html))).toEqual(expect.arrayContaining(["WebApplication", "HowTo", "FAQPage", "BreadcrumbList"]));
  });

  test("the English home has its title, h1 and home structured data", async ({ page }) => {
    const html = await rawHtml(page, "/");
    expect(html).toMatch(/<title data-prerender>[^<]*MantisPDF[^<]*<\/title>/);
    expect(html).toMatch(/<h1[^>]*>PDF Tools<\/h1>/);
    expect(graphTypes(ldJson(html))).toEqual(["WebSite", "Organization", "SoftwareApplication", "FAQPage"]);
  });

  test("/download lists the installers", async ({ page }) => {
    const html = await rawHtml(page, "/download");
    expect(html).toMatch(/<h1[^>]*>MantisPDF for your desktop<\/h1>/);
    expect(graphTypes(ldJson(html))).toContain("SoftwareApplication");
  });

  test("an unknown path gets the bare app shell, not another page's content", async ({ page }) => {
    const html = await rawHtml(page, "/no-such-page");
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toContain("data-prerender>");
  });
});

test.describe("after the app mounts", () => {
  for (const path of ["/fr/merge", "/", "/download"]) {
    test(`${path}: one title, description, canonical, og:title and JSON-LD`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("header")).toBeVisible();
      await expect(page.locator("[data-prerender]")).toHaveCount(0);
      await expect(page.locator("head title")).toHaveCount(1);
      await expect(page.locator('meta[name="description"]')).toHaveCount(1);
      await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
      await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
      await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1);
    });
  }

  test("/fr/merge keeps its French title and canonical", async ({ page }) => {
    await page.goto("/fr/merge");
    await expect(page.getByTestId("tool-guide")).toBeVisible();
    await expect(page).toHaveTitle("Fusionner des PDF | MantisPDF by Bradfo");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://mantispdf.bradfo.me/fr/merge");
  });

  test("the tool guide shows the steps, a keyboard FAQ and related tools", async ({ page }) => {
    await page.goto("/merge");
    const guide = page.getByTestId("tool-guide");
    await expect(guide.getByRole("heading", { level: 2, name: "How to merge PDF files" })).toBeVisible();
    await expect(guide.locator("ol > li")).toHaveCount(3);
    const first = guide.locator("details").first();
    await expect(first).not.toHaveAttribute("open", "");
    await first.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("open", "");
    await expect(first.getByText(/Nothing is sent to a server/)).toBeVisible();
    await page.keyboard.press("Space");
    await expect(first).not.toHaveAttribute("open", "");
    await guide.getByRole("link", { name: "Split PDF" }).click();
    await expect(page).toHaveURL(/\/split$/);
  });

  test("the home FAQ answers five questions", async ({ page }) => {
    await page.goto("/fr");
    const faq = page.getByTestId("home-faq");
    await expect(faq.locator("details")).toHaveCount(5);
    await expect(faq.getByRole("heading", { name: "Mes fichiers sont-ils envoyés sur un serveur ?" })).toBeVisible();
  });

  test("390 px: the tool guide does not overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/header-footer");
    const guide = page.getByTestId("tool-guide");
    await guide.scrollIntoViewIfNeeded();
    for (const d of await guide.locator("details").all()) await d.locator("summary").click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
});
