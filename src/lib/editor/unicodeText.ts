/**
 * Which font a text box is drawn with: a standard PDF font while its text is WinAnsi, otherwise
 * (or when a Noto family is chosen) the matching Noto family with per-character fallback to the
 * script fonts (spec 1.2). The engine lays the Noto text out (`layout_text`); this module picks the
 * font files it gets, in chain order.
 */
import { unsupportedChars } from "./afm";
import type { EditFont, NotoFamily, StdFont } from "./model";
import type { FontEntry, FontManifest } from "../fonts/manifest";
import { fontChain, selectFonts, type CjkFlavour } from "../fonts/select";

export const NOTO_FAMILIES: readonly NotoFamily[] = ["Noto Sans", "Noto Serif", "Noto Sans Mono"];

export function isNoto(font: EditFont): font is NotoFamily {
  return (NOTO_FAMILIES as readonly string[]).includes(font);
}

/** The Noto family standing in for a standard font. */
const NOTO_FOR: Record<StdFont, { family: NotoFamily; bold: boolean }> = {
  Helvetica: { family: "Noto Sans", bold: false },
  "Helvetica-Bold": { family: "Noto Sans", bold: true },
  "Times-Roman": { family: "Noto Serif", bold: false },
  Courier: { family: "Noto Sans Mono", bold: false },
};

/** The standard font with metrics close to `font` (for box fitting and the textarea while typing). */
export function metricFont(font: EditFont): StdFont {
  switch (font) {
    case "Noto Sans":
      return "Helvetica";
    case "Noto Serif":
      return "Times-Roman";
    case "Noto Sans Mono":
      return "Courier";
    default:
      return font;
  }
}

export type ResolvedFont =
  | { kind: "standard"; font: StdFont }
  /** `switched`: a standard font was chosen but the text needs Noto. */
  | { kind: "noto"; family: NotoFamily; bold: boolean; switched: boolean };

export function resolveFont(font: EditFont, text: string): ResolvedFont {
  if (isNoto(font)) return { kind: "noto", family: font, bold: false, switched: false };
  if (unsupportedChars(text) === "") return { kind: "standard", font };
  return { kind: "noto", ...NOTO_FOR[font], switched: true };
}

export interface FontPlan {
  /** Font files in chain order: the family first, then the script fonts the text needs. */
  faces: FontEntry[];
  /** Faces drawn with synthetic bold (bold asked, no Bold file: CJK). */
  fakeBold: FontEntry[];
  /** Characters no font covers, once each. */
  missing: string;
}

/** The fonts a Noto text needs. Whitespace never counts as missing. */
export function planFonts(manifest: FontManifest, text: string, family: NotoFamily, bold: boolean, cjk: CjkFlavour): FontPlan {
  const options = { family, bold, cjk };
  const chain = fontChain(manifest, options);
  const runs = selectFonts(manifest, text, options);
  const used = new Set(runs.map((r) => r.font).filter((f): f is FontEntry => f !== null));
  const faces = chain.filter((f, i) => i === 0 || used.has(f));
  const fakeBold = bold ? faces.filter((f) => f.weight === 400) : [];
  let missing = "";
  for (const run of runs) {
    if (run.font !== null) continue;
    for (const ch of run.text) if (!/\s/u.test(ch) && !missing.includes(ch)) missing += ch;
  }
  return { faces, fakeBold, missing };
}

/** True when the first strong character of `text` (its first letter) is right-to-left (bidi rule P2). */
export function startsRightToLeft(text: string): boolean {
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    return /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u.test(ch);
  }
  return false;
}

/** Message for characters no font covers (they would print as empty boxes). */
export function missingMessage(missing: string): string {
  return `No font can show these characters: ${missing}`;
}
