import { fontCovers, type FontEntry, type FontManifest } from "./manifest";

export type CjkFlavour = "SC" | "TC" | "JP" | "KR";

export interface SelectOptions {
  /** The chosen Noto family, e.g. "Noto Sans", "Noto Serif", "Noto Sans Mono". */
  family: string;
  bold: boolean;
  cjk: CjkFlavour;
}

/** A maximal run of text drawn with one font; `font` is null for characters no font covers. */
export interface FontRun {
  text: string;
  font: FontEntry | null;
}

/** CJK flavour default from a BCP 47 tag: zh-TW/HK/Hant -> TC, ja -> JP, ko -> KR, else SC. */
export function cjkFlavourFromLanguage(language: string | undefined): CjkFlavour {
  const tag = (language ?? "").toLowerCase();
  if (tag.startsWith("ja")) return "JP";
  if (tag.startsWith("ko")) return "KR";
  if (tag.startsWith("zh") && /(^|-)(tw|hk|mo|hant)(-|$)/.test(tag)) return "TC";
  return "SC";
}

/** After the family: Arabic, Hebrew, Devanagari, Thai, then CJK (the chosen flavour first). */
const SCRIPT_CHAIN = ["Noto Sans Arabic", "Noto Sans Hebrew", "Noto Sans Devanagari", "Noto Sans Thai"];
const CJK_ORDER: CjkFlavour[] = ["SC", "TC", "JP", "KR"];

/** Zero-width joiners, directional marks and variation selectors: they take the font of the character before. */
const isInherited = (cp: number): boolean =>
  (cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);

/** Combining marks and Common/Inherited characters (spaces, digits, punctuation) stay with the run before them when its font covers them. */
const isSticky = (ch: string): boolean => /^[\p{M}\p{Script=Common}\p{Script=Inherited}]$/u.test(ch);

function pick(manifest: FontManifest, family: string, bold: boolean): FontEntry | undefined {
  const faces = manifest.fonts.filter((f) => f.family === family);
  return (bold ? faces.find((f) => f.weight === 700) : undefined) ?? faces.find((f) => f.weight === 400);
}

/**
 * Split `text` into runs by the font that covers each character, walking code points: the chosen
 * family first, then the script fonts in chain order. Bold uses the Bold face where one ships
 * (not for CJK). Characters nothing covers get `font: null` so the caller can flag them.
 */
export function selectFonts(manifest: FontManifest, text: string, options: SelectOptions): FontRun[] {
  const cjk = [options.cjk, ...CJK_ORDER.filter((f) => f !== options.cjk)].map((f) => `Noto Sans ${f}`);
  const chain = [options.family, ...SCRIPT_CHAIN, ...cjk]
    .map((family) => pick(manifest, family, options.bold))
    .filter((f): f is FontEntry => f !== undefined);

  const runs: FontRun[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const previous = runs[runs.length - 1];
    const keep = previous?.font && (isInherited(cp) || (isSticky(ch) && fontCovers(previous.font, cp)));
    const font = keep ? previous.font : (chain.find((f) => fontCovers(f, cp)) ?? null);
    if (previous && previous.font === font) previous.text += ch;
    else runs.push({ text: ch, font });
  }
  return runs;
}
