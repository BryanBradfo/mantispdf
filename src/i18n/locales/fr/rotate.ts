import type { Messages } from "../../types";
import type en from "../en/rotate";

const rotate: Messages<typeof en> = {
  seoTitle: "Faire pivoter les pages d’un PDF | MantisPDF",
  seoDescription: "Faites pivoter certaines pages ou un PDF entier en ligne. Traitement local, rien n’est envoyé.",
  heading: "Faire pivoter",
  intro: "Choisissez un PDF et faites pivoter certaines pages ou le document entier. Tout se passe dans votre navigateur.",
  allCcw: "↺ Tout à gauche",
  allCcwLabel: "Faire pivoter toutes les pages de 90° à gauche",
  allCw: "↻ Tout à droite",
  allCwLabel: "Faire pivoter toutes les pages de 90° à droite",
  resetAll: "Tout réinitialiser",
  ccw: "Faire pivoter à gauche",
  ccwPage: "Faire pivoter la page {n} de 90° à gauche",
  cw: "Faire pivoter à droite",
  cwPage: "Faire pivoter la page {n} de 90° à droite",
};

export default rotate;
