import type { Namespace } from "../../types";

export default {
  seoTitle: "Download MantisPDF for macOS, Windows and Linux | MantisPDF by Bradfo",
  seoDescription:
    "Install the free MantisPDF desktop app on macOS, Windows or Linux: the same {count} PDF tools, offline, and your files never leave your computer.",
  eyebrow: "Desktop app",
  heading: "MantisPDF for your desktop",
  intro: "Works offline, with the same {count} tools, and your files never leave your machine.",
  osTabs: "Operating system",
  macArm: "Apple Silicon (.dmg)",
  macIntel: "Intel (.dmg)",
  winExe: "Installer (.exe)",
  winMsi: "MSI package (.msi)",
  appImage: "AppImage",
  deb: "Debian, Ubuntu (.deb)",
  rpm: "Fedora, openSUSE (.rpm)",
  otherFormats: "Other formats",
  noteMac:
    "The app is not signed by Apple yet. On first launch, right-click MantisPDF in Applications, choose Open, then Open again.",
  noteWindows:
    "The installer is not signed yet. If SmartScreen warns you, click More info, then Run anyway.",
  noteLinux: "Or install from a terminal:",
  noteDeb:
    "On Ubuntu or Debian, the .deb gives a full install with a menu icon: double-click it, or run sudo apt install ./MantisPDF_{version}_amd64.deb.",
  terminal: "Terminal command",
  copy: "Copy command",
  copied: "Copied",
  version: "Version {version}",
  allReleases: "All releases",
} as const satisfies Namespace;
