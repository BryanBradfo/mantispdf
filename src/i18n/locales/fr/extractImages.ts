import type { Messages } from "../../types";
import type en from "../en/extractImages";

const extractImages: Messages<typeof en> = {
  seoTitle: "Extraire les images d’un PDF | MantisPDF",
  seoDescription: "Récupérez les images intégrées à un PDF en fichiers JPEG ou PNG. Gratuit, privé, sans envoi.",
  heading: "Extraire les images",
  intro: "Enregistrez les images contenues dans un PDF en fichiers JPEG ou PNG.",
  selectNamed: "Sélectionner {name}",
  cardPage: "Page {page}",
  cardPageSize: "Page {page} · {width}×{height}",
  preparing: "Préparation de {n} sur {total}…",
  found: { one: "{count}\u00a0image trouvée", other: "{count}\u00a0images trouvées" },
  extracting: "Extraction…",
  extract: "Extraire les images",
  skipSmall: "Ignorer les images de moins de 32\u00a0px de côté",
  noImages: "Aucune image à afficher dans ce PDF.",
  selectedOf: "{chosen} sur {total} sélectionnées",
  skippedSummary: { one: "{count}\u00a0image ignorée\u00a0: {list}", other: "{count}\u00a0images ignorées\u00a0: {list}" },
  skippedItem: "{reason} ({count})",
  keptSummary: { one: "{count}\u00a0image conservée sans transparence", other: "{count}\u00a0images conservées sans transparence" },
  reasonJpeg2000: "JPEG 2000",
  reasonJbig2: "JBIG2",
  reasonCcitt: "fax CCITT",
  reasonColourSpace: "espace colorimétrique non pris en charge",
  reasonCorrupt: "image corrompue",
  reasonTooLarge: "image trop grande",
  reasonBudget: "taille maximale dépassée",
  reasonAlphaDropped: "conservée sans transparence",
  reasonInline: "image intégrée au contenu de la page (non extractible)",
};

export default extractImages;
