import type { Messages } from "../../types";
import type en from "../en/split";

const split: Messages<typeof en> = {
  seoTitle: "Diviser un PDF en ligne | MantisPDF",
  seoDescription: "Divisez un PDF en plusieurs fichiers en un instant, aux pages exactes de votre choix. Tout se passe dans votre navigateur, sans envoi.",
  heading: "Diviser PDF",
  intro: "Choisissez un PDF, cliquez sur les ciseaux entre les pages pour marquer les points de découpe, puis lancez la division.",
  selectPoints: "Choisissez les points de découpe ci-dessous",
  splitInto: "Diviser en {parts} parties",
  removePoint: "Retirer ce point de découpe",
  splitAfter: "Couper après cette page",
  removeRow: "Retirer toutes les découpes de cette ligne",
  splitRow: "Couper après chaque page de cette ligne",
};

export default split;
