import type { Messages } from "../../types";
import type en from "../en/watermark";

const watermark: Messages<typeof en> = {
  seoTitle: "Ajouter un filigrane à un PDF | MantisPDF",
  seoDescription: "Ajoutez un filigrane en diagonale sur chaque page de votre PDF. Traitement local, rien n’est envoyé.",
  heading: "Filigrane",
  intro: "Apposez un texte sur chaque page\u00a0: CONFIDENTIEL, BROUILLON ou toute autre mention. Tout se passe dans votre navigateur.",
  defaultText: "CONFIDENTIEL",
  fallbackText: "FILIGRANE",
  text: "Texte du filigrane",
  opacity: "Opacité",
  fontSize: "Taille de police",
  angle: "Angle",
  percent: "{value}\u00a0%",
  points: "{value}\u00a0pt",
  degrees: "{value}°",
  color: "Couleur",
  gray: "Gris",
  black: "Noir",
  red: "Rouge",
  blue: "Bleu",
  apply: "Ajouter le filigrane",
  cancel: "Annuler",
  adding: "Ajout du filigrane…",
  previewFirst: "Aperçu\u00a0: page 1",
  previewOf: "Aperçu\u00a0: page 1 sur {total}",
  rendering: "Rendu…",
  done: "Filigrane ajouté.",
  download: "Télécharger le PDF avec filigrane",
  another: "Ajouter un filigrane à un autre fichier",
};

export default watermark;
