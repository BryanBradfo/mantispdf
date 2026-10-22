import type { Messages } from "../../types";
import type en from "../en/pages";

const pages: Messages<typeof en> = {
  rangePlaceholder: "ex. 1-3, 7, 10-",
  rangeHelp: "Cliquez sur les pages ou saisissez des plages.",
  rangeUnreadable: "Impossible de lire «\u00a0{text}\u00a0»",
  rangeStartsAt1: "Les numéros de page commencent à 1",
  rangeNoSuchPage: {
    one: "La page {page} n’existe pas (le document compte {count}\u00a0page)",
    other: "La page {page} n’existe pas (le document compte {count}\u00a0pages)",
  },
  rangeBackwards: "La plage {start}-{end} est à l’envers",

  pagesAll: { one: "La seule page", other: "Les {count}\u00a0pages" },
  pagesOne: "Page {page} sur {total}",
  pagesSome: "{count}\u00a0pages sur {total}",

  blankPage: "Page blanche",
  captionPage: "Page {page}",
  captionSourcePage: "{name} · {page}",
  rotateLeft: "Faire pivoter à gauche",
  rotateLeftItem: "Faire pivoter {caption} à gauche",
  rotateRight: "Faire pivoter à droite",
  rotateRightItem: "Faire pivoter {caption} à droite",
  duplicate: "Dupliquer",
  duplicateItem: "Dupliquer {caption}",
  insertBlank: "Insérer une page blanche après",
  insertBlankItem: "Insérer une page blanche après {caption}",
  delete: "Supprimer",
  deleteItem: "Supprimer {caption}",
  removeItem: "Retirer {caption}",
  extractItem: "Extraire {caption}",

  everythingLocal: "Tout se passe dans votre navigateur.",
  perPageZip: "Un fichier par page (ZIP)",
  resultOf: {
    one: "{name} · résultat\u00a0: {result} sur {count}\u00a0page",
    other: "{name} · résultat\u00a0: {result} sur {count}\u00a0pages",
  },
  mustRemain: "(il doit rester au moins une page)",
};

export default pages;
