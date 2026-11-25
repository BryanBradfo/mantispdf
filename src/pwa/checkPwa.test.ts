import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkPwa, isSelfDestroyingSw, SW_KILL_ENV } from "../../scripts/check-pwa.mjs";
import { webManifest } from "./config";

const ROOT = resolve(__dirname, "../..");

/** The exact worker vite-plugin-pwa writes with `selfDestroying: true` (the kill switch), read from the plugin. */
function pluginKillSwitchWorker(): string {
  const src = readFileSync(join(ROOT, "node_modules/vite-plugin-pwa/dist/index.js"), "utf8");
  const sw = /const selfDestroyingSW = `([\s\S]*?)`;/.exec(src)?.[1];
  if (!sw) throw new Error("vite-plugin-pwa no longer has its self-destroying worker template");
  return sw;
}

/** A minimal dist/ of a kill-switch build: manifest, icons, pages linking it, the self-destroying sw.js. */
let dist: string;
const write = (rel: string, content: string) => {
  mkdirSync(dirname(join(dist, rel)), { recursive: true });
  writeFileSync(join(dist, rel), content);
};

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "mantis-killswitch-"));
  write("manifest.webmanifest", JSON.stringify(webManifest));
  cpSync(join(ROOT, "public/icons"), join(dist, "icons"), { recursive: true });
  const page = '<html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>';
  for (const p of ["index.html", "shell.html", "merge/index.html", "fr/download/index.html"]) write(p, page);
  write("sw.js", pluginKillSwitchWorker());
});

afterAll(() => rmSync(dist, { recursive: true, force: true }));

describe("check-pwa and the kill switch", () => {
  it("shares the build's env flag", () => {
    expect(SW_KILL_ENV).toBe("MANTIS_SW_KILL");
    expect(readFileSync(join(ROOT, "vite.config.ts"), "utf8")).toContain('process.env.MANTIS_SW_KILL === "1"');
  });

  it("recognises the plugin's self-destroying worker, and not a normal one", () => {
    expect(isSelfDestroyingSw(pluginKillSwitchWorker())).toBe(true);
    expect(isSelfDestroyingSw('define(["./workbox-1"],function(s){s.precacheAndRoute([{url:"shell.html",revision:"a"}])});')).toBe(false);
  });

  it("a kill-switch build passes, without the precache checks", () => {
    const { problems, summary } = checkPwa(dist, { kill: true, root: ROOT });
    expect(problems).toEqual([]);
    expect(summary).toContain("KILL SWITCH");
  });

  it("fails when the flag and the worker disagree", () => {
    expect(checkPwa(dist, { kill: false, root: ROOT }).problems).toEqual([
      "sw.js is the self-destroying kill switch, but MANTIS_SW_KILL is not set",
    ]);
    writeFileSync(join(dist, "sw.js"), "self.addEventListener('fetch', () => {});");
    expect(checkPwa(dist, { kill: true, root: ROOT }).problems).toEqual(["MANTIS_SW_KILL=1 but sw.js is not the self-destroying worker"]);
    writeFileSync(join(dist, "sw.js"), pluginKillSwitchWorker());
  });
});
