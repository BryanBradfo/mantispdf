import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Guard: the web bundle never carries the updater. The Tauri plugins are imported statically only by
 * `lib/desktopUpdate.ts`, which only `DesktopUpdateBanner` imports statically; everything else (App,
 * the update settings) reaches them through a dynamic `import()`, i.e. a separate chunk loaded in
 * Tauri only. The e2e suite checks the built web app never fetches that chunk.
 */
const SRC = resolve(__dirname, "..");
const GUARDED: Record<string, string[]> = {
  "@tauri-apps/plugin-updater": ["lib/desktopUpdate.ts"],
  "@tauri-apps/plugin-process": ["lib/desktopUpdate.ts"],
  "lib/desktopUpdate": ["components/desktop/DesktopUpdateBanner.tsx"],
  "components/desktop/DesktopUpdateBanner": [],
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.|\.spec\./.test(name) ? [path] : [];
  });
}

/** Static import / re-export specifiers of a file, resolved relative to src when they are relative. */
function staticImports(path: string): string[] {
  const code = readFileSync(path, "utf8");
  const found = [...code.matchAll(/^\s*(?:import|export)\s(?:[^"';]*?\sfrom\s)?\s*["']([^"']+)["']/gm)].map((m) => m[1]);
  return found.map((spec) =>
    spec.startsWith(".") ? relative(SRC, resolve(dirname(path), spec)).replace(/\.(ts|tsx)$/, "") : spec,
  );
}

describe("updater import boundary", () => {
  const files = sources(SRC);

  it.each(Object.entries(GUARDED))("%s is imported statically only by its allowed modules", (target, allowed) => {
    const importers = files
      .filter((f) => staticImports(f).includes(target))
      .map((f) => relative(SRC, f))
      .sort();
    expect(importers).toEqual([...allowed].sort());
  });

  it("App mounts the banner through a dynamic import", () => {
    const app = readFileSync(join(SRC, "App.tsx"), "utf8");
    expect(app).toMatch(/lazy\(\(\) => import\("\.\/components\/desktop\/DesktopUpdateBanner"\)\)/);
  });
});
