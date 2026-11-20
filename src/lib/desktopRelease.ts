/**
 * The desktop installers published by the Release workflow (tauri-action) on each `v*` tag. Every
 * download link of the site is built here, from ONE version: package.json's, injected by Vite as
 * `__MANTIS_VERSION__`. Bump the version, push the tag, and the links follow.
 */
export const DESKTOP_VERSION: string = __MANTIS_VERSION__;

const REPO = "https://github.com/BryanBradfo/mantispdf";
export const RELEASES_URL = `${REPO}/releases`;

/** The seven installers, in the order the download page lists them. */
export const ASSET_KINDS = ["macArm", "macIntel", "winExe", "winMsi", "appImage", "deb", "rpm"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** File name of an installer, as tauri-action names it. */
export function assetName(kind: AssetKind, version: string = DESKTOP_VERSION): string {
  switch (kind) {
    case "macArm":
      return `MantisPDF_${version}_aarch64.dmg`;
    case "macIntel":
      return `MantisPDF_${version}_x64.dmg`;
    case "winExe":
      return `MantisPDF_${version}_x64-setup.exe`;
    case "winMsi":
      return `MantisPDF_${version}_x64_en-US.msi`;
    case "appImage":
      return `MantisPDF_${version}_amd64.AppImage`;
    case "deb":
      return `MantisPDF_${version}_amd64.deb`;
    case "rpm":
      return `MantisPDF-${version}-1.x86_64.rpm`;
  }
}

/** Direct download URL of an installer on the version's GitHub release. */
export function assetUrl(kind: AssetKind, version: string = DESKTOP_VERSION): string {
  return `${RELEASES_URL}/download/v${version}/${assetName(kind, version)}`;
}

/** The terminal one-liner shown on the Linux tab: fetch the AppImage, make it executable, run it. */
export function linuxInstallCommand(version: string = DESKTOP_VERSION): string {
  const file = assetName("appImage", version);
  return `curl -LO ${assetUrl("appImage", version)} && chmod +x ${file} && ./${file}`;
}

export const DESKTOP_OSES = ["mac", "windows", "linux"] as const;
export type DesktopOs = (typeof DESKTOP_OSES)[number];

/** The OS of a platform or user-agent string; macOS when it cannot tell. Mac is tested first ("Darwin" holds "win"). */
export function detectOs(platform: string): DesktopOs {
  const p = platform.toLowerCase();
  if (/mac|darwin|iphone|ipad/.test(p)) return "mac";
  if (/win/.test(p)) return "windows";
  if (/linux|x11/.test(p)) return "linux";
  return "mac";
}

/** The visitor's OS, from User-Agent Client Hints when the browser has them, else the user-agent string. */
export function visitorOs(): DesktopOs {
  if (typeof navigator === "undefined") return "mac";
  const hints = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return detectOs(hints?.platform || navigator.userAgent || "");
}
