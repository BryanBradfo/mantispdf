import type { Messages } from "../../types";
import type en from "../en/merge";

const merge: Messages<typeof en> = {
  seoTitle: "Fusionner des PDF | MantisPDF",
  seoDescription: "Combinez plusieurs PDF en un seul document et réordonnez-les par glisser-déposer. Gratuit, privé, sans envoi.",
  heading: "Fusionner PDF",
  intro: "Ajoutez plusieurs PDF, faites glisser une carte pour changer l’ordre, puis fusionnez-les en un seul document.",
  mergeFiles: { one: "Fusionner {count}\u00a0fichier", other: "Fusionner {count}\u00a0fichiers" },
  files: { one: "{count}\u00a0fichier", other: "{count}\u00a0fichiers" },
  totalPages: { one: "{count}\u00a0page au total", other: "{count}\u00a0pages au total" },
  pages: { one: "{count}\u00a0page", other: "{count}\u00a0pages" },
  firstPageOf: "Première page de {name}",
  removeFile: "Retirer le fichier",
  removeNamed: "Retirer {name}",
  moveLeft: "Déplacer vers la gauche",
  moveRight: "Déplacer vers la droite",
};

export default merge;
