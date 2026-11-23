import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../i18n/locales/en";
import { renderPage } from "./staticPage";

/**
 * The desktop app (Tauri) loads dist/index.html, which is the prerendered English web home: its static
 * block (download link, web copy) must stay hidden there while the app starts.
 */
const shell = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(shell)![1];
const runInlineScript = () => new Function(inlineScript)();

afterEach(() => {
  document.documentElement.className = "";
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("index.html in the desktop app", () => {
  it("marks <html> as desktop when Tauri is there", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    runInlineScript();
    expect(document.documentElement.classList.contains("is-desktop")).toBe(true);
  });

  it("does not on the web", () => {
    runInlineScript();
    expect(document.documentElement.classList.contains("is-desktop")).toBe(false);
  });

  it("hides the prerendered block under .is-desktop", () => {
    expect(shell).toMatch(/\.is-desktop #root > \[data-prerender-body\] \{ display: none; \}/);
  });

  it("the prerendered block is the one #root child carrying data-prerender-body", () => {
    for (const path of ["/", "/merge", "/download"]) {
      const doc = new DOMParser().parseFromString(renderPage(shell, en, "en", path), "text/html");
      const children = [...doc.getElementById("root")!.children];
      expect(children, path).toHaveLength(1);
      expect(children[0].hasAttribute("data-prerender-body"), path).toBe(true);
    }
  });
});
