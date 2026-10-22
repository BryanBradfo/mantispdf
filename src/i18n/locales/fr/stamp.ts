import type { Messages } from "../../types";
import type en from "../en/stamp";

const stamp: Messages<typeof en> = {
  position: "Position",
  "anchor.top-left": "En haut à gauche",
  "anchor.top-center": "En haut au centre",
  "anchor.top-right": "En haut à droite",
  "anchor.middle-left": "Au milieu à gauche",
  "anchor.center": "Au centre",
  "anchor.middle-right": "Au milieu à droite",
  "anchor.bottom-left": "En bas à gauche",
  "anchor.bottom-center": "En bas au centre",
  "anchor.bottom-right": "En bas à droite",
  "slot.top-left": "En-tête à gauche",
  "slot.top-center": "En-tête au centre",
  "slot.top-right": "En-tête à droite",
  "slot.bottom-left": "Pied de page à gauche",
  "slot.bottom-center": "Pied de page au centre",
  "slot.bottom-right": "Pied de page à droite",
  font: "Police",
  size: "Taille (pt)",
  colour: "Couleur",
  opacity: "Opacité ({percent})",
  styleSummary: "{font} {size}\u00a0pt",
  firstNumber: "Premier numéro",
  marginFromEdge: "Marge depuis le bord (pt)",
  sizeRange: "La taille doit être comprise entre 6 et 72\u00a0pt.",
  marginRange: "La marge doit être comprise entre 0 et 300\u00a0pt.",
  firstNumberRange: "Le premier numéro doit être un nombre entier, 0 ou plus.",
  templatePage: "Page {n}",
  templatePageOf: "Page {n} sur {total}",
};

export default stamp;
