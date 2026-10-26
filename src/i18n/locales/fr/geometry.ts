import type { Messages } from "../../types";
import type en from "../en/geometry";

const geometry: Messages<typeof en> = {
  sheetSize: "Format de la feuille",
  sameAsFirst: "Comme la première page",
  fitToImage: "Adapté à l’image",
  paperOption: "{name} ({width} × {height}\u00a0mm)",
  custom: "Personnalisé…",
  width: "Largeur (mm)",
  height: "Hauteur (mm)",
  orientation: "Orientation",
  portrait: "Portrait",
  landscape: "Paysage",
  margin: "Marge (mm)",
  fixSettings: "Corrigez les réglages pour voir un aperçu.",
  wordAuto: "auto",
  wordPortrait: "portrait",
  wordLandscape: "paysage",
  customSize: "Le format personnalisé doit mesurer entre 13 et 5080\u00a0mm de chaque côté.",
  marginRange: "La marge doit être comprise entre 0 et 200\u00a0mm.",
  noRoom: "La marge ne laisse aucune place sur la feuille. Réduisez-la.",
  selectAtLeastOne: "Sélectionnez au moins une page.",
  firstPageSize: "La première page est trop petite ou trop grande pour servir de format de feuille (de 1 à 200\u00a0pouces). Choisissez un format de papier.",
  gapRange: "L’espacement doit être compris entre 0 et 200\u00a0mm.",
  noRoomPages: "La marge et l’espacement ne laissent aucune place pour les pages.",
  mmSize: "{width} × {height}\u00a0mm",
};

export default geometry;
