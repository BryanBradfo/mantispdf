import type { Messages } from "../../types";
import type en from "../en/compare";

const compare: Messages<typeof en> = {
  seoTitle: "Comparer des PDF : voyez ce qui a changé entre deux PDF | MantisPDF",
  seoDescription:
    "Comparez deux PDF dans votre navigateur et voyez côte à côte chaque mot ajouté, supprimé ou modifié. Gratuit, privé, sans envoi.",
  heading: "Comparer des PDF",
  intro: "Choisissez un PDF original et un PDF modifié pour voir ce qui a changé, mot par mot. Les deux fichiers restent sur votre appareil.",
  original: "Original",
  modified: "Modifié",
  removeOriginal: "Retirer l’original",
  removeModified: "Retirer le fichier modifié",
  swap: "Inverser",
  swapLabel: "Inverser l’original et le modifié",
  tooLarge: "{name} dépasse {max} Mo. Comparer accepte des fichiers jusqu’à {max} Mo.",
  tooManyPages: "{name} compte {count} pages. Comparer traite au plus {max} pages par document.",
  readingFile: "Lecture du texte",
  pageCount: { one: "{count}\u00a0page", other: "{count}\u00a0pages" },
  reading: "Lecture du texte…",
  comparing: "Comparaison…",
  waiting: "Ajoutez le PDF modifié pour comparer.",
  waitingOriginal: "Ajoutez le PDF original pour comparer.",
  summary: { one: "{count} modification", other: "{count} modifications" },
  addedCount: { one: "{count} ajout", other: "{count} ajouts" },
  removedCount: { one: "{count} suppression", other: "{count} suppressions" },
  changedCount: { one: "{count} remplacement", other: "{count} remplacements" },
  summaryLine: "{changes} : {added}, {removed}, {changed}",
  noDifferences: "Aucune différence de texte",
  noDifferencesNote:
    "Les deux documents contiennent les mêmes mots dans le même ordre. La mise en page, les images et la mise en forme ne sont pas comparées dans cette vue.",
  perPage: "Les grands documents sont comparés page par page : un texte déplacé vers une autre page apparaît comme supprimé puis ajouté.",
  noTextBoth:
    "Aucun des deux documents n’a de couche de texte (pages numérisées ?). Passez-les d’abord par <link>OCR</link> pour comparer leurs mots.",
  noTextOriginal:
    "L’original n’a pas de couche de texte (pages numérisées ?). Passez-le d’abord par <link>OCR</link> pour comparer ses mots.",
  noTextModified:
    "Le fichier modifié n’a pas de couche de texte (pages numérisées ?). Passez-le d’abord par <link>OCR</link> pour comparer ses mots.",
  changes: "Modifications",
  listCapped: "Les {shown} premières modifications sur {total} sont listées.",
  page: "Page {page}",
  pages: "Pages {a} / {b}",
  pageShort: "P. {page}",
  pagesShort: "P. {a} / {b}",
  itemRemoved: "{page} : supprimé « {text} »",
  itemAdded: "{page} : ajouté « {text} »",
  itemChanged: "{page} : supprimé « {removed} », ajouté « {added} »",
  kindAdded: "Ajout",
  kindRemoved: "Suppression",
  kindChanged: "Remplacement",
  legendLabel: "Légende",
  originalPages: "Pages de l’original",
  modifiedPages: "Pages du fichier modifié",
  syncNote: "Les deux colonnes défilent ensemble, alignées sur leur texte.",
};

export default compare;
