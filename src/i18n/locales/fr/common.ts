import type { Messages } from "../../types";
import type en from "../en/common";

const common: Messages<typeof en> = {
  errorGeneric: "Une erreur s’est produite pendant le traitement du PDF.",
  errorDetails: "Détails",
  errorWrongPassword: "Mot de passe incorrect",
  errorLocked: "Ce PDF est protégé par un mot de passe. Déverrouillez-le d’abord.",
  errorLockedNth: "Le PDF {n} est protégé par un mot de passe. Déverrouillez-le d’abord.",
};

export default common;
