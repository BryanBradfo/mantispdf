import type { Messages } from "../../types";
import type en from "../en/organize";

const organize: Messages<typeof en> = {
  seoTitle: "Organiser les pages d’un PDF | MantisPDF",
  seoDescription: "Réordonnez, faites pivoter, dupliquez, supprimez et insérez des pages blanches, même entre plusieurs PDF. Gratuit, privé, sans envoi.",
  heading: "Organiser",
  intro: "Déposez un ou plusieurs PDF, puis glissez les pages à leur place, faites-les pivoter, dupliquez-les, supprimez-les ou ajoutez des pages blanches.",
  pagesInResult: { one: "{count}\u00a0page dans le résultat", other: "{count}\u00a0pages dans le résultat" },
  files: { one: "{count}\u00a0fichier", other: "{count}\u00a0fichiers" },
  addBlank: "Ajouter une page blanche",
  downloadPdf: "Télécharger le PDF",
  needOnePage: "Ajoutez au moins une page d’un document pour télécharger.",
};

export default organize;
