import type { Messages } from "../../types";
import type en from "../en/bates";

const bates: Messages<typeof en> = {
  seoTitle: "Numérotation Bates de PDF | MantisPDF",
  seoDescription: "Ajoutez une numérotation Bates sur un ou plusieurs PDF, qui se poursuit d’un fichier à l’autre. Gratuit, privé, sans envoi.",
  heading: "Numérotation Bates",
  intro: "Apposez un identifiant continu sur chaque page, d’un document à l’autre. Tout reste sur votre appareil.",
  files: {
    one: "{count}\u00a0fichier. Glissez les cartes pour fixer l’ordre de numérotation.",
    other: "{count}\u00a0fichiers. Glissez les cartes pour fixer l’ordre de numérotation.",
  },
  prefix: "Préfixe",
  suffix: "Suffixe",
  startNumber: "Numéro de départ",
  digits: "Chiffres",
  needFile: "Ajoutez au moins un PDF.",
  startRange: "Le numéro de départ doit être un nombre entier, 0 ou plus.",
  tooLarge: "Le numéro de départ plus le nombre total de pages est trop grand.",
  digitsRange: "Le nombre de chiffres doit être compris entre 1 et 12.",
  range: "de {first} à {last}",
  numbering: "Numérotation…",
  submitZip: "Ajouter la numérotation Bates et télécharger le ZIP",
  submit: "Ajouter la numérotation Bates et télécharger",
};

export default bates;
