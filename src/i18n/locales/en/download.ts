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
  // The web app card, above the desktop installers
  installEyebrow: "Web app",
  installHeading: "Install in your browser",
  installIntro: "No download, no warning, works offline.",
  installButton: "Install app",
  installIos: "On iPhone or iPad: tap Share, then Add to Home Screen.",
  installSafari: "In Safari, choose File, then Add to Dock.",
  installFirefox: "Firefox cannot install web apps: the desktop app below is the option here.",
  installOther: "Look for Install MantisPDF in your browser's address bar or menu.",
  installDone: "Installed. Open MantisPDF from your apps.",
} as const satisfies Namespace;
