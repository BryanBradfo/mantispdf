import type { Messages } from "../../types";
import type en from "../en/sign";

const sign: Messages<typeof en> = {
  seoTitle: "Signer un PDF\u00a0: ajoutez votre signature | MantisPDF",
  seoDescription: "Signez un PDF dans votre navigateur\u00a0: dessinez, saisissez ou importez votre signature et placez-la sur la page. Gratuit, privé, sans envoi.",
  heading: "Signer",
  intro: "Dessinez, saisissez ou importez votre signature et placez-la sur la page de votre choix. Tout reste sur votre appareil.",
  stepCreate: "Créez votre signature",
  stepPage: "Choisissez la page",
  stepPlace: "Placez-la",
  signedOn: "Signé le {date}",
  addDate: "Ajouter «\u00a0{text}\u00a0» sous la signature",
  signing: "Signature…",
  submit: "Signer et télécharger",
  visualOnly: "Cet outil ajoute une signature visuelle, pas une signature cryptographique.",
  source: "Source de la signature",
  draw: "Dessiner",
  type: "Saisir",
  upload: "Importer",
  drawArea: "Zone de dessin de la signature",
  clear: "Effacer",
  drawHint: "Signez avec la souris, le doigt ou un stylet.",
  yourName: "Votre nom",
  namePlaceholder: "Marie Dupont",
  style: "Style",
  sample: "Signature",
  imageLabel: "Image de la signature (PNG ou JPG)",
  removeWhite: "Retirer le fond blanc",
  uploaded: "Signature importée",
  notImage: "Choisissez une image PNG ou JPG.",
  nothingLeft: "Il ne reste rien une fois le fond blanc retiré.",
  transparent: "Cette image est entièrement transparente.",
  unreadable: "Impossible de lire cette image.",
  noVisibleArea: "Cette page n’a aucune zone visible où signer.",
  movable: "signature déplaçable",
  positionLabel: "Position de la signature",
  placementHelp:
    "Glissez la signature pour la déplacer, et son coin pour la redimensionner. Les flèches la déplacent de 1\u00a0pt, + et - la redimensionnent (Maj\u00a0: 10\u00a0pt).",
  describe: "Signature de {width} sur {height}\u00a0pt, à {x}\u00a0pt du bord gauche et {top}\u00a0pt du haut.",
};

export default sign;
