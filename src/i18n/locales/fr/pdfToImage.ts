import type { Messages } from "../../types";
import type en from "../en/pdfToImage";

const pdfToImage: Messages<typeof en> = {
  seoTitle: "PDF en images\u00a0: exporter les pages en PNG ou JPEG | MantisPDF",
  seoDescription: "Convertissez chaque page d’un PDF en image PNG ou JPEG. Sans envoi, aucune donnée ne quitte votre appareil.",
  heading: "PDF en images",
  intro: "Exportez chaque page de votre PDF en image PNG ou JPEG. Tout le traitement a lieu dans votre navigateur.",
  selectedFile: "Fichier choisi",
  format: "Format",
  resolution: "Résolution",
  scale: "{scale}× ({dpi}\u00a0dpi)",
  convert: "Convertir en images",
  converting: "Conversion de la page {page} sur {total}…",
  noCanvas: "Impossible d’obtenir un contexte de dessin 2D",
  renderFailed: "Impossible de convertir la page en image (elle dépasse peut-être la taille maximale de canevas du navigateur, essayez une résolution plus basse)",
};

export default pdfToImage;
