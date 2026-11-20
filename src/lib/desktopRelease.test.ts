import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ASSET_KINDS,
  DESKTOP_VERSION,
  RELEASES_URL,
  assetName,
  assetUrl,
  detectOs,
  linuxInstallCommand,
} from "./desktopRelease";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as { version: string };
const BASE = "https://github.com/BryanBradfo/mantispdf/releases/download";

describe("desktop release assets", () => {
  it("takes its version from package.json", () => {
    expect(DESKTOP_VERSION).toBe(pkg.version);
  });

  it("matches the version of the Tauri app (tauri.conf.json and Cargo.toml), so a bump cannot drift", () => {
    const conf = JSON.parse(readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf8")) as { version: string };
    const cargo = readFileSync(resolve(__dirname, "../../src-tauri/Cargo.toml"), "utf8");
    expect(conf.version).toBe(DESKTOP_VERSION);
    expect(/^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1]).toBe(DESKTOP_VERSION);
  });

  it("names the seven installers exactly as tauri-action publishes them for 2.0.0", () => {
    expect(ASSET_KINDS.map((k) => assetName(k, "2.0.0"))).toEqual([
      "MantisPDF_2.0.0_aarch64.dmg",
      "MantisPDF_2.0.0_x64.dmg",
      "MantisPDF_2.0.0_x64-setup.exe",
      "MantisPDF_2.0.0_x64_en-US.msi",
      "MantisPDF_2.0.0_amd64.AppImage",
      "MantisPDF_2.0.0_amd64.deb",
      "MantisPDF-2.0.0-1.x86_64.rpm",
    ]);
  });

  it("points each kind at its file on the tag's GitHub release", () => {
    expect(assetUrl("macArm", "2.0.0")).toBe(`${BASE}/v2.0.0/MantisPDF_2.0.0_aarch64.dmg`);
    expect(assetUrl("rpm", "2.0.0")).toBe(`${BASE}/v2.0.0/MantisPDF-2.0.0-1.x86_64.rpm`);
    expect(assetUrl("winExe")).toBe(`${BASE}/v${DESKTOP_VERSION}/MantisPDF_${DESKTOP_VERSION}_x64-setup.exe`);
    expect(RELEASES_URL).toBe("https://github.com/BryanBradfo/mantispdf/releases");
  });

  it("builds the Linux one-liner from the AppImage URL", () => {
    expect(linuxInstallCommand("2.0.0")).toBe(
      `curl -LO ${BASE}/v2.0.0/MantisPDF_2.0.0_amd64.AppImage && chmod +x MantisPDF_2.0.0_amd64.AppImage && ./MantisPDF_2.0.0_amd64.AppImage`,
    );
  });
});

describe("detectOs", () => {
  it.each([
    ["macOS", "mac"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15", "mac"],
    ["Windows", "windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "windows"],
    ["Linux", "linux"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36", "linux"],
    ["Mozilla/5.0 (X11; FreeBSD amd64)", "linux"],
    ["Darwin", "mac"],
    ["Android", "mac"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36", "mac"],
    ["", "mac"],
    ["Something else", "mac"],
  ] as const)("%j -> %s", (platform, os) => {
    expect(detectOs(platform)).toBe(os);
  });
});
