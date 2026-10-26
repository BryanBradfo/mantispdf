import type { Messages } from "../../types";
import type en from "../en/crop";

const crop: Messages<typeof en> = {
  seoTitle: "Rogner les pages d’un PDF | MantisPDF",
  seoDescription: "Rognez les pages d’un PDF dans votre navigateur\u00a0: tracez la zone ou détectez les marges automatiquement. Gratuit, privé, sans envoi.",
  heading: "Rogner",
  intro: "Réduisez les marges de vos pages, à la main ou automatiquement. Tout reste sur votre appareil.",
  scopeThis: "Cette page ({page})",
  scopeAll: "Toutes les pages",
  scopeRange: "Plage de pages",
  autoTooMany: "La détection automatique traite au plus {max}\u00a0pages à la fois. Utilisez plutôt une même zone pour toutes les pages.",
  autoTooManyShort: "La détection automatique traite au plus {max}\u00a0pages à la fois.",
  detectedAll: {
    one: "Marges détectées sur {count}\u00a0page. Chaque page a sa propre zone.",
    other: "Marges détectées sur {count}\u00a0pages. Chaque page a sa propre zone.",
  },
  detectedOne: "Marges détectées sur la page {page}.",
  targetPage: "page {page}",
  targetAll: "toutes les pages",
  summaryPerPage: "Zone détectée sur chacune des {count}\u00a0pages",
  summaryBox: "{width} × {height}\u00a0pt · {target}",
  permanentTag: "définitif",
  autoThis: "Détecter les marges de cette page",
  autoAll: "Détecter les marges de toutes les pages",
  detecting: "Détection des marges",
  detectingProgress: "Détection des marges\u00a0: page {done} sur {total}",
  perPageNote: "Chaque page est rognée selon sa propre zone détectée. Choisissez une page ci-dessus pour ajuster sa zone.",
  useOneBox: "Utiliser plutôt une même zone pour toutes les pages",
  applyTo: "Appliquer à",
  rangeLabel: "Pages à rogner",
  makePermanent: "Rendre définitif (réduit aussi la page elle-même, pour les lecteurs qui ignorent le rognage)",
  hiddenNote: "Le contenu hors de la zone est masqué, pas supprimé. Utilisez <link>Assainir</link> pour retirer le contenu masqué.",
  cropping: "Rognage…",
  submit: "Rogner et télécharger",
  noVisibleArea: "Cette page n’a aucune zone visible à rogner.",
  cropArea: "Zone de rognage",
  boxRole: "zone de rognage redimensionnable",
  boxHelp:
    "Glissez la zone pour la déplacer, et une poignée pour la redimensionner. Les flèches la déplacent de 1\u00a0pt (Maj+flèches\u00a0: 10\u00a0pt)\u00a0; Ctrl+flèches (Cmd sur Mac) la redimensionnent depuis le coin inférieur droit de 1\u00a0pt, Ctrl+Maj+flèches de 10\u00a0pt.",
  describeCrop: "Zone de rognage de {width} sur {height}\u00a0pt, à {x}\u00a0pt du bord gauche et {top}\u00a0pt du haut.",
  missed: {
    one: "La zone de rognage ne couvre pas la page {list}. Utilisez une plage de pages ou la détection automatique.",
    other: "La zone de rognage ne couvre pas les pages {list}. Utilisez une plage de pages ou la détection automatique.",
  },
  missedMore: { one: "{list} et {count}\u00a0autre", other: "{list} et {count}\u00a0autres" },
};

export default crop;
