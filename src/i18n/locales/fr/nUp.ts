import type { Messages } from "../../types";
import type en from "../en/nUp";

const nUp: Messages<typeof en> = {
  seoTitle: "Pages multiples (N-up)\u00a0: plusieurs pages par feuille | MantisPDF",
  seoDescription: "Placez 2, 4, 6, 8, 9 ou 16 pages de PDF sur chaque feuille. Gratuit, privé, sans envoi.",
  heading: "Pages multiples (N-up)",
  intro: "Placez plusieurs pages sur chaque feuille, pour des polycopiés ou pour économiser du papier. Tout reste sur votre appareil.",
  orientationAuto: "Auto (paysage pour 2 et 8)",
  perSheet: "Pages par feuille",
  order: "Ordre",
  rows: "Par lignes (de gauche à droite, puis vers le bas)",
  columns: "Par colonnes (de haut en bas, puis vers la droite)",
  rowsWord: "par lignes",
  columnsWord: "par colonnes",
  gap: "Espacement (mm)",
  border: "Tracer une bordure autour de chaque page",
  previewFirst: "Aperçu (première feuille)",
  firstSheetLabel: "Première feuille avec {n}\u00a0pages",
  note: "Remarque\u00a0: les commentaires, les liens et les champs de formulaire ne sont pas reportés sur les feuilles. Seul le contenu visible des pages l’est.",
  sameAsFirst: "comme la première page",
  summary: {
    one: "{perSheet} par feuille · {paper} · {orientation} · {order} · marge de {margin}\u00a0mm, espacement de {gap}\u00a0mm · {count}\u00a0feuille",
    other: "{perSheet} par feuille · {paper} · {orientation} · {order} · marge de {margin}\u00a0mm, espacement de {gap}\u00a0mm · {count}\u00a0feuilles",
  },
  blankPages: {
    one: "La page {list} n’a pas pu être lue et a été laissée vide sur les feuilles.",
    other: "Les pages {list} n’ont pas pu être lues et ont été laissées vides sur les feuilles.",
  },
  arranging: "Mise en page…",
  submit: "Mettre en page et télécharger",
};

export default nUp;
