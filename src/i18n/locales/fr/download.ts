import type { Messages } from "../../types";
import type en from "../en/download";

const download: Messages<typeof en> = {
  seoTitle: "Télécharger MantisPDF pour macOS, Windows et Linux | MantisPDF by Bradfo",
  seoDescription:
    "Installez l’application de bureau gratuite MantisPDF sur macOS, Windows ou Linux : les mêmes {count} outils PDF, hors ligne, et vos fichiers ne quittent jamais votre ordinateur.",
  eyebrow: "Application de bureau",
  heading: "MantisPDF sur votre ordinateur",
  intro: "Fonctionne hors ligne, avec les mêmes {count} outils, et vos fichiers ne quittent jamais votre machine.",
  osTabs: "Système d’exploitation",
  macArm: "Apple Silicon (.dmg)",
  macIntel: "Intel (.dmg)",
  winExe: "Installateur (.exe)",
  winMsi: "Paquet MSI (.msi)",
  appImage: "AppImage",
  deb: "Debian, Ubuntu (.deb)",
  rpm: "Fedora, openSUSE (.rpm)",
  otherFormats: "Autres formats",
  noteMac:
    "L’application n’est pas encore signée par Apple. Au premier lancement, faites un clic droit sur MantisPDF dans Applications, choisissez Ouvrir, puis Ouvrir à nouveau.",
  noteWindows:
    "L’installateur n’est pas encore signé. Si SmartScreen vous avertit, cliquez sur Informations complémentaires, puis Exécuter quand même.",
  noteLinux: "Ou installez depuis un terminal :",
  terminal: "Commande du terminal",
  copy: "Copier la commande",
  copied: "Copié",
  version: "Version {version}",
  allReleases: "Toutes les versions",
};

export default download;
