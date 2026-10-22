import type { Messages } from "../../types";
import type en from "../en/imagesToPdf";

const imagesToPdf: Messages<typeof en> = {
  seoTitle: "Images en PDF\u00a0: JPG, PNG, WebP en PDF | MantisPDF",
  seoDescription: "Transformez des images en PDF, une par page. Réordonnez, faites pivoter, choisissez un format. Gratuit, privé, sans envoi.",
  heading: "Images en PDF",
  intro: "Placez des images JPG, PNG ou WebP sur des pages PDF. Les JPEG sont intégrés sans réencodage. Tout reste sur votre appareil.",
  hint: "JPG, PNG, WebP, GIF, BMP",
  removeImage: "Retirer l’image",
  removeNamed: "Retirer {name}",
  moveEarlier: "Avancer",
  moveEarlierNamed: "Avancer {name}",
  rotateLeft: "Pivoter à gauche",
  rotateLeftNamed: "Faire pivoter {name} vers la gauche",
  rotateRight: "Pivoter à droite",
  rotateRightNamed: "Faire pivoter {name} vers la droite",
  moveLater: "Reculer",
  moveLaterNamed: "Reculer {name}",
  skipped: {
    one: "{count}\u00a0fichier n’est pas une image et a été ignoré.",
    other: "{count}\u00a0fichiers ne sont pas des images et ont été ignorés.",
  },
  onlyFirst: "Seules les {max} premières images ont été gardées.",
  busyAdding: "Un PDF est en cours de création. Ajoutez d’autres images une fois qu’il sera prêt.",
  customSizeHint: "Saisissez un format personnalisé entre 13 et 5080\u00a0mm.",
  fitToImage: "adapté à l’image",
  imageLabel: "Image {n} ({name})",
  reading: "Lecture de l’image {n} sur {total}…",
  couldNotRead: "Impossible de lire {name}\u00a0: {error}",
  buildingPdf: "Création du PDF…",
  count: {
    one: "{count}\u00a0image. Saisissez une carte pour changer l’ordre.",
    other: "{count}\u00a0images. Saisissez une carte pour changer l’ordre.",
  },
  orientationAuto: "Auto (selon chaque image)",
  building: "Création…",
  create: "Créer le PDF",
  clearAll: "Tout retirer",
  tooMany: "Trop d’images\u00a0: la limite est de {max} par PDF.",
  marginRange: "La marge doit être comprise entre 0 et {max}\u00a0mm.",
  marginTooLarge: "La marge est trop grande pour ce format\u00a0: restez sous {max}\u00a0mm.",
  summary: {
    one: "{count} image · {count} page · {paper} · {orientation} · marge de {margin}\u00a0mm",
    other: "{count} images · {count} pages · {paper} · {orientation} · marge de {margin}\u00a0mm",
  },
  tooLarge: "{name} est trop grande ({width} × {height})\u00a0; la limite est de {max}\u00a0mégapixels par image.",
  overBudget:
    "Avec {name}, les images atteignent {total}\u00a0Mo\u00a0; la limite est de {max}\u00a0Mo par PDF (hors JPEG, chaque pixel compte pour 4\u00a0octets). Retirez des images ou créez plusieurs PDF.",
};

export default imagesToPdf;
