import type { Messages } from "../../types";
import type en from "../en/sanitize";

const sanitize: Messages<typeof en> = {
  seoTitle: "Assainir un PDF | MantisPDF",
  seoDescription:
    "Retirez les données cachées d’un PDF\u00a0: métadonnées, scripts, pièces jointes, données de formulaire et contenu caché des pages supprimées. Gratuit, privé, sans envoi.",
  heading: "Assainir",
  intro: "Retirez les données cachées d’un PDF\u00a0: métadonnées, scripts, pièces jointes, données de formulaire et contenu caché des pages supprimées.",
  keepComments: "Garder les commentaires",
  sanitizing: "Assainissement…",
  submit: "Assainir et télécharger",
  fieldsFlattened: "Champs aplatis\u00a0: {count}",
  linksKept: "Liens conservés\u00a0: {count}",
  linksRemoved: "Liens supprimés\u00a0: {count}",
  commentsKept: "Commentaires conservés\u00a0: {count}",
  commentsRemoved: "Commentaires supprimés\u00a0: {count}",
  imagesCleaned: {
    one: "Les métadonnées de {count}\u00a0image ont été supprimées",
    other: "Les métadonnées de {count}\u00a0images ont été supprimées",
  },
  notAnalysed: "Certaines pages n’ont pas pu être entièrement analysées et ont gardé toutes leurs ressources.",
  deepDropped: "Une partie du contenu très imbriqué n’a pas pu être copiée.",
};

export default sanitize;
