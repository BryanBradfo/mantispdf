// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain Node script without type declarations.
import { buildLatestJson } from "../../scripts/release-latest-json.mjs";

interface Entry {
  signature: string;
  url: string;
}
interface Result {
  manifest?: { version: string; notes: string; pub_date: string; platforms: Record<string, Entry> };
  errors?: string[];
}
const build = buildLatestJson as (opts: {
  tag: string;
  repo: string;
  notes?: string;
  pubDate?: Date;
  assets: string[];
  readSig: (name: string) => string;
}) => Result;

const SCRIPT = fileURLToPath(new URL("../../scripts/release-latest-json.mjs", import.meta.url));
const BASE = "https://github.com/BryanBradfo/mantispdf/releases/download/v2.1.0";

/** What tauri-action uploads for 2.1.0 (installers, updater bundles, their signatures). */
const RELEASE = [
  "MantisPDF_2.1.0_aarch64.dmg",
  "MantisPDF_aarch64.app.tar.gz",
  "MantisPDF_aarch64.app.tar.gz.sig",
  "MantisPDF_2.1.0_x64.dmg",
  "MantisPDF_x64.app.tar.gz",
  "MantisPDF_x64.app.tar.gz.sig",
  "MantisPDF_2.1.0_x64-setup.exe",
  "MantisPDF_2.1.0_x64-setup.exe.sig",
  "MantisPDF_2.1.0_x64_en-US.msi",
  "MantisPDF_2.1.0_x64_en-US.msi.sig",
  "MantisPDF_2.1.0_amd64.AppImage",
  "MantisPDF_2.1.0_amd64.AppImage.sig",
  "MantisPDF_2.1.0_amd64.deb",
  "MantisPDF_2.1.0_amd64.deb.sig",
  "MantisPDF-2.1.0-1.x86_64.rpm",
];
const sig = (name: string) => `SIG(${name})\n`;

describe("release latest.json", () => {
  it("lists every platform key with its asset URL and signature", () => {
    const { manifest, errors } = build({
      tag: "v2.1.0",
      repo: "BryanBradfo/mantispdf",
      notes: "Automatic updates\n",
      pubDate: new Date("2026-11-22T21:00:00.123Z"),
      assets: RELEASE,
      readSig: sig,
    });
    expect(errors).toBeUndefined();
    expect(manifest!.version).toBe("2.1.0");
    expect(manifest!.notes).toBe("Automatic updates");
    expect(manifest!.pub_date).toBe("2026-11-22T21:00:00Z");
    const p = manifest!.platforms;
    // The rpm has no signature on this release: it gets no key.
    expect(Object.keys(p).sort()).toEqual(
      [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-x86_64",
        "linux-x86_64-appimage",
        "linux-x86_64-deb",
        "windows-x86_64",
        "windows-x86_64-msi",
        "windows-x86_64-nsis",
      ].sort(),
    );
    expect(p["darwin-aarch64"]).toEqual({
      url: `${BASE}/MantisPDF_aarch64.app.tar.gz`,
      signature: "SIG(MantisPDF_aarch64.app.tar.gz.sig)",
    });
    expect(p["darwin-x86_64"].url).toBe(`${BASE}/MantisPDF_x64.app.tar.gz`);
    expect(p["windows-x86_64"]).toEqual(p["windows-x86_64-nsis"]);
    expect(p["windows-x86_64"].url).toBe(`${BASE}/MantisPDF_2.1.0_x64-setup.exe`);
    expect(p["windows-x86_64-msi"].url).toBe(`${BASE}/MantisPDF_2.1.0_x64_en-US.msi`);
    expect(p["linux-x86_64"]).toEqual(p["linux-x86_64-appimage"]);
    expect(p["linux-x86_64"].url).toBe(`${BASE}/MantisPDF_2.1.0_amd64.AppImage`);
    expect(p["linux-x86_64-deb"].signature).toBe("SIG(MantisPDF_2.1.0_amd64.deb.sig)");
  });

  it("URL-encodes asset names", () => {
    const assets = RELEASE.map((a) => a.replace("MantisPDF_2.1.0_amd64.AppImage", "Mantis PDF_2.1.0_amd64.AppImage"));
    const { manifest } = build({ tag: "v2.1.0", repo: "BryanBradfo/mantispdf", assets, readSig: sig });
    expect(manifest!.platforms["linux-x86_64"].url).toBe(`${BASE}/Mantis%20PDF_2.1.0_amd64.AppImage`);
    expect(manifest!.notes).toBe("");
  });

  it("fails when a base platform is missing, unsigned, or its signature is empty", () => {
    const noMac = RELEASE.filter((a) => !a.startsWith("MantisPDF_x64.app"));
    expect(build({ tag: "v2.1.0", repo: "r/r", assets: noMac, readSig: sig }).errors).toEqual([
      expect.stringContaining("darwin-x86_64"),
    ]);
    const unsignedWin = RELEASE.filter((a) => a !== "MantisPDF_2.1.0_x64-setup.exe.sig");
    expect(build({ tag: "v2.1.0", repo: "r/r", assets: unsignedWin, readSig: sig }).errors).toEqual([
      expect.stringContaining("windows-x86_64"),
    ]);
    const emptySig = (name: string) => (name.endsWith(".AppImage.sig") ? " \n" : sig(name));
    const result = build({ tag: "v2.1.0", repo: "r/r", assets: RELEASE, readSig: emptySig });
    expect(result.manifest).toBeUndefined();
    expect(result.errors).toEqual([expect.stringContaining("linux-x86_64: MantisPDF_2.1.0_amd64.AppImage.sig is empty")]);
  });

  it("CLI: writes latest.json, or exits 1 and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "latest-json-"));
    try {
      writeFileSync(join(dir, "assets.txt"), RELEASE.join("\n"));
      for (const a of RELEASE.filter((n) => n.endsWith(".sig"))) writeFileSync(join(dir, a), sig(a));
      const out = join(dir, "latest.json");
      const args = ["--tag", "v2.1.0", "--repo", "BryanBradfo/mantispdf", "--assets", join(dir, "assets.txt"), "--sigs", dir];
      execFileSync("node", [SCRIPT, ...args, "--notes", "Hello", "--out", out], { stdio: "pipe" });
      const json = JSON.parse(readFileSync(out, "utf8"));
      expect(json.version).toBe("2.1.0");
      expect(json.notes).toBe("Hello");
      expect(json.platforms["darwin-aarch64"].url).toBe(`${BASE}/MantisPDF_aarch64.app.tar.gz`);

      writeFileSync(join(dir, "assets.txt"), RELEASE.filter((a) => !a.includes("AppImage")).join("\n"));
      const out2 = join(dir, "latest2.json");
      expect(() => execFileSync("node", [SCRIPT, ...args, "--out", out2], { stdio: "pipe" })).toThrow();
      expect(() => readFileSync(out2)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
