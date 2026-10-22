import type { Messages } from "../../types";
import type en from "../en/ocr";

const ocr: Messages<typeof en> = {
  seoTitle: "OCR PDF\u00a0: rendez les PDF numérisés interrogeables | MantisPDF",
  seoDescription:
    "Reconnaissez le texte des PDF numérisés dans votre navigateur et ajoutez-le comme couche de texte interrogeable et copiable. Gratuit, privé, sans envoi.",
  heading: "OCR",
  intro: "Rendez le texte des PDF numérisés interrogeable et copiable. Le texte est reconnu sur votre appareil, rien n’est envoyé.",
  tooManyPages: "L’OCR traite au plus {max}\u00a0pages à la fois. Divisez d’abord le PDF.",
  readingPage: "Lecture de la page {page}",
  notStarted: "Le moteur OCR n’a pas pu démarrer. Vérifiez votre connexion à ce site et réessayez.",
  discardConfirm: "Abandonner le texte reconnu et recommencer\u00a0?",
  markRecognised: "texte reconnu",
  languages: "Langues du document",
  languageNote: "Les données de langue sont téléchargées depuis ce site la première fois, puis restent dans votre navigateur.",
  skipText: "Ignorer les pages qui contiennent déjà du texte",
  pagesDone: "{done} sur {total}\u00a0pages traitées",
  status: "{status} ({done} sur {total} traitées)",
  progressLabel: "Progression de l’OCR",
  averageConfidence: "Confiance moyenne\u00a0: {percent}.",
  lowQuality:
    "Numérisation de faible qualité, vérifiez le résultat\u00a0: {pages}. Une numérisation de travers se lit mal\u00a0: <link>Faites pivoter les pages</link>, puis relancez l’OCR.",
  noText: "Aucun texte trouvé\u00a0: {pages}.",
  downloadSearchable: "Télécharger le PDF interrogeable",
  downloadText: "Télécharger le texte",
  runAgain: "Relancer",
  run: "Lancer l’OCR",
  redactNote: "Lancez d’abord l’OCR pour caviarder des documents numérisés par recherche. <link>Caviarder</link>",
  pageList: { one: "page {list}", other: "pages {list}" },
  listSep: ", ",
  listLast: " et ",
  etaEstimating: "estimation du temps restant",
  etaAlmostDone: "presque terminé",
  etaSeconds: "environ {s}\u00a0s restantes",
  etaMinutes: "environ {m}\u00a0min {s}\u00a0s restantes",
  wordsPerPage: "La page {page} compte trop de mots reconnus (plus de {max}) pour ajouter une couche de texte. Téléchargez plutôt le texte.",
  wordsTotal: "Trop de mots reconnus au total (plus de {max}) pour ajouter une couche de texte. Divisez le PDF, ou téléchargez plutôt le texte.",
  skipHint: "Désactivez «\u00a0Ignorer les pages qui contiennent déjà du texte\u00a0» pour les reconnaître quand même.",
  allHaveText: "Toutes les pages contiennent déjà du texte. Rien à reconnaître. {hint}",
  headlinePages: { one: "{count}\u00a0page", other: "{count}\u00a0pages" },
  headlineWords: { one: "{count}\u00a0mot", other: "{count}\u00a0mots" },
  headline: "Texte reconnu sur {pages} ({words}).",
  skippedLine: "Ignorées (contenaient déjà du texte)\u00a0: {pages}. {hint}",
  loadingData: "Chargement des données de langue {percent}\u00a0%",
  starting: "Démarrage du moteur OCR…",
  failedLine: "Lecture impossible\u00a0: {pages}.",
  alreadyOcr: {
    one: "La page {list} avait déjà une couche OCR et a été laissée telle quelle.",
    other: "Les pages {list} avaient déjà une couche OCR et ont été laissées telles quelles.",
  },
};

export default ocr;
