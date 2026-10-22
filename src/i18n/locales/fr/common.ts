import type { Messages } from "../../types";
import type en from "../en/common";

// Typography:   (non-breaking space) before : ; ! ? and inside « », no em-dash.
const common: Messages<typeof en> = {
  errorGeneric: "Une erreur s’est produite pendant le traitement du PDF.",
  errorDetails: "Détails",
  errorWrongPassword: "Mot de passe incorrect",
  errorLocked: "Ce PDF est protégé par un mot de passe. Déverrouillez-le d’abord.",
  errorLockedNth: "Le PDF {n} est protégé par un mot de passe. Déverrouillez-le d’abord.",

  dismiss: "Fermer",
  close: "Fermer",

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

  headerStar: "Étoile",
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
    "Pro ajoute l’OCR mathématique hors ligne : convertissez vos équations en LaTeX impeccable, affiché en direct. Saisissez votre clé de licence pour l’activer.",
  licenseActivating: "Activation…",
  licenseActivate: "Activer la licence",
  licenseGetKey: "Vous n’avez pas de clé ? Obtenir MantisPDF Pro →",
};

export default common;
