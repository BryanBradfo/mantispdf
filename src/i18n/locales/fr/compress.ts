import type { Messages } from "../../types";
import type en from "../en/compress";

const compress: Messages<typeof en> = {
  seoTitle: "Compresser un PDF\u00a0: réduire la taille du fichier | MantisPDF",
  seoDescription: "Réduisez la taille d’un PDF en compressant ses images et ses flux. Sans envoi, aucune donnée ne quitte votre appareil.",
  heading: "Compresser PDF",
  intro: "Réduisez la taille du fichier en rééchantillonnant et réencodant les images, en retirant les métadonnées et en compressant les flux, sans aucun envoi.",
  compressing: "Compression…",
  original: "Original",
  compressed: "Compressé",
  savedLess: "-{percent}",
  savedMore: "+{percent}",
  savedNone: "~0\u00a0%",
  smaller: "plus léger",
  larger: "plus lourd",
  noChange: "aucun changement",
  download: "Télécharger le PDF compressé",
  another: "Compresser un autre fichier",
};

export default compress;
