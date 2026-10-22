import type { Messages } from "../../types";
import type en from "../en/common";

// Typography: \u00a0 (non-breaking space) before : ; ! ? and inside « », no em-dash.
const common: Messages<typeof en> = {
  errorGeneric: "Une erreur s’est produite pendant le traitement du PDF.",
  errorDetails: "Détails",
  errorWrongPassword: "Mot de passe incorrect",
  errorLocked: "Ce PDF est protégé par un mot de passe. Déverrouillez-le d’abord.",
  errorLockedNth: "Le PDF {n} est protégé par un mot de passe. Déverrouillez-le d’abord.",
  errorUnsupportedChars: "Caractères non pris en charge par les polices PDF standard\u00a0: {chars}",
  errorEngineCrashed: "Le moteur PDF s’est arrêté. Rechargez la page.",
  errorEngineUnreadable: "Le moteur PDF a envoyé une réponse illisible. Rechargez la page.",
  errorNoCanvas: "Le navigateur ne permet pas de dessiner l’image (canevas indisponible).",
  errorNoDecoder: "Ce navigateur ne sait pas décoder cette image.",
  errorDecodeTooLarge: "Image trop grande pour être décodée (limite de 100\u00a0mégapixels).",

  dismiss: "Fermer",
  close: "Fermer",
  reset: "Réinitialiser",
  processing: "Traitement…",
  download: "Télécharger",
  downloadZip: "Télécharger le ZIP",
  newFile: "Nouveau fichier",
  startOver: "Recommencer",
  chooseAnother: "Choisir un autre fichier",
  allTools: "← Tous les outils",
  selectAll: "Tout sélectionner",
  selectNone: "Ne rien sélectionner",
  selection: "Sélection",
  retry: "Réessayer",

  localeLoadFailed: "La version française n’a pas pu être chargée, cette page s’affiche donc en anglais.",
  crashTitle: "Une erreur s’est produite sur cette page.",
  crashReload: "Recharger la page",

  engineFailed: "Le moteur WASM n’a pas pu se charger\u00a0: {error}",
  engineFailedReload: "Le moteur PDF n’a pas pu se charger. Rechargez la page.",
  engineLoading: "Le moteur est encore en cours de chargement, patientez un instant.",
  invalidPdf: "Veuillez choisir un fichier PDF.",
  readFailed: "Impossible de lire ce PDF.",
  readFailedNamed: "Impossible de lire {name}.",
  fileProblem: "{name}\u00a0: {problem}",
  loadingPdf: "Chargement du PDF…",
  previewLoadingText: "Chargement de l’aperçu…",
  fileWithPages: { one: "{name} · {count}\u00a0page", other: "{name} · {count}\u00a0pages" },
  fileWithPagesParen: { one: "{name} ({count}\u00a0page)", other: "{name} ({count}\u00a0pages)" },

  progressStarting: "Démarrage…",
  progressSplitting: "Découpage en {parts} parties…",
  progressExtracting: "Extraction de la partie {part} sur {of}…",
  progressPreparing: "Préparation du téléchargement…",
  progressMerging: "Fusion de {count} documents…",
  progressDone: "Terminé",

  dragItem: "élément",
  dragInstructions:
    "Pour saisir un élément déplaçable, appuyez sur la barre d’espace. Pendant le déplacement, utilisez les flèches pour le déplacer. Appuyez de nouveau sur espace pour le déposer à sa nouvelle position, ou sur Échap pour annuler.",
  dragPickedUp: "Élément saisi\u00a0: {name}, position {position} sur {count}.",
  dragOver: "Au-dessus de la position {position}\u00a0: {name}.",
  dragDropped: "Élément déposé\u00a0: {name}, position {position}.",
  dragDroppedNowhere: "Élément déposé\u00a0: {name}.",
  dragCancelled: "Déplacement annulé\u00a0: {name}, de retour à la position {position}.",

  progressError: "Erreur",
  progressProcessing: "Traitement en cours",
  progressWorking: "Traitement…",

  dropPdf: "Glissez votre PDF ici ou <browse>parcourez vos fichiers</browse>",
  dropPdfs: "Glissez vos PDF ici ou <browse>parcourez vos fichiers</browse>",
  dropImage: "Glissez votre image ici ou <browse>parcourez vos fichiers</browse>",
  dropImages: "Glissez vos images ici ou <browse>parcourez vos fichiers</browse>",
  dropHintPdf: "Fichiers PDF",

  previewLoading: "Chargement de l’aperçu",
  previewUnavailable: "Aperçu indisponible",
  pagesGroup: "Pages",
  pageN: "Page {n}",
  pageNMarked: "Page {n}, {mark}",
  pageEdited: "modifiée",

  headerStar: "Star",
  toggleDarkMode: "Activer ou désactiver le mode sombre",
  language: "Langue",
  languageEnglish: "English",
  languageFrench: "Français",
  bannerFrench: "Version française disponible.",
  bannerFrenchLink: "Afficher en français",
  bannerFrenchDismiss: "Non merci",

  footerPrivacy: "MantisPDF. Tout le traitement a lieu dans votre navigateur. Aucune donnée n’est envoyée.",
  footerGithub: "MantisPDF sur GitHub",

  notFoundTitle: "Page introuvable",
  notFoundBody: "Cette page n’existe pas. Revenons aux outils PDF.",
  notFoundBack: "← Retour à tous les outils",

  windowClose: "Fermer la fenêtre",
  windowMinimize: "Réduire la fenêtre",
  windowRestore: "Restaurer la fenêtre",
  windowMaximize: "Agrandir la fenêtre",

  licenseDialog: "Licence MantisPDF Pro",
  licenseActiveTitle: "MantisPDF Pro est activé",
  licenseActiveBody:
    "L’OCR mathématique et l’aperçu LaTeX en direct sont débloqués. Merci de soutenir les logiciels qui fonctionnent en local.",
  licenseDeactivate: "Désactiver sur cet appareil",
  licenseUnlockTitle: "Débloquer MantisPDF Pro",
  licenseUnlockBody:
    "Pro ajoute l’OCR mathématique hors ligne\u00a0: convertissez vos équations en LaTeX impeccable, affiché en direct. Saisissez votre clé de licence pour l’activer.",
  licenseActivating: "Activation…",
  licenseActivate: "Activer la licence",
  licenseGetKey: "Vous n’avez pas de clé\u00a0? Obtenir MantisPDF Pro →",
};

export default common;
