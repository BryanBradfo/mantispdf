import type { Messages } from "../../types";
import type en from "../en/resize";

const resize: Messages<typeof en> = {
  seoTitle: "Redimensionner les pages d’un PDF | MantisPDF",
  seoDescription: "Passez les pages d’un PDF en A4, au format Lettre US ou à une taille personnalisée, en adaptant le contenu. Gratuit, privé, sans envoi.",
  heading: "Redimensionner",
  intro: "Changez le format des pages d’un PDF et adaptez le contenu à la nouvelle taille. Tout reste sur votre appareil.",
  orientationAuto: "Auto (selon chaque page)",
  mode: "Mode",
  fitOption: "Ajuster (agrandir ou réduire)",
  extendOption: "Étendre (sans jamais agrandir)",
  fitWord: "Ajuster",
  extendWord: "Étendre",
  summary: "{paper} · {orientation} · {mode} · marge de {margin}\u00a0mm · {pages}",
  preview: "Aperçu",
  previewPage: "Aperçu (page {page})",
  previewLabel: "Une page placée sur la feuille cible",
  rangeLabel: "Pages à redimensionner",
  resizing: "Redimensionnement…",
  submit: "Redimensionner et télécharger",
};

export default resize;
