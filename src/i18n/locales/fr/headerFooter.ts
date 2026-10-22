import type { Messages } from "../../types";
import type en from "../en/headerFooter";

const headerFooter: Messages<typeof en> = {
  seoTitle: "Ajouter un en-tête et un pied de page à un PDF | MantisPDF",
  seoDescription: "Ajoutez un en-tête et un pied de page à chaque page d’un PDF, avec numéros de page, date et nom du fichier. Gratuit, privé, sans envoi.",
  heading: "En-tête et pied de page",
  intro: "Ajoutez du texte en haut et en bas de vos pages. Tout reste sur votre appareil.",
  tokens:
    "Variables\u00a0: {n} numéro (compté à partir de la première page choisie, en commençant au premier numéro), {total} numéro imprimé sur la dernière page choisie, {date}, {filename}",
  pages: "Pages",
  onPage: "Sur la page {page}\u00a0:",
  slotPreview: "{label}\u00a0: ",
  empty: "(vide)",
  none: "aucun",
  needText: "Remplissez au moins un champ d’en-tête ou de pied de page.",
  summary: { one: "{count} texte ({slots}) · {pages} · {style}", other: "{count} textes ({slots}) · {pages} · {style}" },
  stamping: "Ajout du texte…",
  submit: "Ajouter et télécharger",
};

export default headerFooter;
