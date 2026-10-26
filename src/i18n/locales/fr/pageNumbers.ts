import type { Messages } from "../../types";
import type en from "../en/pageNumbers";

const pageNumbers: Messages<typeof en> = {
  seoTitle: "Ajouter des numéros de page à un PDF | MantisPDF",
  seoDescription: "Numérotez les pages d’un PDF en choisissant la position, le format et la police. Gratuit, privé, sans envoi.",
  heading: "Numéros de page",
  intro: "Numérotez les pages d’un PDF, dans le coin de votre choix. Tout reste sur votre appareil.",
  format: "Format",
  custom: "Personnalisé…",
  customText: "Texte personnalisé (utilisez {n}, {total}, {date}, {filename})",
  rangeLabel: "Pages à numéroter",
  needFormat: "Saisissez un format pour le numéro de page.",
  numbering: "Numérotation…",
  submit: "Numéroter et télécharger",
};

export default pageNumbers;
