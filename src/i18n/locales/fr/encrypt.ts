import type { Messages } from "../../types";
import type en from "../en/encrypt";

const encrypt: Messages<typeof en> = {
  seoTitle: "Chiffrer un PDF | MantisPDF",
  seoDescription: "Protégez votre PDF par un mot de passe pour que seuls les lecteurs autorisés puissent l’ouvrir. Traitement local, rien n’est envoyé.",
  heading: "Chiffrer",
  intro: "Définissez un mot de passe pour limiter qui peut ouvrir votre PDF. Tout se passe dans votre navigateur.",
  password: "Mot de passe",
  passwordPlaceholder: "Saisissez le mot de passe",
  confirm: "Confirmez le mot de passe",
  confirmPlaceholder: "Saisissez-le à nouveau",
  mismatch: "Les mots de passe ne correspondent pas.",
  owner: "Mot de passe propriétaire",
  ownerHint: "(facultatif, limite la modification et l’impression)",
  ownerPlaceholder: "Laissez vide pour utiliser le même mot de passe",
  submit: "Chiffrer le PDF",
  cancel: "Annuler",
  encrypting: "Chiffrement…",
  done: "PDF chiffré.",
  doneHint: "Ouvrez le fichier téléchargé dans n’importe quel lecteur PDF\u00a0: il vous demandera le mot de passe.",
  download: "Télécharger le PDF chiffré",
  another: "Chiffrer un autre fichier",
};

export default encrypt;
